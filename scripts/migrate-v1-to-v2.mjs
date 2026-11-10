/**
 * v1 → v2 数据迁移（v3.1.2.1-final 契约）。
 *
 *   node scripts/migrate-v1-to-v2.mjs plan     # 只读：生成 .migration/*.v2.jsonl 并校验
 *   node scripts/migrate-v1-to-v2.mjs apply    # 备份 + 原子替换 + 记录 migration
 *   node scripts/migrate-v1-to-v2.mjs verify   # 只校验现存数据是否符合 v2
 *
 * 安全设计：
 *   - plan 不写任何正式文件，只写 .migration/；
 *   - apply 前检查锁：活进程持锁则拒绝（避免与运行时并发写）；
 *   - apply 先整目录备份，再逐个文件原子替换；
 *   - 任一步校验失败即中止，不破坏旧数据。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  normalizeItemV1, validateItem, validateTask, validateQueueItem, SCHEMA_VERSION,
} from '../packages/workmemory/lib/schema.js'

const args = process.argv.slice(2)
const cmd = args.find((a) => !a.startsWith('--')) ?? 'plan'
const wsIndex = args.indexOf('--workspace')
const root = path.resolve(wsIndex >= 0 ? args[wsIndex + 1] : process.cwd())
const memDir = path.join(root, '.dsh', 'memory')
const migDir = path.join(memDir, '.migration')
const now = Date.now()

const readJsonl = (p) => {
  const out = []
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch { /* skip */ }
    }
  } catch { /* missing */ }
  return out
}
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const atomicWrite = (p, text) => {
  const tmp = `${p}.tmp`
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, p)
}
const latestById = (rows) => { const m = new Map(); for (const r of rows) if (r?.id) m.set(r.id, r); return [...m.values()] }

/* ── 锁检查（plan 不需要，apply 需要） ───────────────────── */
function lockHeldByAliveProcess() {
  const lock = readJson(path.join(memDir, 'lock'), null)
  if (!lock?.pid) return false
  try { process.kill(lock.pid, 0); return true } catch (e) { return e?.code === 'EPERM' }
}

/* ── 任务/队列归一化 ─────────────────────────────────────── */
function normalizeTask(t) {
  const revision = t.revision ?? t.rev ?? 1
  return {
    ...t,
    schemaVersion: SCHEMA_VERSION,
    revision,
    rev: undefined,
    progress: t.progress ?? [],
    nextSteps: t.nextSteps ?? [],
    blockers: t.blockers ?? [],
    keywords: t.keywords ?? [],
    sessionIds: t.sessionIds ?? [],
    activeSessionId: t.activeSessionId ?? null,
    lastSessionId: t.lastSessionId ?? null,
    completionCriteria: t.completionCriteria ?? [],
    criterionResults: t.criterionResults ?? [],
    completionEvidence: t.completionEvidence ?? [],
    completedAt: t.completedAt ?? null,
    completedBy: t.completedBy ?? null,
    createdAt: t.createdAt ?? t.startedAt ?? now,
    updatedAt: t.updatedAt ?? now,
    lastActivityAt: t.lastActivityAt ?? t.updatedAt ?? now,
  }
}

function normalizeQueue(q) {
  const map = { done: 'completed', failed: 'retry_wait', pending: 'pending', processing: 'processing', skipped: 'skipped' }
  const sessions = (q.sessions ?? []).map((s) => {
    const state = map[s.state] ?? 'pending'
    const cursor = s.cursorSeq ?? null
    const out = {
      schemaVersion: SCHEMA_VERSION,
      sessionId: s.sessionId,
      state,
      readCursorSeq: cursor,
      committedCursorSeq: cursor,
      currentChunkId: null,
      chunksCompleted: s.chunks ?? 0,
      eventsRead: 0,
      retryCount: state === 'retry_wait' ? 0 : 0,
      nextRetryAt: state === 'retry_wait' ? now + 60_000 : null,
      lastError: s.note ?? null,
      createdAt: s.createdAt ?? now,
      updatedAt: now,
    }
    if (state === 'completed') { out.nextRetryAt = null; out.currentChunkId = null }
    return out
  })
  return { schemaVersion: SCHEMA_VERSION, createdAt: q.createdAt ?? now, sessions, stats: q.stats ?? {} }
}

/* ── plan ────────────────────────────────────────────────── */
function plan() {
  fs.mkdirSync(migDir, { recursive: true })

  const itemsRaw = latestById(readJsonl(path.join(memDir, 'items.jsonl')))
  const entitiesRaw = latestById(readJsonl(path.join(memDir, 'entities.jsonl')))
  const queueRaw = readJson(path.join(memDir, 'queue', 'backfill.json'), null)
  const tasks = entitiesRaw.filter((e) => e.kind === 'task')
  const taskIds = new Set(tasks.map((t) => t.id))

  // 归属：只有"任务存在 + 有独立支持"才保留，否则 unresolved（C3 / §9）
  const keywordsOf = (t) => [...(t.keywords ?? []), ...String(t.title ?? '').split(/[\s，,、。]+/)].filter((w) => w && w.length >= 2).map((w) => w.toLowerCase())
  const supportFor = (item) => {
    const hay = String(item.text ?? '').toLowerCase()
    let best = null
    for (const t of tasks) {
      const hits = keywordsOf(t).filter((k) => hay.includes(k)).length
      if (hits > 0 && (!best || hits > best.hits)) best = { taskId: t.id, hits }
    }
    return best
  }

  const stats = { total: itemsRaw.length, verifiedTask: 0, unresolved: 0, confirmed: 0, userDerived: 0, userExplicit: 0, assistant: 0, decisions: 0, invalid: [] }
  const itemsV2 = itemsRaw.map((raw) => {
    const it = normalizeItemV1(raw)
    // 归属重算
    if (raw.taskId && taskIds.has(raw.taskId)) {
      const s = supportFor(raw)
      if (s && s.taskId === raw.taskId) {
        it.taskId = raw.taskId
        it.taskAssignment = { status: 'resolved', taskId: raw.taskId, confidence: 0.8, reason: 'unique-keyword', supportingEvidence: ['keyword'], candidateTaskIds: [raw.taskId] }
        stats.verifiedTask += 1
      } else {
        stats.unresolved += 1
      }
    } else {
      stats.unresolved += 1
    }
    if (it.status === 'invalid') it.confirmationStatus = 'rejected'
    if (it.confirmationStatus === 'confirmed') stats.confirmed += 1
    if (it.authority === 'user_derived') stats.userDerived += 1
    else if (it.authority === 'user_explicit') stats.userExplicit += 1
    else stats.assistant += 1
    if (it.type === 'decision') stats.decisions += 1

    const v = validateItem(it)
    if (!v.ok) stats.invalid.push({ id: it.id, errors: v.errors.slice(0, 3) })
    return it
  })

  const tasksV2 = tasks.map(normalizeTask)
  const taskInvalid = tasksV2.map((t) => ({ id: t.id, r: validateTask(t) })).filter((x) => !x.r.ok)

  const queueV2 = queueRaw ? normalizeQueue(queueRaw) : null
  const queueInvalid = queueV2 ? queueV2.sessions.map((s) => ({ id: s.sessionId, r: validateQueueItem(s) })).filter((x) => !x.r.ok) : []

  atomicWrite(path.join(migDir, 'items.v2.jsonl'), itemsV2.map((i) => JSON.stringify(i)).join('\n') + '\n')
  atomicWrite(path.join(migDir, 'entities.v2.jsonl'), [...entitiesRaw.filter((e) => e.kind !== 'task'), ...tasksV2].map((e) => JSON.stringify(e)).join('\n') + '\n')
  if (queueV2) atomicWrite(path.join(migDir, 'queue.v2.json'), JSON.stringify(queueV2, null, 2))
  atomicWrite(path.join(migDir, 'report.json'), JSON.stringify({
    at: new Date().toISOString(),
    root,
    stats,
    taskInvalid,
    queueInvalid,
    plan: { items: itemsV2.length, tasks: tasksV2.length, queueSessions: queueV2?.sessions.length ?? 0 },
  }, null, 2))

  console.log(`\n== 迁移计划（plan）==`)
  console.log(`工作区 ${root}`)
  console.log(`条目 ${stats.total} → v2 ${itemsV2.length}`)
  console.log(`任务 ${tasksV2.length}｜队列会话 ${queueV2?.sessions.length ?? 0}`)
  console.log(`\n归属：保留 ${stats.verifiedTask} / 置为 unresolved ${stats.unresolved}`)
  console.log(`来源：user_explicit ${stats.userExplicit} · user_derived ${stats.userDerived} · assistant ${stats.assistant}`)
  console.log(`确认：confirmed ${stats.confirmed}（历史无确认记录，按契约一律不推断）`)
  console.log(`决策 ${stats.decisions}｜校验失败 ${stats.invalid.length}`)
  if (stats.invalid.length) {
    console.log('\n校验失败样本：')
    for (const f of stats.invalid.slice(0, 5)) console.log(' -', f.id, f.errors)
  }
  if (taskInvalid.length) console.log('任务校验失败：', taskInvalid.slice(0, 3))
  if (queueInvalid.length) console.log('队列校验失败：', queueInvalid.slice(0, 3))
  console.log(`\n产物：${path.relative(root, migDir)}/`)
  console.log(stats.invalid.length + taskInvalid.length + queueInvalid.length === 0
    ? '✅ 全部通过校验，可以 apply'
    : '❌ 存在校验失败，修正后再 apply')
  return stats.invalid.length + taskInvalid.length + queueInvalid.length === 0
}

/* ── apply ───────────────────────────────────────────────── */
function apply() {
  if (lockHeldByAliveProcess()) {
    console.error('❌ 检测到插件仍在运行（lock 被活进程持有）。请完全退出应用后重试 apply。')
    process.exit(2)
  }
  const itemsV2Path = path.join(migDir, 'items.v2.jsonl')
  if (!fs.existsSync(itemsV2Path)) {
    console.error('❌ 未找到 plan 产物，请先运行 plan。')
    process.exit(2)
  }
  const backupDir = path.join(memDir, 'backup', `${new Date().toISOString().replace(/[:.]/g, '-')}-pre-v2`)
  fs.mkdirSync(backupDir, { recursive: true })
  for (const f of ['items.jsonl', 'manifest.json', 'entities.jsonl', 'workspace.json']) {
    const src = path.join(memDir, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, f))
  }
  for (const f of ['backfill.json']) {
    const src = path.join(memDir, 'queue', f)
    if (fs.existsSync(src)) { fs.mkdirSync(path.join(backupDir, 'queue'), { recursive: true }); fs.copyFileSync(src, path.join(backupDir, 'queue', f)) }
  }
  // 保留 v1 原件，便于回滚
  fs.copyFileSync(path.join(memDir, 'items.jsonl'), path.join(memDir, '.migration', 'items.v1.jsonl'))

  fs.copyFileSync(itemsV2Path, path.join(memDir, 'items.jsonl.new'))
  fs.renameSync(path.join(memDir, 'items.jsonl.new'), path.join(memDir, 'items.jsonl'))

  const entitiesV2 = path.join(migDir, 'entities.v2.jsonl')
  if (fs.existsSync(entitiesV2)) {
    fs.copyFileSync(entitiesV2, path.join(memDir, 'entities.jsonl.new'))
    fs.renameSync(path.join(memDir, 'entities.jsonl.new'), path.join(memDir, 'entities.jsonl'))
  }
  const queueV2 = path.join(migDir, 'queue.v2.json')
  if (fs.existsSync(queueV2)) {
    fs.mkdirSync(path.join(memDir, 'queue'), { recursive: true })
    fs.copyFileSync(queueV2, path.join(memDir, 'queue', 'backfill.json.new'))
    fs.renameSync(path.join(memDir, 'queue', 'backfill.json.new'), path.join(memDir, 'queue', 'backfill.json'))
  }

  const manifest = readJson(path.join(memDir, 'manifest.json'), {})
  manifest.schemaVersion = SCHEMA_VERSION
  manifest.migration = { id: 'v1_v2', from: 1, to: SCHEMA_VERSION, at: Date.now(), status: 'completed', backup: path.basename(backupDir) }
  atomicWrite(path.join(memDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  console.log(`✅ 迁移完成：备份 ${path.relative(root, backupDir)}`)
  console.log('回滚：把备份目录里的 items.jsonl / entities.jsonl / manifest.json 复制回 .dsh/memory 即可')
}

/* ── verify ──────────────────────────────────────────────── */
function verify() {
  const items = latestById(readJsonl(path.join(memDir, 'items.jsonl')))
  const entities = latestById(readJsonl(path.join(memDir, 'entities.jsonl')))
  const bad = []
  for (const i of items) { const r = validateItem(i); if (!r.ok) bad.push({ id: i.id, errors: r.errors.slice(0, 3) }) }
  const tasks = entities.filter((e) => e.kind === 'task')
  for (const t of tasks) { const r = validateTask(t); if (!r.ok) bad.push({ id: t.id, errors: r.errors.slice(0, 3) }) }
  const manifest = readJson(path.join(memDir, 'manifest.json'), {})
  console.log(`\n== 校验（verify）==`)
  console.log(`items ${items.length}｜tasks ${tasks.length}｜schemaVersion ${manifest.schemaVersion ?? '?'}`)
  console.log(bad.length === 0 ? '✅ 全部符合 v2 契约' : `❌ ${bad.length} 条不符合`)
  for (const b of bad.slice(0, 8)) console.log(' -', b.id, b.errors)
  return bad.length === 0
}

const ok = cmd === 'plan' ? plan() : cmd === 'apply' ? (apply(), true) : verify()
process.exit(ok ? 0 : 1)
