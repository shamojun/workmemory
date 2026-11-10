/**
 * WorkMemory —— DSH 工作区长期记忆插件（阶段 A 骨架）
 *
 * 阶段 A 范围：工作区解析、历史回填、实时增量、幂等游标、JSONL 摘要、基础简报。
 * 不包含：LLM 蒸馏、记忆项/实体模型、生命周期、检索、工具。
 */
import { resolveConfig } from './config.js'
import { createLogger } from './log.js'
import { resolveWorkspace } from './workspace.js'
import { rebindByRoot, readHostRegistry, readIndex, storageBase, upsertIndex, dshHome } from './storage.js'
import { Ingestor } from './ingest.js'
import { ItemsStore } from './items.js'
import { RULES_VERSION } from './rules.js'
import { buildBrief, renderStatus } from './brief.js'
import { search } from './retrieval.js'
import { EntitiesStore } from './entities.js'
import { META_PATTERNS } from './distiller.js'
import { assertInside, safeJoin } from './safety.js'
import { detectTask, progressSignal, wantsRecall } from './continuity.js'
import { acquireLock, atomicWriteJson, ensureDir, listDigests, loadManifest, readJson, updateManifest } from './store.js'
import { SCHEMA_VERSION } from './schema.js'
import { trace } from './trace.js'
import fs from 'node:fs'
import path from 'node:path'

export const name = 'workmemory'
export const inject = ['agents', 'sessions', 'systemPrompt', 'commands', 'tools', 'fs']

const BRIEF_CACHE_MS = 5000

export function apply(ctx, rawConfig) {
  // 启动标记：判断"新代码是否真的被加载"，不依赖任何 DSH 服务
  try {
    fs.writeFileSync(`${process.env.TEMP ?? '/tmp'}/workmemory-boot.json`, JSON.stringify({ pid: process.pid, at: Date.now(), v: 'A.2' }))
  } catch { /* noop */ }
  trace('apply:start', { v: 'A.2' })

  const config = resolveConfig(rawConfig)
  const registry = new Map()   // root -> { ws, lock, readOnly, logger }
  const briefCache = new Map() // sessionId -> { text, at, root }
  let bootstrapLogger

  const loggerFor = (dir) => {
    const l = createLogger(dir, 'workmemory')
    if (l.file) return l
    // 工作区目录不可写时退到 TEMP，保证诊断可见
    return createLogger(process.env.TEMP, 'workmemory')
  }

  function ensureWorkspace(cwd) {
    try {
      const resolved = resolveWorkspace(cwd, config)
      if (!resolved) { trace('ensure:unresolved', { cwd }); return undefined }
      const hit = registry.get(resolved.root)
      if (hit) return hit    // 热路径：不写 trace

      trace('ensure:new', { root: resolved.root, key: resolved.key, registered: resolved.registered, temporary: resolved.temporary })

      const location = config.storage.location ?? 'global'
      const base = storageBase(config)
      if (location !== 'workspace' && !resolved.readOnly) {
        // 注销后重新登记：新 key 无数据、但同一路径有旧数据 → 改挂过来
        try {
          if (!fs.existsSync(resolved.dir)) {
            const liveKeys = new Set(readHostRegistry().map((w) => w.workspaceId))
            const rb = rebindByRoot({ base, key: resolved.key, root: resolved.root, liveKeys, deps: { atomicWriteJson, ensureDir } })
            if (rb.rebound) trace('storage:rebind', { from: rb.from, to: resolved.key, root: resolved.root })
          }
          upsertIndex(base, {
            key: resolved.key,
            root: resolved.identityRoot ?? resolved.root,
            title: resolved.title,
            registered: resolved.registered,
            location,
          }, { atomicWriteJson, ensureDir })
        } catch (e) {
          trace('storage:index-error', { message: String(e?.message ?? e).slice(0, 160) })
        }
      }

      // 数据目录必须落在预期根内（node:fs 不受 ctx.fs 沙箱保护，自建边界）
      try {
        assertInside(location === 'workspace' ? resolved.root : base, resolved.dir, 'memory dir')
      } catch (e) {
        trace('safety:escape', { root: resolved.root, dir: resolved.dir })
        resolved.readOnly = true
      }
      // 路径越界时不碰磁盘（连锁都不建），直接只读
      const lock = resolved.readOnly
        ? { readOnly: true, token: null, holder: null }
        : acquireLock(resolved.dir)
      trace('ensure:lock', { root: resolved.root, readOnly: lock.readOnly, holderPid: lock.holder?.pid, holderLease: lock.holder?.leaseExpiresAt })
      const logger = loggerFor(resolved.dir)

      const entry = {
        ws: resolved,
        lock,
        readOnly: lock.readOnly,
        lockToken: lock.token,
        logger,
        items: new ItemsStore({ dir: resolved.dir, logger, guard: () => guardEpoch(entry, resolved.dir) }),
        entities: new EntitiesStore({ dir: resolved.dir, logger }),
        lastTaskAttempt: 0,
      }
      registry.set(resolved.root, entry)

      if (entry.readOnly) {
        entry.logger.warn(`workspace ${resolved.workspaceId} opened READ-ONLY (lock held elsewhere)`)
      } else {
        entry.logger.info(`workspace ready ${resolved.workspaceId} at ${resolved.root}`)
        // 一次性清理：把"过程元信息"条目置为 invalid。
        // manifest.metaPurgeAt 保证只跑一次；只置 invalid，不物理删除（留审计）。
        try {
          if (!loadManifest(resolved.dir).metaPurgeAt) {
            const purged = entry.items.purgeMeta(META_PATTERNS)
            updateManifest(resolved.dir, (m) => { m.metaPurgeAt = Date.now(); m.metaPurged = purged })
            if (purged) trace('items:meta-purged', { n: purged })
          }
        } catch (e) {
          trace('items:meta-purge-error', { message: String(e?.message ?? e).slice(0, 160) })
        }
        // v3：一次性从存量文本回填知识形态（理由/范围），拆不出保持 null
        try {
          if (!loadManifest(resolved.dir).kindBackfillAt) {
            const n = entry.items.backfillKinds()
            updateManifest(resolved.dir, (m) => { m.kindBackfillAt = Date.now(); m.kindBackfilled = n })
            if (n) trace('items:kinds-backfilled', { n })
          }
        } catch (e) {
          trace('items:kinds-backfill-error', { message: String(e?.message ?? e).slice(0, 160) })
        }

        // 一次性重算存量归属（S2）：每任务最多 60 条，避免一个任务吃掉整库
        try {
          if (!loadManifest(resolved.dir).reattributeAt) {
            const tasks = entry.entities.list({ kind: 'task' })
            const n = entry.items.reattribute(tasks, { currentTaskId: loadManifest(resolved.dir).activeTaskId, maxPerTask: 60 })
            updateManifest(resolved.dir, (m) => { m.reattributeAt = Date.now(); m.reattributed = n })
            if (n) trace('items:reattributed', { n })
          }
        } catch (e) {
          trace('items:reattribute-error', { message: String(e?.message ?? e).slice(0, 160) })
        }
        // 首次见到该工作区时后台回填（不阻塞请求）
        setTimeout(() => {
          try {
            // 自愈 1：数据目录被删/损坏 → 重跑回填
            if (!fs.existsSync(`${resolved.dir}/manifest.json`)) {
              ingestFor(entry).backfilled.delete(`${resolved.workspaceId}:${resolved.root}`)
              trace('backfill:self-heal', { root: resolved.root })
            }
            // 自愈 2：规则版本变化 → 只重抽 origin=rule 的条目，其余（llm/manual/历史）保留
            if ((loadManifest(resolved.dir).rulesVersion ?? 1) !== RULES_VERSION) {
              const dropped = entry.items.dropWhere((i) => i.origin === 'rule')
              updateManifest(resolved.dir, (m) => {
                m.itemCursors = {}
                m.rulesVersion = RULES_VERSION
              })
              ingestFor(entry).backfilled.delete(`${resolved.workspaceId}:${resolved.root}`)
              trace('rules:rebuild', { root: resolved.root, version: RULES_VERSION, dropped })
            }
            void ingestFor(entry).backfill(entry.ws).then(() => {
              // 历史队列：每轮按预算推进，未处理完的下次启动继续（v3.1.1）
              if (!config.distill.autoBackfill) return
              if (!loadManifest(resolved.dir).route) return
              setTimeout(() => {
                void ingestFor(entry).processQueue(entry.ws, {
                  maxSessions: config.backfill.maxSessionsPerRun,
                  maxChunks: config.backfill.maxTotalChunksPerRun,
                }).then((r) => {
                  trace('queue:auto-run', { result: r })
                }).catch((e) => trace('queue:auto-error', { message: String(e?.message ?? e).slice(0, 160) }))
              }, 4000)
            })
          } catch (e) {
            entry.logger.warn('backfill kickoff', e)
            trace('backfill:kickoff-error', { m: String(e?.message ?? e) })
          }
        }, 0)
      }
      return entry
    } catch (e) {
      trace('ensure:error', { cwd, message: String(e?.message ?? e), stack: String(e?.stack ?? '').slice(0, 500) })
      return undefined
    }
  }

  const bootstrap = () => (bootstrapLogger ??= createLogger(undefined, 'workmemory'))

  /** 锁代次校验：只有当前持锁者的 token 与 manifest 一致时才允许写。 */
  const guardEpoch = (entry, dir) => {
    if (entry.readOnly) return false
    if (entry.lockToken == null) return true
    try { return (loadManifest(dir).lockEpoch ?? 0) === entry.lockToken } catch { return false }
  }

  const ingestor = (() => {
    let active = undefined
    const proxy = {
      info: (...a) => (active ?? bootstrap()).info(...a),
      warn: (...a) => (active ?? bootstrap()).warn(...a),
    }
    const inst = new Ingestor({
      config,
      logger: proxy,
      getSessionQuery: () => ctx.get('sessionQuery'),
      getLlm: () => ctx.get('llm'),
      getTasks: (dir) => { for (const e of registry.values()) if (e.ws.dir === dir) return e.entities.list({ kind: 'task' }); return [] },
      getActiveTaskId: (dir) => loadManifest(dir).activeTaskId,
      applyTaskUpdates: (dir, updates, meta) => {
        if (!Array.isArray(updates) || updates.length === 0) return 0
        const e = [...registry.values()].find((x) => x.ws.dir === dir)
        if (!e || e.readOnly) return 0
        let n = 0
        for (const u of updates) {
          const task = e.entities.get(u.taskId)
          if (!task) continue
          const ev = { sessionId: meta?.sessionId ?? '', seq: -1, role: 'assistant', quote: String(u.progress ?? u.nextSteps ?? '').slice(0, 160), assertionType: 'inferred' }
          if (u.status && ['active', 'paused', 'blocked'].includes(u.status) && u.status !== task.status) {
            e.entities.updateTask(task.id, { status: u.status })
            n += 1
          }
          if (u.progress) { e.entities.appendToTask(task.id, 'progress', u.progress, ev); n += 1 }
          if (u.nextSteps) { e.entities.appendToTask(task.id, 'nextSteps', u.nextSteps, ev); n += 1 }
        }
        return n
      },
      itemsFor: (dir) => {
        for (const e of registry.values()) if (e.ws.dir === dir) return e.items
        return undefined
      },
    })
    inst.bindLogger = (l) => { active = l }
    return inst
  })()

  // 切换 ingestor 的日志出口到对应工作区
  const ingestFor = (entry) => {
    ingestor.bindLogger(entry.logger)
    return ingestor
  }

  /* ── 任务连续性（v3.1）：规则优先 + LLM 兜底 ────────────── */

  /** S4a：状态衰减。每轮取任务前跑一次（任务数很少，成本可忽略）。 */
  const decayEntry = (entry) => {
    try {
      const n = entry.entities.decayTasks({ idleDays: config.task?.idleDaysToPaused ?? 14 })
      if (!n) return 0
      // 被衰减的可能正是当前绑定任务：解绑，否则简报还会说"当前任务"
      const activeId = loadManifest(entry.ws.dir).activeTaskId
      const cur = activeId ? entry.entities.get(activeId) : undefined
      if (activeId && (!cur || !['active', 'paused', 'blocked'].includes(cur.status))) {
        updateManifest(entry.ws.dir, (m) => { m.activeTaskId = null })
      }
      trace('task:decayed', { n, activeId })
      return n
    } catch (e) {
      trace('task:decay-error', { message: String(e?.message ?? e).slice(0, 160) })
      return 0
    }
  }

  const pickTaskForEntry = (entry) => {
    try {
      decayEntry(entry)
      const id = loadManifest(entry.ws.dir).activeTaskId
      const t = id ? entry.entities.get(id) : undefined
      if (t && ['active', 'paused', 'blocked'].includes(t.status)) return t
      const snap = entry.entities.readSnapshot()
      if (snap?.id) return entry.entities.get(snap.id)
      return undefined
    } catch { return undefined }
  }

  const setActiveTask = (entry, task, reason) => {
    // todo → 一旦被点名激活，就进入 active（v3.1.1）
    const cur = task.status === 'todo' ? (entry.entities.updateTask(task.id, { status: 'active' }) ?? task) : task
    updateManifest(entry.ws.dir, (m) => { m.activeTaskId = cur.id })
    if (entry.sessionId) entry.entities.bindSession(cur.id, entry.sessionId)
    entry.entities.snapshot(entry.entities.get(cur.id) ?? cur)
    trace('task:active', { taskId: cur.id, title: cur.title, reason })
  }

  const llmText = async (entry, messages, maxTokens = 300) => {
    const llm = ctx.get('llm')
    const route = loadManifest(entry.ws.dir).route
    if (!llm || !route) return ''
    let raw = ''
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 30_000)
    timer.unref?.()
    try {
      for await (const chunk of llm.stream({ provider: route.provider, model: route.model, messages, temperature: 0.1, maxTokens, signal: ac.signal })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
      }
    } catch (e) {
      trace('task:llm-error', { message: String(e?.message ?? e).slice(0, 160) })
    } finally {
      clearTimeout(timer)
    }
    return raw
  }

  const createTaskWithLlm = async (entry, text) => {
    // 兜底：每 10 分钟最多一次，避免长会话反复调用
    if (Date.now() - (entry.lastTaskAttempt ?? 0) < 10 * 60_000) return undefined
    entry.lastTaskAttempt = Date.now()
    const raw = await llmText(entry, [{
      role: 'user',
      content: [{
        type: 'text',
        text: `根据这句话判断用户在做的工作任务，输出严格 JSON：{"title":"短标题","objective":"完成标准"}\n如果只是闲聊或没有明确任务，输出 {"none":true}\n\n${String(text).slice(0, 600)}`,
      }],
    }])
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end <= start) return undefined
    let obj
    try { obj = JSON.parse(raw.slice(start, end + 1)) } catch { return undefined }
    if (obj?.none || !obj?.title) return undefined
    const task = entry.entities.createTask({
      title: String(obj.title).slice(0, 80),
      objective: String(obj.objective ?? '').slice(0, 200),
      keywords: String(obj.title).split(/[\s，,、。]+/).filter((w) => w.length >= 2),
      sessionId: entry.sessionId,
      evidence: { sessionId: entry.sessionId, seq: -1, role: 'user', quote: String(text).slice(0, 160), assertionType: 'inferred' },
    })
    trace('task:created', { taskId: task.id, title: task.title })
    return task
  }

  const handleUserMessageForTask = async (entry, event) => {
    try {
      if (event?.data?.source?.kind !== 'user') return
      const text = (Array.isArray(event.data?.content) ? event.data.content : [])
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text).join('\n')
      if (!text || text.length < 2) return

      const tasks = entry.entities.list({ kind: 'task' })
      const picked = detectTask({ tasks, text })

      if (picked?.task) {
        if (loadManifest(entry.ws.dir).activeTaskId !== picked.task.id) setActiveTask(entry, picked.task, picked.reason)
        // 显式进度：只在这类句子上改任务内容，不做逐轮 LLM 更新
        const sig = progressSignal(text)
        if (sig) {
          const field = sig.kind === 'blocker' ? 'blockers' : sig.kind === 'next' ? 'nextSteps' : 'progress'
          entry.entities.appendToTask(picked.task.id, field, sig.text, {
            sessionId: entry.sessionId, seq: event.seq, role: 'user', quote: sig.text.slice(0, 160), assertionType: 'explicit',
          })
          trace('task:progress', { taskId: picked.task.id, field })
        }
      } else if (picked?.create && text.length >= 12) {
        const task = await createTaskWithLlm(entry, text)
        if (task) setActiveTask(entry, task, 'llm-create')
      }
    } catch (e) {
      trace('task:error', { message: String(e?.message ?? e).slice(0, 200) })
    }
  }

  /* ── 会话创建：初始化工作区 + 绑定任务 ─────────────────── */
  try {
    ctx.on('session/created', (session) => {
      try {
        const entry = ensureWorkspace(session?.header?.cwd)
        if (!entry) return
        entry.sessionId = session?.header?.id
        // 跨会话连续性：把新会话绑到当前活跃任务
        const task = pickTaskForEntry(entry)
        if (task && entry.sessionId && !entry.readOnly) {
          entry.entities.bindSession(task.id, entry.sessionId)
          entry.entities.snapshot(entry.entities.get(task.id) ?? task)
          trace('task:bound', { taskId: task.id, sessionId: entry.sessionId })
        }
        if (!entry.readOnly) void ingestFor(entry).backfill(entry.ws)
      } catch (e) {
        (bootstrapLogger ??= createLogger(undefined, 'workmemory')).warn('session/created', e)
      }
    })
  } catch (e) {
    // 事件不存在时不影响插件加载
  }

  /* ── 实时增量 ───────────────────────────────────────────── */
  try {
    // 诊断（S1.5 前置）：探测 DSH 是否存在工具类事件通道。
    // 只记事件名与参数个数，不读内容；未声明的事件名会被忽略，不影响加载。
    for (const name of ['tool/call', 'tool/result', 'tool/end', 'tool/execute', 'tool/output', 'agent/tool']) {
      try { ctx.on(name, (...args) => trace('event:probe', { name, argc: args.length })) } catch { /* 未声明则忽略 */ }
    }
    let seen = 0
    ctx.on('session/event', (session, event) => {
      try {
        seen += 1
        if (seen <= 3) trace('event:recv', { type: event?.type, seq: event?.seq, n: seen, cwd: session?.header?.cwd })
        const entry = ensureWorkspace(session?.header?.cwd)
        if (!entry || entry.readOnly) return
        entry.sessionId ??= session?.header?.id
        ingestFor(entry).onEvent(session, event, entry.ws)
        // 任务连续性：只在用户输入与轮次结束时介入
        if (event?.type === 'user/message') {
          // 记录最近一句用户输入，供简报的"动态召回"判断是否在问历史
          if (event?.data?.source?.kind === 'user') {
            const t = (Array.isArray(event?.data?.content) ? event.data.content : [])
              .filter((b) => b?.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text).join('\n')
            if (t) entry.lastUserText = t.slice(0, 500)
          }
          void handleUserMessageForTask(entry, event)
        } else if (event?.type === 'turn/end') {
          entry.items.sweepExpired()
          const task = pickTaskForEntry(entry)
          if (task) entry.entities.snapshot(task)
        }
      } catch (e) {
        trace('event:error', { type: event?.type, message: String(e?.message ?? e), stack: String(e?.stack ?? '').slice(0, 400) })
      }
    })
    trace('event:subscribed')
  } catch (e) {
    trace('event:subscribe-error', { message: String(e?.message ?? e) })
  }

  /* ── 简报：DSH 原生运行时上下文通道 ─────────────────────── */
  if (config.brief.enabled) {
    try {
      ctx.effect(() => ctx.systemPrompt.context({
        name: 'workmemory',
        order: 900,
        interpolate: false,
        text: (ac) => {
          try {
            const agent = ac?.agent
            if (!agent) return ''
            const entry = ensureWorkspace(agent.session?.header?.cwd)
            if (!entry) return ''
            const sessionId = agent.session.header.id
            const task = pickTaskForEntry(entry)
            const cacheKey = `${sessionId}:${entry.items.version}:${task?.id ?? '-'}:${task?.rev ?? 0}:${(entry.lastUserText ?? '').slice(0, 40)}`
            const cached = briefCache.get(cacheKey)
            if (cached && Date.now() - cached.at < BRIEF_CACHE_MS && cached.root === entry.ws.root) return cached.text
            const items = entry.items.list()
            // 动态召回：只在用户问"之前/上次/为什么当初"时才检索，避免每轮都翻历史
            const q = entry.lastUserText ?? ''
            // noHint：不要因为句子里有"决定"就把候选池收窄到 decision 类型
            // 只用词法真正命中的条目（bm>0），避免把"同类最新"当相关
            // policy:'fact' —— 自动召回只带"可作事实"的条目（S1c）
            const recallHits = q && wantsRecall(q)
              ? search(items, q, { limit: 10, task, noHint: true, policy: 'fact' }).filter((h) => h.bm > 0).slice(0, 5).map((h) => h.item)
              : undefined
            if (recallHits?.length) trace('recall:injected', { n: recallHits.length, ids: recallHits.map((i) => String(i.id).slice(-4)) })
            const text = buildBrief({ ws: entry.ws, digests: listDigests(entry.ws.dir), items, config, task, recallHits })
            briefCache.set(cacheKey, { text, at: Date.now(), root: entry.ws.root })
            return text
          } catch {
            return ''
          }
        },
      }), 'workmemory.context()')
    } catch (e) {
      (bootstrapLogger ??= createLogger(undefined, 'workmemory')).warn('systemPrompt.context unavailable', e)
    }
  }

  /* ── 命令（同时注册 /workmemory 与产品名 /memory） ───────── */
  try {
    const commandDef = {
      name: 'workmemory',
      description: 'WorkMemory：brief / review / export / storage / doctor / clear',
      input: { hint: 'brief | review [confirm <id> | reject <id>] | export [--out <file>] | storage [path | list | gc] | doctor | clear --yes' },
      handler: async ({ agent, rawInput }) => {
        const parts = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
        const cmd = parts[0] || 'brief'
        const entry = ensureWorkspace(agent?.session?.header?.cwd)
        if (!entry) return { kind: 'error', text: 'WorkMemory: 无法解析工作区（cwd 缺失）' }

        /* 1. 看简报（与自动注入内容一致） */
        if (cmd === 'brief') {
          const text = buildBrief({ ws: entry.ws, digests: listDigests(entry.ws.dir), items: entry.items.list(), config })
          return { kind: 'success', text: text || '（简报为空）' }
        }

        /* 2. 看待确认条目，并按 4 位 id 确认/否掉 */
        if (cmd === 'review') {
          const action = parts[1]
          if (action === 'confirm' || action === 'reject') {
            const want = parts[2]
            if (!want) return { kind: 'error', text: `用法：/memory review ${action} <id>` }
            const target = entry.items.list().find((i) => i.id === want || String(i.id).slice(-4) === want)
            if (!target) return { kind: 'error', text: `找不到记忆项 ${want}` }
            const next = action === 'confirm'
              ? { ...target, status: 'active', authority: 'user_confirmed', updatedAt: Date.now(), rev: (target.rev ?? 1) + 1 }
              : { ...target, status: 'invalid', updatedAt: Date.now(), rev: (target.rev ?? 1) + 1 }
            entry.items.append(next)
            return { kind: 'success', text: `[M${String(next.id).slice(-4)}] → ${next.status}` }
          }
          const pending = entry.items.list({ status: 'pending', limit: 20 })
          if (pending.length === 0) return { kind: 'success', text: '（没有待确认的记忆）' }
          const lines = pending.map((i) => `[M${String(i.id).slice(-4)}] ${i.type} ${i.text}`)
          return {
            kind: 'success',
            text: `${lines.join('\n')}\n\n确认：/memory review confirm <id>\n否掉：/memory review reject <id>`,
          }
        }

        /* 3. 导出（只读） */
        if (cmd === 'export') {
          const outArg = parts.indexOf('--out')
          const def = path.join(dshHome(), 'exports', `workmemory-${(entry.ws.key ?? 'ws').slice(0, 12)}-${new Date().toISOString().slice(0, 10)}.json`)
          const outFile = outArg > 0 && parts[outArg + 1] ? path.resolve(parts[outArg + 1]) : def
          const items = entry.items.list()
          const digests = listDigests(entry.ws.dir)
          const manifest = readJson(path.join(entry.ws.dir, 'manifest.json'), {})
          const entities = readJsonlFile(path.join(entry.ws.dir, 'entities.jsonl'))
          atomicWriteJson(outFile, {
            format: 'workmemory-export',
            version: 1,
            exportedAt: Date.now(),
            workspace: { key: entry.ws.key, root: entry.ws.root, title: entry.ws.title, workspaceId: entry.ws.workspaceId ?? null },
            schemaVersion: SCHEMA_VERSION,
            items,
            entities,
            digests,
            manifest,
            checksum: { items: items.length, entities: entities.length, digests: digests.length },
          })
          trace('storage:export', { file: outFile, items: items.length })
          return { kind: 'success', text: `已导出 ${items.length} 条记忆 → ${outFile}` }
        }

        /* 4. 数据位置：path / list / gc */
        if (cmd === 'storage') {
          const sub = parts[1] ?? 'path'
          if (sub === 'path') {
            return { kind: 'success', text: `${entry.ws.dir}\n（location=${config.storage.location ?? 'global'}，key=${entry.ws.key ?? '-'}）` }
          }
          if (sub === 'list') {
            const idx = readIndex(storageBase(config))
            const rows = Object.entries(idx.workspaces)
            if (rows.length === 0) return { kind: 'success', text: '（索引为空）' }
            return {
              kind: 'success',
              text: rows.map(([k, v]) => `${v.registered ? '●' : '○'} ${k.slice(0, 12)}  ${v.title}  ${v.root}`).join('\n'),
            }
          }
          if (sub === 'gc') {
            const idx = readIndex(storageBase(config))
            const wantPurge = parts.includes('--purge') && parts.includes('--yes')
            const daysArg = parts.indexOf('--older-than')
            const days = daysArg > 0 ? Number(parts[daysArg + 1]) : 30
            const cutoff = Date.now() - (Number.isFinite(days) ? days : 30) * 864e5
            const stale = Object.entries(idx.workspaces).filter(([, v]) => (v.lastSeenAt ?? 0) < cutoff)
            if (stale.length === 0) return { kind: 'success', text: `没有超过 ${days} 天未出现的工作区` }
            for (const [k] of stale) {
              delete idx.workspaces[k]
              if (wantPurge) {
                try { fs.rmSync(path.join(storageBase(config), k), { recursive: true, force: true }) } catch { /* 忽略 */ }
              }
            }
            atomicWriteJson(path.join(storageBase(config), 'index.json'), idx)
            trace('storage:gc', { removed: stale.length, purge: wantPurge, days })
            return {
              kind: 'success',
              text: `清理索引 ${stale.length} 项${wantPurge ? '（含数据）' : '（仅索引，数据保留）'}`,
            }
          }
          return { kind: 'error', text: '用法：/memory storage path | list | gc' }
        }

        /* 5. 体检：统计 + 校验 + 备份（原 stats / verify / backup 合并） */
        if (cmd === 'doctor') {
          const all = entry.items.list()
          const by = (s) => all.filter((i) => i.status === s).length
          const byType = {}
          for (const i of all) byType[i.type] = (byType[i.type] ?? 0) + 1
          const knowledge = all.filter((i) => ['rationale', 'lesson', 'constraint', 'scope'].includes(i.knowledgeKind)).length
          const noEvidence = all.filter((i) => !(i.evidence ?? []).length).length
          const m = loadManifest(entry.ws.dir)
          const digests = listDigests(entry.ws.dir)

          const lines = [
            `条目 ${all.length}（active ${by('active')} / pending ${by('pending')} / invalid ${by('invalid')} / superseded ${by('superseded')}）`,
            `类型 ${Object.entries(byType).map(([k, v]) => `${k}:${v}`).join(' ') || '—'}`,
            `知识形态 ${all.length ? Math.round((knowledge / all.length) * 100) : 0}%（${knowledge}/${all.length}）· 无证据 ${noEvidence}`,
            `会话摘要 ${digests.length} · schema ${SCHEMA_VERSION} · rules ${m.rulesVersion ?? '?'}`,
            `路由 ${m.route ? `${m.route.provider}/${m.route.model}` : '—'} · 上次回填 ${m.lastBackfillAt ? new Date(m.lastBackfillAt).toISOString().slice(0, 16) : 'never'}`,
          ]

          if (entry.readOnly) {
            lines.push('备份：跳过（只读模式）')
          } else {
            try {
              const ts = new Date().toISOString().replace(/[:.]/g, '-')
              const dst = safeJoin(entry.ws.dir, 'backup', ts)
              fs.mkdirSync(dst, { recursive: true })
              for (const f of ['items.jsonl', 'manifest.json', 'workspace.json']) {
                try { fs.copyFileSync(path.join(entry.ws.dir, f), path.join(dst, f)) } catch { /* 缺失跳过 */ }
              }
              lines.push(`备份 ${dst}`)
            } catch (e) {
              lines.push(`备份失败：${e?.message ?? e}`)
            }
          }
          return { kind: 'success', text: lines.join('\n') }
        }

        /* 6. 清除：删掉本工作区全部记忆（等于不使用记忆） */
        if (cmd === 'clear') {
          if (!parts.includes('--yes')) {
            return { kind: 'error', text: '这会删除本工作区的全部记忆（不可恢复）。确认执行：/memory clear --yes' }
          }
          const dir = entry.ws.dir
          try {
            fs.rmSync(dir, { recursive: true, force: true })
          } catch (e) {
            return { kind: 'error', text: `清除失败：${e?.message ?? e}` }
          }
          registry.delete(entry.ws.root)
          trace('storage:clear', { dir, key: entry.ws.key })
          return { kind: 'success', text: `已清空 ${dir}\n本工作区没有记忆，插件不再注入任何历史内容。` }
        }

        return { kind: 'error', text: '可用命令：brief | review | export | storage | doctor | clear' }
      },
    }
    ctx.effect(() => {
      const disposers = ['workmemory', 'memory'].map((name) => {
        try { return ctx.commands.register({ ...commandDef, name }) } catch { return undefined }
      })
      return () => { for (const d of disposers) { try { d?.() } catch { /* noop */ } } }
    }, 'workmemory.command()')
  } catch (e) {
    // 命令服务缺失时不影响主链路
  }

  /* ── 工具（C）：动态 import，避免 workspace 下解析不到 @deepseek-ai/* ── */
  ctx.effect(() => {
    let dispose
    void (async () => {
      try {
        const { makeRecallTool, makeStatusTool, makeTimelineTool, makeTaskTool } = await import('./tools.js')
        const resolveStore = (agent) => ensureWorkspace(agent?.session?.header?.cwd)
        dispose = [
          ctx.tools.register(makeRecallTool(resolveStore, pickTaskForEntry)),
          ctx.tools.register(makeStatusTool(resolveStore)),
          ctx.tools.register(makeTimelineTool(resolveStore)),
          ctx.tools.register(makeTaskTool(resolveStore, pickTaskForEntry)),
        ]
        trace('tool:registered', { names: ['memory_recall', 'memory_status', 'memory_timeline', 'memory_task'] })
      } catch (e) {
        trace('tool:error', { message: String(e?.message ?? e).slice(0, 200) })
      }
    })()
    return () => {
      try {
        for (const d of Array.isArray(dispose) ? dispose : [dispose]) d?.()
      } catch { /* noop */ }
    }
  }, 'workmemory.tools()')

  /* ── 诊断：ctx.fs 运行时写入（M0 遗留项） ──────────────── */
  if (config.diagnostics.fsProbe) {
    ctx.on('session/created', (session) => {
      try {
        const entry = ensureWorkspace(session?.header?.cwd)
        if (!entry) return
        void probeFs(ctx, entry)
      } catch { /* noop */ }
    })
  }

  async function probeFs(ctx, entry) {
    if (entry.fsProbed) return
    entry.fsProbed = true
    const fsSvc = ctx.get('fs')
    if (!fsSvc) {
      entry.logger.warn('fs service missing; skip probe')
      return
    }
    const targetPath = `${entry.ws.dir}/.fs-probe.txt`
    try {
      const target = await fsSvc.resolve(targetPath, { cwd: entry.ws.root })
      await fsSvc.writeText(target, `probe ${Date.now()}`)
      const back = await fsSvc.readText(target)
      const ok = typeof back === 'string' && back.startsWith('probe ')
      entry.logger.info(`fs probe ok=${ok} target=${target?.targetKey ?? 'n/a'}`)
      updateManifest(entry.ws.dir, (m) => { m.stats.fsProbe = { ok, at: Date.now() } })
    } catch (e) {
      entry.logger.warn(`fs probe failed code=${e?.code ?? 'n/a'} msg=${e?.message ?? e}`)
      updateManifest(entry.ws.dir, (m) => { m.stats.fsProbe = { ok: false, code: e?.code ?? null, at: Date.now() } })
    }
  }

  ctx.logger?.info?.('workmemory loaded')
}

/** 读 JSONL 文件为数组（缺失返回空）。 */
function readJsonlFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}
