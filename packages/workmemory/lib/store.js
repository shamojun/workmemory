/**
 * 本地存储层：原子写、单写锁、manifest、会话摘要（digest）。
 * 阶段 A 不落原文：digest 只保存"最后一句用户话 / 最后一段回复"的截断文本。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const SCHEMA_VERSION = 2

export function memoryDir(root, config) {
  return path.join(root, ...config.storage.dir.split('/'))
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function atomicWrite(file, data) {
  const dir = path.dirname(file)
  ensureDir(dir)
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

export function atomicWriteJson(file, value) {
  atomicWrite(file, JSON.stringify(value, null, 2))
}

/* ── 单写锁：租约 + 崩溃抢占 ─────────────────────────────── */

const LOCK_LEASE_MS = 2 * 60 * 1000   // 2 分钟；插件不续租，进程崩溃后最多等这么久

export function acquireLock(dir) {
  ensureDir(dir)
  const file = path.join(dir, 'lock')
  const meta = { pid: process.pid, host: process.env.COMPUTERNAME ?? 'local', startedAt: Date.now(), leaseExpiresAt: Date.now() + LOCK_LEASE_MS }

  const tryCreate = () => {
    const fd = fs.openSync(file, 'wx')
    try {
      fs.writeFileSync(fd, JSON.stringify(meta))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  // fencing（v3.1.1）：每次成功抢锁把 manifest.lockEpoch +1，
  // 写操作前校验代次；过期进程恢复后即使还活着也不能继续写。
  const bumpEpoch = () => {
    try {
      const m = loadManifest(dir)
      m.lockEpoch = (m.lockEpoch ?? 0) + 1
      saveManifest(dir, m)
      return m.lockEpoch
    } catch {
      return undefined
    }
  }

  try {
    tryCreate()
    return { ok: true, readOnly: false, token: bumpEpoch(), release: () => safeUnlink(file) }
  } catch (e) {
    if (e.code !== 'EEXIST') return { ok: false, readOnly: true, release() {} }
  }

  const existing = readJson(file, null)
  const leaseExpired = !existing || typeof existing.leaseExpiresAt !== 'number' || existing.leaseExpiresAt < Date.now()
  const sameHost = existing?.host === meta.host
  // 关键：同机上"持有者进程已死"应立即视为可抢占，不能干等租约到期。
  // 否则每次重启都会只读 2 分钟，回填/蒸馏全部跳过（实机踩坑）。
  const pidDead = sameHost ? !isAlive(existing.pid) : false

  if (leaseExpired || pidDead) {
    try {
      fs.unlinkSync(file)
      tryCreate()
      return { ok: true, readOnly: false, token: bumpEpoch(), release: () => safeUnlink(file) }
    } catch {
      return { ok: false, readOnly: true, release() {} }
    }
  }
  return { ok: false, readOnly: true, holder: existing, release() {} }
}

function isAlive(pid) {
  if (typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = 进程存在但不是我们的；仍然算活着
    return e?.code === 'EPERM'
  }
}

function safeUnlink(file) {
  try { fs.unlinkSync(file) } catch { /* noop */ }
}

/* ── manifest ─────────────────────────────────────────────── */

export function loadManifest(dir) {
  const file = path.join(dir, 'manifest.json')
  const m = readJson(file, null)
  // 注意：**不要**因为 schemaVersion 不等于当前版本就重置。
  // v1→v2 迁移由 lib/migrate.js 负责；这里若重置会丢掉游标并写回旧版本，
  // 等于把迁移成果抹掉（实机踩坑）。
  if (!m || typeof m !== 'object') {
    return { schemaVersion: SCHEMA_VERSION, createdAt: Date.now(), cursors: {}, stats: {}, lastBackfillAt: null }
  }
  m.cursors ??= {}
  m.stats ??= {}
  m.schemaVersion ??= SCHEMA_VERSION
  return m
}

export function saveManifest(dir, manifest) {
  atomicWriteJson(path.join(dir, 'manifest.json'), manifest)
}

/** 读-改-写：多个写入方（回填、诊断、巡检）不会互相覆盖字段。 */
export function updateManifest(dir, mutate) {
  const m = loadManifest(dir)
  mutate(m)
  saveManifest(dir, m)
  return m
}

/* ── 会话摘要 ─────────────────────────────────────────────── */

export function digestPath(dir, sessionId) {
  return path.join(dir, 'digest', `${sessionId}.json`)
}

export function readDigest(dir, sessionId) {
  return readJson(digestPath(dir, sessionId), null)
}

export function writeDigest(dir, digest) {
  atomicWriteJson(digestPath(dir, digest.sessionId), digest)
}

export function listDigests(dir) {
  const d = path.join(dir, 'digest')
  let names = []
  try { names = fs.readdirSync(d).filter((n) => n.endsWith('.json')) } catch { return [] }
  return names
    // 摘要里存的是 sessionId，而调用方（简报按 task.sessionIds 过滤）读的是 id。
    // 之前缺这一步，导致"上次停在…"在绑定任务下永远匹配不上。
    .map((n) => {
      const obj = readJson(path.join(d, n), null)
      if (!obj) return null
      return obj.id ? obj : { ...obj, id: obj.sessionId ?? n.replace(/\.json$/, '') }
    })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
}

/* ── 工作区身份 ───────────────────────────────────────────── */

export function readIdentity(dir) {
  return readJson(path.join(dir, 'workspace.json'), null)
}

export function writeIdentity(dir, identity) {
  atomicWriteJson(path.join(dir, 'workspace.json'), identity)
  return identity
}

export function hashIdentity(root) {
  return `ws_${crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 12)}`
}
