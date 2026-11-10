/**
 * 采集：历史回填 + 实时增量。
 * 阶段 A 只产出"会话摘要 digest"，不落原文。
 *
 * 关键正确性（阶段 A 实测踩到的坑）：
 *   回填与增量可能并发写同一份 digest，必须按"字段级 seq"合并，
 *   否则增量 flush 会用空 digest 覆盖回填结果。
 * 提交顺序：先写 digest，再推进 cursor（最终方案 §9.2）。
 */
import { listDigests, loadManifest, readDigest, saveManifest, updateManifest, writeDigest } from './store.js'
import { extractCandidates } from './rules.js'
import { distill } from './distiller.js'
import { BackfillQueue } from './backfill.js'
import { trace } from './trace.js'

const USER_TEXT_MAX = 240
const ASSISTANT_TEXT_MAX = 400
const FLUSH_DEBOUNCE_MS = 1500

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/* ── 工具事件解析（S1.5） ──────────────────────────────────
 * DSH 实测：session/event 里有 tool/call{turn,step,callId,name,arguments}
 * 与 tool/result{turn,step,message,meta}。字段形状在不同工具间可能有差异，
 * 这里做防御式提取：拿不到文本就放弃，不猜。 */

function stringOf(v) {
  if (typeof v === 'string') return v
  try { return JSON.stringify(v ?? '') } catch { return '' }
}

function toolResultText(d) {
  const t = textOf(d?.message?.content ?? d?.content)
  if (t && t.trim()) return t
  const flat = stringOf(d?.message?.text ?? d?.text ?? '')
  return flat && flat.trim() ? flat : ''
}

/** 只有写/编辑/改名类工具才算"改动"；读文件不算。 */
export function isMutatingTool(name) {
  return /(write|edit|patch|create|delete|move|rename|mkdir|append)/i.test(String(name ?? ''))
}

/** 从工具参数里挑出被操作的文件路径（只认明确的路径字段，不猜）。 */
export function pickToolPath(args) {
  if (!args || typeof args !== 'object') return ''
  for (const k of ['file_path', 'filePath', 'path', 'notebook_path', 'target']) {
    const v = args[k]
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 200)
  }
  return ''
}

function toolStatus(d) {
  const m = d?.meta ?? d?.message?.meta ?? {}
  if (m.isError === true || m.error != null) return 'error'
  if (typeof m.status === 'string') return m.status
  if (m.ok === true) return 'ok'
  return 'ok'
}

/**
 * 历史会话事件 → 蒸馏窗口（S1.5-历史）。
 *
 * 回填时同样要把 tool/result 纳入证据池，否则历史 gotcha 永远只能是
 * "助手转述"，拿不到 tool_verified —— 这正是 S1c 之后简报变空的原因。
 */
export function historyToRecent(events, sessionId) {
  const out = []
  const calls = new Map()
  for (const e of events ?? []) {
    if (!e || typeof e.type !== 'string') continue
    if (e.type === 'tool/call') {
      const d = e.data ?? {}
      if (d.callId) calls.set(d.callId, String(d.name ?? 'tool'))
      continue
    }
    if (e.type === 'tool/result') {
      const d = e.data ?? {}
      const text = toolResultText(d)
      if (!text) continue
      out.push({
        seq: e.seq,
        role: 'tool',
        sessionId,
        text: clip(text, 800),
        tool: calls.get(d.meta?.callId) ?? String(d.meta?.name ?? 'tool'),
        status: toolStatus(d),
      })
      continue
    }
    if (e.type === 'user/message') {
      if (e.data?.source?.kind !== 'user') continue
      const t = textOf(e.data?.content)
      if (t?.trim()) out.push({ seq: e.seq, role: 'user', sessionId, text: t })
      continue
    }
    if (e.type === 'assistant/message') {
      const t = textOf(e.data?.message?.content)
      if (t?.trim()) out.push({ seq: e.seq, role: 'assistant', sessionId, text: t })
    }
  }
  return out
}

export function emptyDigest(session) {
  return {
    sessionId: session.id,
    cwd: session.cwd,
    createdAt: session.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    seq: -1,
    turns: 0,
    lastTurn: 0,
    userText: '',
    userSeq: -1,
    assistantText: '',
    assistantSeq: -1,
    kind: 'digest',
  }
}

/** 字段级合并：同一 session 的回填结果与增量结果取"更新的那个"。 */
export function mergeDigest(a, b) {
  if (!a) return b
  if (!b) return a
  const pick = (field, seqField) => ((b[seqField] ?? -1) >= (a[seqField] ?? -1) ? b[field] || a[field] : a[field])
  return {
    ...a,
    ...b,
    seq: Math.max(a.seq ?? -1, b.seq ?? -1),
    turns: Math.max(a.turns ?? 0, b.turns ?? 0),
    lastTurn: Math.max(a.lastTurn ?? 0, b.lastTurn ?? 0),
    userText: pick('userText', 'userSeq'),
    userSeq: Math.max(a.userSeq ?? -1, b.userSeq ?? -1),
    assistantText: pick('assistantText', 'assistantSeq'),
    assistantSeq: Math.max(a.assistantSeq ?? -1, b.assistantSeq ?? -1),
    createdAt: Math.min(a.createdAt ?? Infinity, b.createdAt ?? Infinity),
    updatedAt: Math.max(a.updatedAt ?? 0, b.updatedAt ?? 0),
  }
}

export class Ingestor {
  constructor({ config, logger, getSessionQuery, itemsFor, getLlm, getTasks, getActiveTaskId, applyTaskUpdates }) {
    this.config = config
    this.logger = logger
    this.getSessionQuery = getSessionQuery
    this.itemsFor = itemsFor        // (dir) => ItemsStore
    this.getLlm = getLlm            // () => ctx.get('llm')
    this.getTasks = getTasks        // (dir) => [{id,title}]，供蒸馏标注归属
    this.applyTaskUpdates = applyTaskUpdates  // (dir, updates, meta) => 应用条数
    this.getActiveTaskId = getActiveTaskId    // (dir) => 当前绑定任务 id（S2 归属用）
    this.pending = new Map()   // sessionId -> digest
    this.timers = new Map()
    this.stores = new Map()    // dir -> manifest
    this.backfilled = new Set()
    this.recent = new Map()    // sessionId -> [{seq, role, text, sessionId}]
    this.routes = new Map()    // sessionId -> {provider, model}
    this.distillTimers = new Map()
  }

  manifestOf(ws) {
    let m = this.stores.get(ws.dir)
    if (!m) {
      m = loadManifest(ws.dir)
      this.stores.set(ws.dir, m)
    }
    return m
  }

  /** 读-改-写落盘：只覆盖本模块拥有的字段，保留诊断等其它写入方数据。 */
  persist(ws, manifest) {
    updateManifest(ws.dir, (m) => {
      m.cursors = { ...manifest.cursors }
      m.itemCursors = { ...(manifest.itemCursors ?? {}) }
      m.stats = { ...m.stats, ...(manifest.stats ?? {}) }
      if (manifest.lastBackfillAt) m.lastBackfillAt = manifest.lastBackfillAt
      if (manifest.rulesVersion) m.rulesVersion = manifest.rulesVersion
      // route 必须一起持久化，否则重启后蒸馏重新陷入 no-route（实机踩坑）
      if (manifest.route) m.route = { ...manifest.route }
    })
    this.stores.set(ws.dir, loadManifest(ws.dir))
  }

  /* ── 历史回填 ───────────────────────────────────────────── */

  async backfill(ws) {
    const key = `${ws.workspaceId}:${ws.root}`
    if (this.backfilled.has(key)) return { skipped: true }
    this.backfilled.add(key)

    const q = this.getSessionQuery()
    if (!q) return { skipped: true, reason: 'no sessionQuery' }

    const since = Date.now() - this.config.ingest.historyDays * 864e5
    let records = []
    try {
      records = await q.filterSessions([{ kind: 'cwd', values: [ws.root] }])
    } catch (e) {
      trace('backfill:filter-error', { root: ws.root, message: String(e?.message ?? e) })
      this.logger.warn('backfill filterSessions failed', e)
      return { error: String(e?.message ?? e) }
    }
    trace('backfill:records', { root: ws.root, count: records.length })

    const usable = records
      .filter((r) => !(this.config.ingest.excludeSubAgents && (r.header.delegationDepth ?? 0) > 0))
      .filter((r) => (r.header.createdAt ?? 0) >= since)
      .sort((a, b) => (a.header.createdAt ?? 0) - (b.header.createdAt ?? 0))
      .slice(-this.config.ingest.maxSessions)

    let processed = 0
    for (const r of usable) {
      try {
        if (await this.ingestSession(ws, r.header.id)) processed += 1
      } catch (e) {
        trace('backfill:session-error', { id: r.header.id, message: String(e?.message ?? e), stack: String(e?.stack ?? '').slice(0, 300) })
        this.logger.warn(`backfill session ${r.header.id} failed`, e)
      }
    }

    const manifest = this.manifestOf(ws)
    manifest.lastBackfillAt = Date.now()
    manifest.stats.sessions = usable.length
    manifest.stats.digests = listDigests(ws.dir).length
    this.persist(ws, manifest)
    trace('backfill:done', { root: ws.root, sessions: usable.length, processed })
    this.logger.info(`backfill done ws=${ws.workspaceId} sessions=${usable.length} processed=${processed}`)
    return { sessions: usable.length, processed }
  }

  async ingestSession(ws, sessionId) {
    const q = this.getSessionQuery()
    const manifest = this.manifestOf(ws)
    manifest.itemCursors ??= {}
    const cursor = manifest.cursors[sessionId] ?? -1
    const itemCursor = manifest.itemCursors[sessionId] ?? -1

    const snap = await q.readSession(sessionId)
    const events = Array.isArray(snap?.events) ? snap.events : []
    if (events.length === 0) return false

    // 从历史里找最近一次模型路由，供蒸馏复用（实机：request/context 不一定实时出现）
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]
      if (e?.type === 'request/context' && e.data?.provider && e.data?.model) {
        this.routes.set(sessionId, { provider: e.data.provider, model: e.data.model })
        manifest.route = { provider: e.data.provider, model: e.data.model }
        trace('route:captured', { sessionId, route: manifest.route })
        break
      }
    }

    const fresh = events.filter((e) => (e.seq ?? -1) > cursor)
    const itemFresh = this.config.rules.enabled ? events.filter((e) => (e.seq ?? -1) > itemCursor) : []
    if (fresh.length === 0 && itemFresh.length === 0) return false

    let changed = false

    if (fresh.length > 0) {
      const window = fresh.slice(-this.config.ingest.maxEventsPerSession)
      const base = mergeDigest(
        readDigest(ws.dir, sessionId),
        this.pending.get(sessionId) ?? emptyDigest({ id: sessionId, cwd: ws.root, createdAt: events[0]?.time ?? Date.now() }),
      )
      const digest = { ...base }

      for (const e of window) this.applyEvent(digest, e)
      digest.updatedAt = Date.now()

      // 先落 digest，再推 cursor
      writeDigest(ws.dir, digest)
      manifest.cursors[sessionId] = Math.max(cursor, digest.seq)
      this.pending.delete(sessionId)
      changed = true
    }

    // B1：规则抽取（零 LLM），用独立 item 游标 —— 后装插件也能从历史提记忆
    if (itemFresh.length > 0) {
      const items = this.itemsFor?.(ws.dir)
      const stats = { added: 0, merged: 0, rejected: 0 }
      let n = 0
      for (const e of itemFresh) {
        if (n >= this.config.rules.maxItemsPerSession) break
        for (const c of extractCandidates(e, sessionId)) {
          if (n >= this.config.rules.maxItemsPerSession) break
          const r = items?.add(c)
          if (r) { stats[r.kind] = (stats[r.kind] ?? 0) + 1; if (r.kind !== 'rejected') n += 1 }
        }
      }
      manifest.itemCursors[sessionId] = Math.max(itemCursor, events[events.length - 1]?.seq ?? itemCursor)
      trace('rules:backfill', { sessionId, ...stats })
      changed = true
    }

    if (changed) this.persist(ws, manifest)
    return changed
  }

  /* ── 实时增量 ───────────────────────────────────────────── */

  onEvent(session, event, ws) {
    if (!ws) return
    if (this.config.ingest.excludeSubAgents && (session?.header?.delegationDepth ?? 0) > 0) return
    if (!event || typeof event.type !== 'string') return
    if (!['user/message', 'assistant/message', 'turn/end', 'request/context', 'tool/call', 'tool/result'].includes(event.type)) {
      // 诊断（S1.5）：DSH 会不会把 tool 事件送到 session/event？
      // 每种类型只记一次形状（不含内容），避免刷屏。
      const seen = (this.unknownEventTypes ??= new Map())
      const key = `${ws.dir}::${event.type}`
      if (!seen.has(key)) {
        const dataKeys = event.data && typeof event.data === 'object' ? Object.keys(event.data).slice(0, 8) : []
        seen.set(key, { n: 0, dataKeys })
        trace('event:unhandled', { type: event.type, dataKeys })
      }
      seen.get(key).n += 1
      return
    }

    // ── S1.5：工具事件 → tool 角色的证据来源 ──────────────────
    // tool/call 记住工具名；tool/result 把输出压成一条 role=tool 的"消息"，
    // 之后蒸馏可以引用它，authority 就能诚实地记成 tool_verified。
    if (event.type === 'tool/call') {
      const d = event.data ?? {}
      if (d.callId) {
        ;(this.toolCalls ??= new Map()).set(d.callId, {
          name: String(d.name ?? 'tool'),
          args: clip(stringOf(d.arguments), 200),
        })
      }
      // 最近改动指针（S8）：从工具参数里取"碰过的文件"，供简报恢复位置。
      // 只记路径与时间，不记内容——路径可核对，内容该去读文件。
      const touched = isMutatingTool(d.name) ? pickToolPath(d.arguments) : ''
      if (touched) {
        const id = session.header.id
        const bySession = (this.files ??= new Map())
        const m = bySession.get(id) ?? new Map()
        m.set(touched, { path: touched, at: Date.now(), tool: String(d.name ?? 'tool') })
        bySession.set(id, m)
        this.scheduleFlush(ws, id)
      }
      return
    }
    if (event.type === 'tool/result') {
      const d = event.data ?? {}
      const id = session.header.id
      const text = toolResultText(d)
      if (!text) return
      const call = (this.toolCalls?.get(d.meta?.callId) ?? this.toolCalls?.get(d.message?.meta?.callId)) ?? {}
      const status = toolStatus(d)
      const arr = this.recent.get(id) ?? []
      arr.push({
        seq: event.seq, role: 'tool', sessionId: id,
        text: clip(text, 800),
        tool: call.name ?? String(d.meta?.name ?? 'tool'),
        status,
      })
      while (arr.length > this.config.distill.maxEvents * 2) arr.shift()
      this.recent.set(id, arr)
      return
    }

    const id = session.header.id

    // 记录本轮使用的模型路由（蒸馏时复用同一路由）
    if (event.type === 'request/context') {
      const d = event.data ?? {}
      if (d.provider && d.model) this.routes.set(id, { provider: d.provider, model: d.model })
      return
    }

    let digest = this.pending.get(id)
    if (!digest) {
      digest = readDigest(ws.dir, id) ?? emptyDigest({
        id,
        cwd: session.header.cwd,
        createdAt: session.header.createdAt,
      })
      this.pending.set(id, digest)
    }
    this.applyEvent(digest, event)
    digest.updatedAt = Date.now()

    // B2：保留最近消息窗口供 LLM 蒸馏（含 sessionId/role/原文）
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      const text = event.type === 'user/message'
        ? (event.data?.source?.kind === 'user' ? textOf(event.data?.content) : '')
        : textOf(event.data?.message?.content)
      if (text && text.trim()) {
        const arr = this.recent.get(id) ?? []
        arr.push({ seq: event.seq, role: event.type === 'user/message' ? 'user' : 'assistant', text, sessionId: id })
        while (arr.length > this.config.distill.maxEvents) arr.shift()
        this.recent.set(id, arr)
      }
    }
    if (event.type === 'turn/end') {
      trace('event:turn-end', { sessionId: id, recent: (this.recent.get(id) ?? []).length })
      this.scheduleDistill(ws, id)
    }

    // B1：单条事件即时抽取
    if (this.config.rules.enabled) {
      try {
        const items = this.itemsFor?.(ws.dir)
        for (const c of extractCandidates(event, id)) {
          const r = items?.add(c)
          if (r && r.kind !== 'rejected') trace('rules:live', { kind: r.kind, type: c.type })
        }
      } catch (e) {
        trace('rules:error', { message: String(e?.message ?? e) })
      }
    }

    this.scheduleFlush(ws, id)
  }

  applyEvent(digest, event) {
    const d = event.data ?? {}
    const seq = event.seq ?? -1
    if (event.type === 'user/message') {
      // 只认真正的用户输入。
      // M0/阶段 A 实测：runtime-context、time-context 等运行时快照同样是 user/message，
      // 若只看"非 runtime-context"会把当前时间戳当成用户说的话。
      if (d.source?.kind !== 'user') return
      const t = clip(textOf(d.content), USER_TEXT_MAX)
      if (t && seq >= (digest.userSeq ?? -1)) {
        digest.userText = t
        digest.userSeq = seq
      }
    } else if (event.type === 'assistant/message') {
      const t = clip(textOf(d.message?.content), ASSISTANT_TEXT_MAX)
      if (t && seq >= (digest.assistantSeq ?? -1)) {
        digest.assistantText = t
        digest.assistantSeq = seq
      }
    } else if (event.type === 'turn/end') {
      digest.turns = (digest.turns ?? 0) + 1
      digest.lastTurn = Math.max(digest.lastTurn ?? 0, d.turn ?? 0)
    }
    digest.seq = Math.max(digest.seq ?? -1, seq)
  }

  scheduleFlush(ws, sessionId) {
    const key = `${ws.dir}:${sessionId}`
    if (this.timers.has(key)) return
    const timer = setTimeout(() => {
      this.timers.delete(key)
      try { this.flush(ws, sessionId) } catch (e) { this.logger.warn('flush failed', e) }
    }, FLUSH_DEBOUNCE_MS)
    timer.unref?.()
    this.timers.set(key, timer)
  }

  flush(ws, sessionId) {
    const pending = this.pending.get(sessionId)
    if (!pending) return
    const disk = readDigest(ws.dir, sessionId)
    const merged = mergeDigest(disk, pending)
    // 最近改动指针：把本会话碰过的文件并进摘要（去重、按时间倒序、最多 10 条）
    const touched = this.files?.get(sessionId)
    if (touched?.size) {
      const byPath = new Map((disk?.filesTouched ?? []).map((f) => [f.path, f]))
      for (const f of touched.values()) byPath.set(f.path, f)
      merged.filesTouched = [...byPath.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 10)
      touched.clear()
    }
    merged.updatedAt = Date.now()
    writeDigest(ws.dir, merged)
    const manifest = this.manifestOf(ws)
    manifest.itemCursors ??= {}
    let dirty = false
    if ((merged.seq ?? -1) > (manifest.cursors[sessionId] ?? -1)) {
      manifest.cursors[sessionId] = merged.seq
      manifest.stats.digests = listDigests(ws.dir).length
      dirty = true
    }
    // 实时抽取已覆盖到 seq，item 游标同步，避免回填重复处理
    if ((merged.seq ?? -1) > (manifest.itemCursors[sessionId] ?? -1)) {
      manifest.itemCursors[sessionId] = merged.seq
      dirty = true
    }
    if (dirty) this.persist(ws, manifest)
    this.pending.delete(sessionId)
  }

  /* ── B2：历史蒸馏（把过去会话里助手给出的技术结论也提炼出来） ── */

  async distillBackfill(ws, { maxSessions = 3, chunk = 40, maxChunksPerSession = 2 } = {}) {
    const llm = this.getLlm?.()
    if (!llm) return { error: 'no-llm' }
    const route = this.manifestOf(ws).route
    if (!route) return { error: 'no-route' }

    const q = this.getSessionQuery()
    const usable = (await q.filterSessions([{ kind: 'cwd', values: [ws.root] }]))
      .filter((s) => (s.header?.delegationDepth ?? 0) === 0)
      .sort((a, b) => (b.header?.createdAt ?? 0) - (a.header?.createdAt ?? 0))

    const items = this.itemsFor?.(ws.dir)
    let calls = 0
    let added = 0
    let parsedTotal = 0
    let droppedTotal = 0
    let sample = ''

    for (const r of usable.slice(0, maxSessions)) {
      let snap
      try { snap = await q.readSession(r.header.id) } catch { continue }
      const msgs = historyToRecent(snap?.events, r.header.id)

      // 从**最近**的消息往前分段：长会话里越靠后的内容越可能仍是"当前有效结论"
      const starts = []
      for (let end = msgs.length; end > 0; end -= chunk) starts.push(Math.max(0, end - chunk))

      let per = 0
      for (const start of starts) {
        if (per >= maxChunksPerSession) break
        const slice = msgs.slice(start, start + chunk)
        if (slice.length < 4) continue
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), 90_000)
        timer.unref?.()
        try {
          const res = await distill({ route, recent: slice, stream: (o) => llm.stream(o), signal: ac.signal, logger: this.logger, tasks: this.getTasks?.(ws.dir), currentTaskId: this.getActiveTaskId?.(ws.dir), schemaV2: this.config.distill.schemaV2 })
          calls += 1
          per += 1
          parsedTotal += res.parsed ?? 0
          droppedTotal += res.dropped ?? 0
          if (!sample && res.rawHead) sample = String(res.rawHead).slice(0, 120)
          for (const c of res.candidates ?? []) {
            const it = items?.add(c)
            if (it && it.kind !== 'rejected') added += 1
          }
        } catch (e) {
          trace('distill:backfill-error', { sessionId: r.header.id, message: String(e?.message ?? e).slice(0, 160) })
        } finally {
          clearTimeout(timer)
        }
      }
    }
    trace('distill:backfill', { sessions: Math.min(usable.length, maxSessions), calls, added, parsed: parsedTotal, dropped: droppedTotal })
    return { sessions: Math.min(usable.length, maxSessions), calls, added, parsed: parsedTotal, dropped: droppedTotal, sample }
  }

  /* ── 历史回填队列（v3.1.1 P0-1） ─────────────────────────── */

  /**
   * 发现历史会话 → 排队 → 按预算处理，处理完为止（不设总覆盖上限）。
   * 每轮从"最近未处理的段"往前推进，游标持久化，重启可续跑。
   */
  async processQueue(ws, { maxSessions, maxChunks, priorityWindowDays } = {}) {
    const llm = this.getLlm?.()
    if (!llm) return { error: 'no-llm' }
    const route = this.manifestOf(ws).route
    if (!route) return { error: 'no-route' }

    // S3：预算与重试策略统一从 config.backfill 取，调用方可覆盖
    const bf = this.config.backfill ?? {}
    const budgetSessions = maxSessions ?? bf.maxSessionsPerRun ?? 3
    const budgetChunks = maxChunks ?? bf.maxTotalChunksPerRun ?? 4
    const windowDays = priorityWindowDays ?? bf.priorityWindowDays ?? 30

    const q = this.getSessionQuery()
    const queue = new BackfillQueue({
      dir: ws.dir,
      logger: this.logger,
      maxRetries: bf.maxRetries ?? 3,
      retryBackoffMs: bf.retryBackoffMs ?? 60_000,
      totalSessionLimit: bf.totalSessionLimit ?? null,
    })
    try {
      const found = await q.filterSessions([{ kind: 'cwd', values: [ws.root] }])
      queue.discover(found.filter((s) => (s.header?.delegationDepth ?? 0) === 0))
    } catch (e) {
      trace('queue:discover-error', { message: String(e?.message ?? e).slice(0, 160) })
    }

    const items = this.itemsFor?.(ws.dir)
    const batch = queue.nextBatch({ limit: budgetSessions, priorityWindowDays: windowDays, totalSessionLimit: bf.totalSessionLimit ?? null })
    const chunkSize = this.config.distill.maxEvents ?? 40
    let chunks = 0
    let added = 0
    let parsed = 0
    let dropped = 0
    const touched = []

    for (const entry of batch) {
      if (chunks >= budgetChunks) break
      try {
        const snap = await q.readSession(entry.sessionId)
        const msgs = historyToRecent(snap?.events, entry.sessionId)

        let remaining = entry.cursorSeq == null ? msgs : msgs.filter((m) => m.seq < entry.cursorSeq)
        if (remaining.length < 4) { queue.markDone(entry.sessionId, 'too-short'); continue }

        while (remaining.length >= 4 && chunks < maxChunks) {
          const slice = remaining.slice(-chunkSize)
          const ac = new AbortController()
          const timer = setTimeout(() => ac.abort(), 90_000)
          timer.unref?.()
          try {
            const res = await distill({ route, recent: slice, stream: (o) => llm.stream(o), signal: ac.signal, logger: this.logger, tasks: this.getTasks?.(ws.dir), currentTaskId: this.getActiveTaskId?.(ws.dir), schemaV2: this.config.distill.schemaV2 })
            chunks += 1
            parsed += res.parsed ?? 0
            dropped += res.dropped ?? 0
            for (const c of res.candidates ?? []) {
              const it = items?.add(c)
              if (it && it.kind !== 'rejected') added += 1
            }
          } finally {
            clearTimeout(timer)
          }
          remaining = remaining.slice(0, remaining.length - slice.length)
          queue.markChunk(entry.sessionId, slice[0].seq)
        }
        if (remaining.length < 4) queue.markDone(entry.sessionId)
        touched.push(entry.sessionId)
      } catch (e) {
        // S3 错误分类：会话不存在 → skipped（不再重试）；其余 → retry_wait/failed
        const msg = String(e?.message ?? e).slice(0, 160)
        if (/not\s*found|ENOENT|no such session|不存在/i.test(msg)) {
          queue.markSkipped(entry.sessionId, msg)
          trace('queue:session-skipped', { sessionId: entry.sessionId })
        } else {
          queue.markFailed(entry.sessionId, msg)
          trace('queue:session-error', { sessionId: entry.sessionId, message: msg })
        }
      }
    }

    const summary = queue.summary()
    trace('queue:run', { ...summary, totalChunks: summary.chunks, sessions: touched.length, chunks, added, parsed, dropped })
    return { ...summary, totalChunks: summary.chunks, chunks, sessions: touched.length, added, parsed, dropped }
  }

  /** 队列状态（只读）。 */
  queueStatus(ws) {
    const queue = new BackfillQueue({ dir: ws.dir, logger: this.logger })
    return queue.summary()
  }

  /** 重置失败项重新排队。 */
  queueRetry(ws) {
    return new BackfillQueue({ dir: ws.dir, logger: this.logger }).retryFailed()
  }

  /* ── B2：LLM 蒸馏调度 ───────────────────────────────────── */

  scheduleDistill(ws, sessionId) {
    if (!this.config.distill.enabled) return
    const key = `${ws.dir}:${sessionId}`
    if (this.distillTimers.has(key)) return
    trace('distill:scheduled', { sessionId, afterMs: this.config.distill.debounceMs, recent: (this.recent.get(sessionId) ?? []).length })
    const timer = setTimeout(() => {
      this.distillTimers.delete(key)
      void this.runDistill(ws, sessionId)
    }, this.config.distill.debounceMs)
    timer.unref?.()
    this.distillTimers.set(key, timer)
  }

  async runDistill(ws, sessionId) {
    const llm = this.getLlm?.()
    const recent = (this.recent.get(sessionId) ?? []).slice(-this.config.distill.maxEvents)
    const route = this.routes.get(sessionId) ?? this.manifestOf(ws).route
    trace('distill:start', { sessionId, hasLlm: !!llm, recent: recent.length, route })
    if (!llm) { trace('distill:skip', { sessionId, reason: 'no-llm' }); return }
    if (recent.length < 2) { trace('distill:skip', { sessionId, reason: 'few-events', n: recent.length }); return }
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 60_000)
    timer.unref?.()
    try {
      const res = await distill({
        route,
        recent,
        stream: (opts) => llm.stream(opts),
        signal: ac.signal,
        logger: this.logger,
        tasks: this.getTasks?.(ws.dir), currentTaskId: this.getActiveTaskId?.(ws.dir),
      })
      if (res.error || res.skipped) {
        trace('distill:skip', { sessionId, reason: res.error ?? res.skipped })
        return
      }
      // 空响应（模型什么都没输出）视为"无可提炼"，静默跳过，不产生噪声 trace
      if (res.parsed === 0 && !res.rawHead) {
        trace('distill:empty', { sessionId })
        return
      }
      const items = this.itemsFor?.(ws.dir)
      let added = 0
      for (const c of res.candidates ?? []) {
        if (added >= this.config.distill.maxCandidates) break
        const r = items?.add(c)
        if (r && r.kind !== 'rejected') added += 1
      }
      // schemaV2：任务状态候选（已校验，永不含 done）
      const applied = this.applyTaskUpdates?.(ws.dir, res.taskUpdates, { sessionId })
      if (applied) trace('task:updates-applied', { n: applied })
      if (route) updateManifest(ws.dir, (m) => { m.route = route })
      trace('distill:done', { sessionId, parsed: res.parsed, dropped: res.dropped, added, rawHead: res.parsed === 0 ? res.rawHead : undefined })
    } catch (e) {
      trace('distill:error', { sessionId, message: String(e?.message ?? e).slice(0, 200) })
    } finally {
      clearTimeout(timer)
    }
  }

  flushAll(ws) {
    for (const id of [...this.pending.keys()]) {
      try { this.flush(ws, id) } catch { /* noop */ }
    }
  }
}
