/**
 * 实体层（v3.1）：project / goal / task / constraint。
 *
 * 与 items 的分工：
 *   - items  是"事实"，只增不改，用于佐证；
 *   - entities 是"有生命周期的对象"，每个 id 一行最新版（覆盖写）。
 *
 * Task 是这里的一等公民：它有状态机、进度、下一步，能跨会话存活。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { coerceTaskV2, validateTask } from './schema.js'

export const ENTITY_KINDS = ['project', 'goal', 'task', 'constraint']
// v3.1.1：新增 todo（已识别未开始）；abandoned ≡ dropped，不重命名存量数据
export const TASK_STATUSES = ['todo', 'active', 'paused', 'blocked', 'done', 'abandoned']

const FILE = 'entities.jsonl'
const SNAPSHOT = 'task.json'

function newTaskId(now = Date.now()) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `task_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`
}

function uniq(list, max = 12) {
  return [...new Set((list ?? []).filter((x) => typeof x === 'string' && x.trim()))].slice(0, max)
}

export class EntitiesStore {
  constructor({ dir, logger }) {
    this.dir = dir
    this.logger = logger
    this.file = path.join(dir, FILE)
    this.byId = new Map()
    this.load()
  }

  load() {
    this.byId.clear()
    let raw = ''
    try { raw = fs.readFileSync(this.file, 'utf8') } catch { return }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line)
        if (e?.id) this.byId.set(e.id, e)
      } catch { /* 跳过坏行 */ }
    }
  }

  put(entity) {
    // S1b：task 先归一化到 v2 再校验；校验不过拒绝写入
    let out = entity
    if (entity?.kind === 'task') {
      out = coerceTaskV2(entity)
      const check = validateTask(out)
      if (!check.ok) {
        this.logger?.warn?.(`task write rejected: ${check.errors.slice(0, 2).join('; ')}`)
        return undefined
      }
    }
    fs.mkdirSync(this.dir, { recursive: true })
    fs.appendFileSync(this.file, `${JSON.stringify(out)}\n`)
    this.byId.set(out.id, out)
    return out
  }

  get(id) {
    return this.byId.get(id)
  }

  list({ kind, status } = {}) {
    let out = [...this.byId.values()]
    if (kind) out = out.filter((e) => e.kind === kind)
    if (status) out = out.filter((e) => e.status === status)
    return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  createTask({ title, objective, projectId, goalId, keywords, sessionId, evidence, status }, now = Date.now()) {
    const task = {
      kind: 'task',
      id: newTaskId(now),
      projectId: projectId ?? null,
      goalId: goalId ?? null,
      title: String(title ?? '').slice(0, 80) || '未命名任务',
      objective: String(objective ?? '').slice(0, 200),
      status: TASK_STATUSES.includes(status) ? status : 'active',
      progress: [],
      nextSteps: [],
      blockers: [],
      decisions: [],
      keywords: uniq(keywords),
      sessionIds: sessionId ? [sessionId] : [],
      // v3.1.1：会话定位与活动时间，恢复任务时不必再猜"哪个会话在干它"
      activeSessionId: sessionId ?? null,
      lastSessionId: sessionId ?? null,
      lastActivityAt: now,
      evidence: evidence ? [evidence] : [],
      startedAt: now,
      updatedAt: now,
      closedAt: null,
      revision: 1,
    }
    return this.put(task)
  }

  updateTask(id, patch, now = Date.now()) {
    const cur = this.byId.get(id)
    if (!cur) return undefined
    const next = { ...cur, ...patch, updatedAt: now, lastActivityAt: now, revision: (cur.revision ?? cur.rev ?? 1) + 1 }
    if (patch.status === 'active' || patch.status === 'todo') {
      next.closedAt = null
      // 重开：清掉完成标记（历史由 entities 追加版本保留）
      if (cur.status === 'done') {
        next.completedAt = null
        next.completedBy = null
        next.reopenedAt = now
      }
    }
    if (patch.status === 'done' || patch.status === 'abandoned') {
      next.closedAt = now
      // v3.1.2.1：done 必须有完成证据；此处是用户命令触发的迁移，记 user
      if (patch.status === 'done') {
        next.completedAt = next.completedAt ?? now
        next.completedBy = next.completedBy ?? 'user'
        const ev = next.completionEvidence ?? []
        if (ev.length === 0) {
          next.completionEvidence = [{
            id: `cev_${now.toString(36)}`, type: 'user_confirmation', status: 'verified',
            taskId: id, verifiedAt: now,
          }]
        }
      }
    }
    return this.put(next)
  }

  /** 追加进度/下一步/阻塞，自动去重。 */
  appendToTask(id, field, value, evidence, now = Date.now()) {
    const cur = this.byId.get(id)
    if (!cur || !['progress', 'nextSteps', 'blockers'].includes(field)) return undefined
    const text = String(value ?? '').trim()
    if (text.length < 2) return cur
    const list = Array.isArray(cur[field]) ? cur[field] : []
    if (list.includes(text)) return cur
    const next = { ...cur, [field]: uniq([...list, text], 30), updatedAt: now, lastActivityAt: now, revision: (cur.revision ?? cur.rev ?? 1) + 1 }
    if (evidence) next.evidence = [...(cur.evidence ?? []), evidence].slice(-20)
    return this.put(next)
  }

  /**
   * 状态衰减（S4a）：长期无活动的 active 任务自动转 paused。
   * 不解的"僵尸任务"会一直进简报、并吸走新事实的归属。
   * 注意：这里**不刷新** lastActivityAt——它是"最后一次真实活动"，不能被衰减动作改写。
   */
  decayTasks({ now = Date.now(), idleDays = 14 } = {}) {
    let n = 0
    for (const t of [...this.byId.values()]) {
      if (t.kind !== 'task' || t.status !== 'active') continue
      const last = t.lastActivityAt ?? t.updatedAt ?? 0
      if (!last) continue
      if (now - last < idleDays * 864e5) continue
      const next = {
        ...t,
        status: 'paused',
        statusReason: `inactive_${idleDays}d`,
        updatedAt: now,
        revision: (t.revision ?? t.rev ?? 1) + 1,
      }
      if (this.put(next)) n += 1
    }
    return n
  }

  /** 绑定会话到任务（跨会话连续性的落点）。 */
  bindSession(id, sessionId, now = Date.now()) {
    const cur = this.byId.get(id)
    if (!cur || !sessionId) return cur
    const nextSessionIds = uniq([...(cur.sessionIds ?? []), sessionId], 50)
    const lastSessionId = (cur.sessionIds ?? []).includes(sessionId)
      ? cur.lastSessionId ?? sessionId
      : (cur.sessionIds ?? [])[(cur.sessionIds ?? []).length - 1] ?? sessionId
    return this.updateTask(id, {
      sessionIds: nextSessionIds,
      activeSessionId: sessionId,
      lastSessionId,
    }, now)
  }

  /**
   * 快照（v3.1.1）：每任务一份 `snapshots/<taskId>.json`，内容不变则不写盘。
   * 返回 true 表示真的写了，false 表示内容未变被跳过。
   */
  snapshot(task) {
    if (!task) return false
    const payload = {
      snapshotVersion: 1,
      id: task.id,
      title: task.title,
      status: task.status,
      objective: task.objective,
      progress: task.progress ?? [],
      nextSteps: task.nextSteps ?? [],
      blockers: task.blockers ?? [],
      // 聚焦"下一步做什么"，简报只用这一条
      nextAction: (task.nextSteps ?? [])[0] ?? '',
      activeSessionId: task.activeSessionId ?? null,
      lastSessionId: task.lastSessionId ?? null,
      lastActivityAt: task.lastActivityAt ?? task.updatedAt ?? Date.now(),
      sessionIds: task.sessionIds ?? [],
      updatedAt: task.updatedAt ?? Date.now(),
    }
    const hash = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
    const dir = path.join(this.dir, 'snapshots')
    const file = path.join(dir, `${task.id}.json`)
    try {
      fs.mkdirSync(dir, { recursive: true })
      try {
        const prev = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (prev?.hash === hash) {
          this.writePointer(payload, hash)
          return false
        }
      } catch { /* 首次或无文件 */ }
      this.atomicJson(file, { hash, ...payload, at: Date.now() })
      this.writePointer(payload, hash)
      return true
    } catch (e) {
      this.logger?.warn?.('task snapshot failed', e)
      return false
    }
  }

  /** 指针文件：始终指向"当前任务"，避免每次去 glob 目录。 */
  writePointer(payload, hash) {
    try {
      this.atomicJson(path.join(this.dir, SNAPSHOT), { hash, ...payload, at: Date.now() })
    } catch { /* 指针失败不影响主流程 */ }
  }

  atomicJson(file, value) {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value))
    fs.renameSync(tmp, file)
  }

  readTaskSnapshot(taskId) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'snapshots', `${taskId}.json`), 'utf8')) } catch { return undefined }
  }

  readSnapshot() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, SNAPSHOT), 'utf8')) } catch { return undefined }
  }
}
