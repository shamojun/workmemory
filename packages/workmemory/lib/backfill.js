/**
 * 历史回填队列（v3.1.1 P0-1）。
 *
 * 解决的问题：v3.1 之前"读进 30 天会话，却只蒸馏最后 1 个会话的 2 段"——
 * 两周前的技术决策天然进不了库。
 *
 * 设计取舍：
 *   - 三态即可（pending / done / failed），不需要六态状态机；
 *   - 每轮有预算（会话数 + 段数），但**总覆盖不设上限**，处理完为止；
 *   - 单会话按"从最近往前"推进，游标记 cursorSeq，重启可续跑；
 *   - 失败只标 failed 并继续下一个，不阻塞。
 */
import fs from 'node:fs'
import path from 'node:path'
import { coerceQueueItemV2, validateQueueItem } from './schema.js'
import { atomicWriteJson } from './store.js'

const SCHEMA = 2

export class BackfillQueue {
  constructor({ dir, logger, maxRetries = 3, retryBackoffMs = 60_000, totalSessionLimit = null }) {
    this.dir = dir
    this.logger = logger
    this.maxRetries = maxRetries
    this.retryBackoffMs = retryBackoffMs
    this.totalSessionLimit = totalSessionLimit
    this.file = path.join(dir, 'queue', 'backfill.json')
    this.state = this.load()
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (raw?.schemaVersion === SCHEMA && Array.isArray(raw.sessions)) return raw
    } catch { /* 首次运行 */ }
    return { schemaVersion: SCHEMA, createdAt: Date.now(), sessions: [], stats: { processed: 0, failed: 0 } }
  }

  save() {
    // S1b：队列项一律归一化到 v2 再落盘；校验不过只告警（不能因此丢回填进度）
    const sessions = this.state.sessions.map((s) => coerceQueueItemV2(s))
    for (const s of sessions) {
      const r = validateQueueItem(s)
      if (!r.ok) this.logger?.warn?.(`queue item invalid: ${s.sessionId} ${r.errors[0]}`)
    }
    this.state = { ...this.state, schemaVersion: 2, sessions }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    atomicWriteJson(this.file, this.state)
  }

  /** 把发现的会话登记进队列；已存在的不重复添加。总量上限为 null 时不限制。 */
  discover(found) {
    const known = new Set(this.state.sessions.map((s) => s.sessionId))
    let added = 0
    for (const s of found) {
      if (!s?.header?.id || known.has(s.header.id)) continue
      if (this.totalSessionLimit != null && this.state.sessions.length >= this.totalSessionLimit) {
        this.logger?.warn?.(`backfill: total session limit ${this.totalSessionLimit} reached, skip ${s.header.id}`)
        break
      }
      this.state.sessions.push({
        sessionId: s.header.id,
        createdAt: s.header.createdAt ?? Date.now(),
        state: 'pending',
        cursorSeq: null,
        chunks: 0,
        note: undefined,
      })
      known.add(s.header.id)
      added += 1
    }
    if (added) this.save()
    return added
  }

  /**
   * 取下一批待处理会话（S3 契约）。
   *   - pending 常驻候选；
   *   - retry_wait 只有到点（nextRetryAt <= now）才回池；
   *   - priorityWindowDays 内的排前面，再按时间从新到旧。
   */
  nextBatch({ limit = 3, priorityWindowDays = 30, now = Date.now(), totalSessionLimit = null } = {}) {
    if (totalSessionLimit != null) {
      const all = this.state.sessions.length
      if (all >= totalSessionLimit) {
        // 已达总量上限：只允许处理已在队列里的，不再扩大（发现阶段会拦住新增）
        this.limitReached = true
      }
    }
    const since = now - priorityWindowDays * 864e5
    const ready = this.state.sessions.filter((s) => {
      if (s.state === 'pending') return true
      if (s.state === 'retry_wait') return (s.nextRetryAt ?? 0) <= now
      return false
    })
    ready.sort((a, b) => {
      const ap = (a.createdAt ?? 0) >= since ? 1 : 0
      const bp = (b.createdAt ?? 0) >= since ? 1 : 0
      if (ap !== bp) return bp - ap                 // 优先窗口内先处理
      return (b.createdAt ?? 0) - (a.createdAt ?? 0) // 再按时间从新到旧
    })
    return ready.slice(0, limit)
  }

  markChunk(sessionId, cursorSeq) {
    const s = this.state.sessions.find((x) => x.sessionId === sessionId)
    if (!s) return
    // v2 双游标：读取位置推进，提交位置在 items 写入成功后同步推进
    s.readCursorSeq = cursorSeq
    s.committedCursorSeq = cursorSeq
    s.chunksCompleted = (s.chunksCompleted ?? 0) + 1
    s.updatedAt = Date.now()
    this.save()
  }

  markDone(sessionId, note) {
    const s = this.state.sessions.find((x) => x.sessionId === sessionId)
    if (!s) return
    s.state = 'completed'
    s.nextRetryAt = null
    s.currentChunkId = null
    if (note) s.lastError = note
    this.state.stats.processed = (this.state.stats.processed ?? 0) + 1
    this.save()
  }

  /** 明确跳过（会话已删除 / 不适用），保留原因、不再重试。 */
  markSkipped(sessionId, reason) {
    const s = this.state.sessions.find((x) => x.sessionId === sessionId)
    if (!s) return
    s.state = 'skipped'
    s.nextRetryAt = null
    s.currentChunkId = null
    s.lastError = String(reason ?? '').slice(0, 160)
    this.save()
  }

  markFailed(sessionId, reason) {
    const s = this.state.sessions.find((x) => x.sessionId === sessionId)
    if (!s) return
    s.retryCount = (s.retryCount ?? 0) + 1
    const max = this.maxRetries ?? 3
    if (s.retryCount > max) {
      // 超过上限 → 交给人工（/memory queue retry 可重排）
      s.state = 'failed'
      s.nextRetryAt = null
    } else {
      s.state = 'retry_wait'
      s.nextRetryAt = Date.now() + (this.retryBackoffMs ?? 60_000) * s.retryCount
    }
    s.lastError = String(reason ?? '').slice(0, 160)
    this.state.stats.failed = (this.state.stats.failed ?? 0) + 1
    this.save()
  }

  summary() {
    const by = (st) => this.state.sessions.filter((s) => s.state === st).length
    return {
      total: this.state.sessions.length,
      pending: by('pending') + by('retry_wait'),
      done: by('completed'),          // 兼容旧字段名
      completed: by('completed'),
      retryWait: by('retry_wait'),
      failed: by('failed'),
      chunks: this.state.sessions.reduce((n, s) => n + (s.chunksCompleted ?? s.chunks ?? 0), 0),
    }
  }

  /** 重置失败/待重试项，让它们重新排队（/memory queue retry）。 */
  retryFailed() {
    let n = 0
    for (const s of this.state.sessions) {
      if (s.state === 'failed' || s.state === 'retry_wait') {
        s.state = 'pending'
        s.nextRetryAt = null
        s.lastError = undefined
        n += 1
      }
    }
    if (n) this.save()
    return n
  }
}
