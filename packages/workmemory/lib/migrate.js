/**
 * v1 → v2 自动迁移（v3.1.2.1-final 契约）。
 *
 * 触发时机：插件拿到写锁之后、创建 Store 之前。
 * 这样天然没有并发窗口——此刻没有其他写者，也没有内存里的旧结构。
 *
 * 失败策略：任何一条校验不过就**整体放弃**，不交换文件，工作区转只读，
 * 保证永远不会出现"一半 v1 一半 v2"的混合文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { normalizeItemV1, validateItem, validateTask, validateQueueItem, SCHEMA_VERSION } from './schema.js'

const readJsonl = (p) => {
  const out = []
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
    }
  } catch { /* 文件不存在 */ }
  return out
}

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }

const atomicWrite = (p, text) => {
  const tmp = `${p}.tmp`
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, p)
}

const latestById = (rows) => {
  const m = new Map()
  for (const r of rows) if (r?.id) m.set(r.id, r)
  return [...m.values()]
}

export function needsMigration(dir) {
  const m = readJson(path.join(dir, 'manifest.json'), null)
  if (!m) return fs.existsSync(path.join(dir, 'items.jsonl'))   // 有数据但无 manifest：也迁
  return (m.schemaVersion ?? 1) < SCHEMA_VERSION
}

function normalizeTask(t, now) {
  return {
    ...t,
    schemaVersion: SCHEMA_VERSION,
    revision: t.revision ?? t.rev ?? 1,
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

function normalizeQueue(q, now) {
  const map = { done: 'completed', failed: 'retry_wait', pending: 'pending', processing: 'processing', skipped: 'skipped' }
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: q.createdAt ?? now,
    stats: q.stats ?? {},
    sessions: (q.sessions ?? []).map((s) => {
      const state = map[s.state] ?? 'pending'
      const cursor = s.cursorSeq ?? null
      return {
        schemaVersion: SCHEMA_VERSION,
        sessionId: s.sessionId,
        state,
        readCursorSeq: cursor,
        committedCursorSeq: cursor,
        currentChunkId: null,
        chunksCompleted: s.chunks ?? 0,
        eventsRead: 0,
        retryCount: 0,
        nextRetryAt: state === 'retry_wait' ? now + 60_000 : null,
        lastError: s.note ?? null,
        createdAt: s.createdAt ?? now,
        updatedAt: now,
      }
    }),
  }
}

/**
 * @returns {{ migrated:boolean, stats?:object }}
 */
export function migrateWorkspace(dir, { now = Date.now() } = {}) {
  if (!needsMigration(dir)) return { migrated: false }

  const itemsRaw = latestById(readJsonl(path.join(dir, 'items.jsonl')))
  const entitiesRaw = latestById(readJsonl(path.join(dir, 'entities.jsonl')))
  const queueRaw = readJson(path.join(dir, 'queue', 'backfill.json'), null)

  const tasks = entitiesRaw.filter((e) => e.kind === 'task')
  const taskIds = new Set(tasks.map((t) => t.id))
  const keywordsOf = (t) => [
    ...(t.keywords ?? []),
    ...String(t.title ?? '').split(/[\s，,、。]+/),
  ].filter((w) => w && w.length >= 2).map((w) => w.toLowerCase())

  const items = itemsRaw.map((raw) => {
    const it = normalizeItemV1(raw)
    if (raw.taskId && taskIds.has(raw.taskId)) {
      const hay = String(raw.text ?? '').toLowerCase()
      const t = tasks.find((x) => x.id === raw.taskId)
      const hits = keywordsOf(t).filter((k) => hay.includes(k)).length
      if (hits > 0) {
        it.taskId = raw.taskId
        it.taskAssignment = {
          status: 'resolved', taskId: raw.taskId, confidence: 0.8,
          reason: 'unique-keyword', supportingEvidence: ['keyword'], candidateTaskIds: [raw.taskId],
        }
      }
    }
    if (it.status === 'invalid') it.confirmationStatus = 'rejected'
    return it
  })

  // 全量校验，有一条不过就整体放弃
  for (const it of items) {
    const r = validateItem(it)
    if (!r.ok) {
      const e = new Error(`migrate: item ${it.id} invalid: ${r.errors[0]}`)
      e.details = r.errors
      throw e
    }
  }
  const tasksV2 = tasks.map((t) => normalizeTask(t, now))
  for (const t of tasksV2) {
    const r = validateTask(t)
    if (!r.ok) throw new Error(`migrate: task ${t.id} invalid: ${r.errors[0]}`)
  }
  const queueV2 = queueRaw ? normalizeQueue(queueRaw, now) : null
  if (queueV2) {
    for (const s of queueV2.sessions) {
      const r = validateQueueItem(s)
      if (!r.ok) throw new Error(`migrate: queue ${s.sessionId} invalid: ${r.errors[0]}`)
    }
  }

  // 备份（整目录关键文件）
  const backupDir = path.join(dir, 'backup', `${new Date(now).toISOString().replace(/[:.]/g, '-')}-pre-v2`)
  fs.mkdirSync(backupDir, { recursive: true })
  for (const f of ['items.jsonl', 'entities.jsonl', 'manifest.json', 'workspace.json']) {
    const src = path.join(dir, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, f))
  }
  if (fs.existsSync(path.join(dir, 'queue', 'backfill.json'))) {
    fs.mkdirSync(path.join(backupDir, 'queue'), { recursive: true })
    fs.copyFileSync(path.join(dir, 'queue', 'backfill.json'), path.join(backupDir, 'queue', 'backfill.json'))
  }

  // 交换（先写临时文件再 rename；任何一步失败都不影响旧文件）
  atomicWrite(path.join(dir, 'items.jsonl'), items.map((i) => JSON.stringify(i)).join('\n') + '\n')
  if (entitiesRaw.length) {
    const merged = [...entitiesRaw.filter((e) => e.kind !== 'task'), ...tasksV2]
    // 保持原顺序语义不敏感：entities 是 last-write-wins
    atomicWrite(path.join(dir, 'entities.jsonl'), merged.map((e) => JSON.stringify(e)).join('\n') + '\n')
  }
  if (queueV2) atomicWrite(path.join(dir, 'queue', 'backfill.json'), JSON.stringify(queueV2, null, 2))

  const manifest = readJson(path.join(dir, 'manifest.json'), { schemaVersion: 1, createdAt: now, cursors: {}, stats: {} })
  manifest.schemaVersion = SCHEMA_VERSION
  manifest.migration = {
    id: 'v1_v2', from: 1, to: SCHEMA_VERSION, at: now, status: 'completed',
    backup: path.basename(backupDir),
    stats: { items: items.length, tasks: tasksV2.length, queueSessions: queueV2?.sessions.length ?? 0 },
  }
  atomicWrite(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  return {
    migrated: true,
    stats: { items: items.length, tasks: tasksV2.length, queueSessions: queueV2?.sessions.length ?? 0, backup: path.basename(backupDir) },
  }
}
