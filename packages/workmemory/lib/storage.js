/**
 * 存储位置解析（设计文档 §5）。
 *
 * 一个工作区 = 一份记忆 = 一个目录：
 *   location=global（默认） → <dshHome>/storages/workmemory/<workspaceId>/
 *   location=workspace      → <workspace>/.dsh/memory/
 *
 * 钥匙来源：宿主工作区登记表（~/.dsh/storages/workspace.json，只读），
 * 用 cwd 与登记 path 做祖先匹配；匹配不到时退化为 "unreg-<hash>"。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const INDEX_VERSION = 1

export function dshHome(env = process.env) {
  if (env.DSH_HOME) return env.DSH_HOME
  const home = env.USERPROFILE ?? env.HOME
  return path.join(home, '.dsh')
}

export function storageBase(config = {}, home = dshHome()) {
  return path.join(home, 'storages', 'workmemory')
}

export function normalizeRoot(p) {
  let r
  try { r = fs.realpathSync.native(p) } catch { r = path.resolve(p) }
  return r.replace(/[\\/]+$/, '')
}

export function pathHash(root) {
  return crypto.createHash('sha256').update(normalizeRoot(root)).digest('hex').slice(0, 12)
}

/** 读宿主工作区登记表；读不到返回空表（不抛）。 */
export function readHostRegistry(home = dshHome()) {
  const file = path.join(home, 'storages', 'workspace.json')
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    const rows = j?.tables?.workspaces
    if (!rows || typeof rows !== 'object') return []
    return Object.entries(rows)
      .map(([id, v]) => ({ workspaceId: id, root: v?.path, title: v?.title }))
      .filter((w) => typeof w.root === 'string' && w.root.length > 0)
  } catch {
    return []
  }
}

const isAncestor = (parent, child) => {
  const p = normalizeRoot(parent).toLowerCase()
  const c = normalizeRoot(child).toLowerCase()
  return c === p || c.startsWith(`${p}${path.sep}`)
}

/**
 * 由 cwd 解析工作区钥匙。
 * @returns {{ key:string, root:string, workspaceId:string|null, title:string|null, registered:boolean }}
 */
export function resolveWorkspaceKey(cwd, { home = dshHome(), registry } = {}) {
  const root = normalizeRoot(cwd)
  const list = registry ?? readHostRegistry(home)
  let best = null
  for (const w of list) {
    if (!isAncestor(w.root, root)) continue
    const len = normalizeRoot(w.root).length
    if (!best || len > best.len) best = { len, w }
  }
  if (best) {
    return {
      key: best.w.workspaceId,
      root: normalizeRoot(best.w.root),
      workspaceId: best.w.workspaceId,
      title: best.w.title ?? path.basename(best.w.root),
      registered: true,
    }
  }
  return { key: `unreg-${pathHash(root)}`, root, workspaceId: null, title: path.basename(root), registered: false }
}

/** 数据目录（纯函数，不读登记表）。 */
export function dataDirFor({ workspaceRoot, key, location = 'global', home = dshHome(), config = {} }) {
  if (location === 'workspace') return path.join(normalizeRoot(workspaceRoot), '.dsh', 'memory')
  void config
  return path.join(storageBase(config, home), key)
}

/* ── index.json：工作区索引（可观测 / 可清理） ───────────── */

export function readIndex(base) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(base, 'index.json'), 'utf8'))
    if (!j || typeof j !== 'object' || !j.workspaces) return { version: INDEX_VERSION, workspaces: {} }
    return { version: j.version ?? INDEX_VERSION, workspaces: j.workspaces }
  } catch {
    return { version: INDEX_VERSION, workspaces: {} }
  }
}

export function writeIndex(base, index, { atomicWriteJson, ensureDir }) {
  ensureDir(base)
  atomicWriteJson(path.join(base, 'index.json'), index)
}

/** 登记 / 刷新一个工作区条目（同名 root 不同 key 会被视为新登记）。 */
export function upsertIndex(base, entry, deps) {
  const index = readIndex(base)
  const now = Date.now()
  const prev = index.workspaces[entry.key]
  index.workspaces[entry.key] = {
    root: entry.root,
    title: entry.title,
    registered: entry.registered !== false,
    location: entry.location ?? 'global',
    createdAt: prev?.createdAt ?? now,
    lastSeenAt: now,
  }
  writeIndex(base, index, deps)
  return index.workspaces[entry.key]
}

/**
 * 注销后重新登记：新 key 尚无数据时，按「root 完全相同」找回旧 key 的数据目录。
 * 只做目录改名 + 索引改挂，不复制、不删除数据。
 * @returns {{ rebound:boolean, from?:string }}
 */
export function rebindByRoot({ base, key, root, deps, liveKeys }) {
  const index = readIndex(base)
  const target = normalizeRoot(root)
  const old = Object.entries(index.workspaces).find(([k, v]) => k !== key && v?.root && normalizeRoot(v.root) === target)
  if (!old) return { rebound: false }
  const [oldKey, oldEntry] = old
  // 旧 key 若仍是宿主登记中的活工作区，说明两个 key 并存，不能抢数据
  if (liveKeys && liveKeys.has(oldKey)) return { rebound: false }
  const oldDir = path.join(base, oldKey)
  const newDir = path.join(base, key)
  if (!fs.existsSync(oldDir)) return { rebound: false }
  if (fs.existsSync(newDir)) return { rebound: false }
  try {
    fs.renameSync(oldDir, newDir)
  } catch {
    return { rebound: false }
  }
  delete index.workspaces[oldKey]
  index.workspaces[key] = { ...oldEntry, root: target, title: oldEntry.title, lastSeenAt: Date.now() }
  writeIndex(base, index, deps)
  return { rebound: true, from: oldKey }
}
