/**
 * 阶段 A 离线自测：用假 ctx / 假 sessionQuery 驱动真实插件逻辑。
 *   node packages/workmemory/test/offline.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-a-'))
const now = Date.now()

const sessions = new Map([
  ['s1', {
    header: { id: 's1', cwd: root, createdAt: now - 2 * 864e5, delegationDepth: 0 },
    live: false, persisted: true,
    events: [
      { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: '开始搭索引器' }], source: { kind: 'user' } } },
      { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '索引器已完成，下一步做简报' }] } } },
      { seq: 2, type: 'turn/end', data: {} },
    ],
  }],
  ['s0', {
    header: { id: 's0', cwd: root, createdAt: now - 5 * 864e5, delegationDepth: 1 },
    live: false, persisted: true,
    events: [{ seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: '子 agent 会话，应被排除' }], source: { kind: 'user' } } }],
  }],
])

const handlers = new Map()
let commandDef
let contextDef
const writes = []

const fakeQuery = {
  async filterSessions(filters) {
    const cwds = filters.find((f) => f.kind === 'cwd')?.values ?? []
    return [...sessions.values()].filter((s) => cwds.includes(s.header.cwd))
  },
  async readSession(id) {
    const s = sessions.get(id)
    return { events: s.events, cursor: s.events.length ? s.events.at(-1).seq : -1 }
  },
}

const fakeFs = {
  async resolve(p) { return { targetKey: p, displayPath: p } },
  async writeText(t, s) { writes.push({ p: t.targetKey, s }) },
  async readText(t) { const hit = writes.filter((w) => w.p === t.targetKey).at(-1); return hit ? hit.s : '' },
}

// B2：假的 LLM —— 一条真实引用 + 一条编造引用
const llmCalls = []
const fakeLlm = {
  async *stream(opts) {
    llmCalls.push(opts)
    const payload = {
      items: [
        { type: 'decision', text: '采用 JSONL 作为持久化存储', importance: 'high', evidence: [{ seq: 11, quote: '改成用 JSONL 作为存储方案' }] },
        { type: 'gotcha', text: '构建时会报 EPERM', importance: 'medium', evidence: [{ seq: 13, quote: '构建报错 EPERM，踩坑了' }] },
        // 编造引用：原文里没有这句话
        { type: 'open', text: '需要确认是否支持 32K', importance: 'medium', evidence: [{ seq: 11, quote: '完全不存在的一句话' }] },
      ],
    }
    yield { type: 'text-delta', index: 0, text: JSON.stringify(payload) }
    yield { type: 'finish', finish: { kind: 'stop' } }
  },
}

const ctx = {
  // 插件直接使用 ctx.systemPrompt / ctx.commands；sessionQuery / fs / llm 走 ctx.get()
  systemPrompt: { context: (d) => { contextDef = d; return () => {} } },
  commands: { register: (d) => { commandDef = d; return () => {} } },
  get: (n) => ({ sessionQuery: fakeQuery, fs: fakeFs, llm: fakeLlm }[n]),
  on: (name, fn) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn) },
  effect: (fn) => { fn() },
  logger: { info() {}, warn() {}, error() {} },
}

apply(ctx, { workspace: { root }, ingest: { historyDays: 30 }, distill: { debounceMs: 50, autoBackfill: false } })

const emit = (name, ...args) => (handlers.get(name) ?? []).forEach((fn) => fn(...args))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); if (!ok) console.error('FAIL', name, detail) }

const dir = path.join(root, '.dsh', 'memory')
const session = { header: { id: 's1', cwd: root, createdAt: now - 2 * 864e5, delegationDepth: 0 } }

emit('session/created', session)
await sleep(300)

check('identity created', fs.existsSync(path.join(dir, 'workspace.json')))
check('manifest created', fs.existsSync(path.join(dir, 'manifest.json')))
check('digest for root session', fs.existsSync(path.join(dir, 'digest', 's1.json')))
check('subagent excluded', !fs.existsSync(path.join(dir, 'digest', 's0.json')))

const digest = JSON.parse(fs.readFileSync(path.join(dir, 'digest', 's1.json'), 'utf8'))
check('digest user text', digest.userText.includes('开始搭索引器'), digest.userText)
check('digest assistant text', digest.assistantText.includes('索引器已完成'), digest.assistantText)
check('digest turns', digest.turns === 1, digest.turns)

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
check('cursor advanced', manifest.cursors.s1 === 2, manifest.cursors)
check('fs probe recorded', manifest.stats.fsProbe?.ok === true, manifest.stats.fsProbe)

// 简报（运行时上下文 provider）
const brief = contextDef.text({ agent: { session } })
check('brief non-empty', brief.length > 20)
check('brief header', brief.includes('WorkMemory'))
check('brief mentions last work', brief.includes('开始搭索引器'), brief.slice(0, 200))
check('brief within budget', brief.length <= 3601, brief.length)

// 命令
const status = await commandDef.handler({ agent: { session }, rawInput: 'status' })
check('status ok', status.kind === 'success' && status.text.includes('workspace:'), status.text)
const briefCmd = await commandDef.handler({ agent: { session }, rawInput: 'brief' })
check('brief cmd ok', briefCmd.kind === 'success' && briefCmd.text.includes('WorkMemory'))

// 增量：新事件 → 摘要更新（等防抖）
emit('session/event', session, { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: '继续做简报' }], source: { kind: 'user' } } })
emit('session/event', session, { seq: 4, type: 'turn/end', data: {} })
await sleep(1900)
const digest2 = JSON.parse(fs.readFileSync(path.join(dir, 'digest', 's1.json'), 'utf8'))
check('incremental update', digest2.userText.includes('继续做简报'), digest2.userText)
check('incremental turns', digest2.turns === 2, digest2.turns)
check('incremental cursor', digest2.seq === 4, digest2.seq)

// 幂等：重复回填不重复计数
const again = await commandDef.handler({ agent: { session }, rawInput: 'backfill' })
check('backfill idempotent', again.kind === 'success', again.text)

/* ── B1：规则抽取 + 记忆项 ─────────────────────────────────── */
const userEvent = (seq, text) => ({ seq, type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })
emit('session/event', session, userEvent(10, '以后统一用 pnpm 管理依赖'))
emit('session/event', session, userEvent(11, '改成用 JSONL 作为存储方案'))
emit('session/event', session, userEvent(12, '不允许引入数据库和 Redis'))
emit('session/event', session, userEvent(13, '构建报错 EPERM，踩坑了'))
// 运行时快照不得被当成用户输入
emit('session/event', session, { seq: 14, type: 'user/message', data: { content: [{ type: 'text', text: '以后都用 redis' }], source: { kind: 'runtime-context' } } })
// 助手陈述在 B1 不抽取（留给 B2 的 LLM 蒸馏）
emit('session/event', session, { seq: 15, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '建议改用 Redis 缓存层' }] } } })
// 噪声：粘贴文档 / 列表片段 / 冒号片段
emit('session/event', session, userEvent(16, `## 方案\n\n- 不能违反哪些约束\n- 下一步：\n\n${'很长的文档内容。'.repeat(60)}`))
emit('session/event', session, userEvent(17, '- 不能违反哪些约束'))
emit('session/event', session, userEvent(18, '下一步：'))
await sleep(1900)

const itemsFile = path.join(dir, 'items.jsonl')
const items = fs.existsSync(itemsFile) ? fs.readFileSync(itemsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const latest = new Map()
for (const i of items) latest.set(i.id, i)
const vals = [...latest.values()]
const pick = (t) => vals.filter((i) => i.type === t)

check('items persisted', vals.length > 0, vals.length)
check('preference extracted', pick('preference').some((i) => i.text.includes('pnpm')), pick('preference').map((i) => i.text))
check('decision extracted', pick('decision').some((i) => i.text.includes('JSONL')), pick('decision').map((i) => i.text))
check('constraint extracted', pick('constraint').some((i) => i.text.includes('数据库')), pick('constraint').map((i) => i.text))
check('gotcha extracted', pick('gotcha').length > 0, pick('gotcha').map((i) => i.text))
check('runtime snapshot ignored', !vals.some((i) => i.text.includes('redis') && i.authority === 'user_explicit'), vals.map((i) => `${i.type}:${i.text.slice(0, 12)}`))
check('assistant not extracted in B1', !vals.some((i) => i.authority === 'assistant'), vals.map((i) => i.authority))
check('every item has evidence', vals.every((i) => i.evidence?.length > 0), vals.length)
check('no fragment items', !vals.some((i) => /[：:]$/.test(i.text) || /^([-*+>]|\d+[.)、]|#{1,6}\s)/.test(i.text)), vals.map((i) => i.text))
check('no doc-paste items', !vals.some((i) => i.text.length > 200), Math.max(...vals.map((i) => i.text.length)))
check('duplicate merged', (() => {
  const before = vals.length
  emit('session/event', session, userEvent(19, '以后统一用 pnpm 管理依赖'))
  const after = fs.readFileSync(itemsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const ids = new Set(after.map((x) => x.id))
  return ids.size === before
})(), vals.length)

const briefWithItems = contextDef.text({ agent: { session } })
check('brief has constraint section', briefWithItems.includes('约束：'), briefWithItems.slice(0, 300))
check('brief has decision section', briefWithItems.includes('关键决策：'))
check('brief cites item id', /\[M[0-9a-z]{4}/.test(briefWithItems), briefWithItems.slice(0, 400))

const itemsCmd = await commandDef.handler({ agent: { session }, rawInput: 'items decision' })
check('items command', itemsCmd.kind === 'success' && itemsCmd.text.includes('decision'), itemsCmd.text.slice(0, 200))

// 子句级抽取：一条消息里塞多个意图时，只取命中子句
emit('session/event', session, userEvent(30, '@tldr需求案例文档.md 根据该文档方案，实现 DSH 插件，作为记忆插件 还是查询改写插件好，所有实现不依赖单独第三方服务 ，比如数据库，redis 等，给出方案'))
await sleep(100)
{
  const lines = fs.readFileSync(itemsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const m = new Map()
  for (const i of lines) m.set(i.id, i)
  const c = [...m.values()].find((i) => i.type === 'constraint' && i.text.includes('不依赖'))
  check('clause-level extraction', !!c && c.text.length < 40 && !c.text.includes('根据该文档方案'), c?.text)
}

/* ── B2：LLM 蒸馏 + 证据逐字校验 ───────────────────────────── */
emit('session/event', session, { seq: 20, type: 'request/context', data: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
emit('session/event', session, { seq: 21, type: 'turn/end', data: { turn: 99 } })
await sleep(500)

const finalItems = (() => {
  const lines = fs.readFileSync(itemsFile, 'utf8').trim().split('\n').filter(Boolean)
  const m = new Map()
  for (const l of lines) { const i = JSON.parse(l); m.set(i.id, i) }
  return [...m.values()]
})()
const distilled = finalItems.filter((i) => i.confidence === 0.8)

/* ── 锁：持有者进程已死必须立即抢占（实机重启后被只读 2 分钟的 bug） ── */
{
  const { acquireLock } = await import('../lib/store.js')
  const dir2 = path.join(root, 'locktest')
  fs.mkdirSync(dir2, { recursive: true })
  fs.writeFileSync(path.join(dir2, 'lock'), JSON.stringify({ pid: 999999, host: process.env.COMPUTERNAME ?? 'local', startedAt: Date.now(), leaseExpiresAt: Date.now() + 600_000 }))
  const got = acquireLock(dir2)
  check('dead-holder lock takeover', got.ok === true && got.readOnly === false, { readOnly: got.readOnly })
  got.release?.()

  // 活着的持有者 → 只读
  const dir3 = path.join(root, 'locktest2')
  fs.mkdirSync(dir3, { recursive: true })
  fs.writeFileSync(path.join(dir3, 'lock'), JSON.stringify({ pid: process.pid, host: process.env.COMPUTERNAME ?? 'local', startedAt: Date.now(), leaseExpiresAt: Date.now() + 600_000 }))
  const blocked = acquireLock(dir3)
  check('live-holder blocks', blocked.ok === false && blocked.readOnly === true, { readOnly: blocked.readOnly })
  blocked.release?.()
}

/* ── v3.1.1 P1-2：锁 fencing token ────────────────────────── */
{
  const { acquireLock, loadManifest } = await import('../lib/store.js')
  const ldir = path.join(root, 'lock-epoch')
  fs.mkdirSync(ldir, { recursive: true })
  const a = acquireLock(ldir)
  a.release()
  const b = acquireLock(ldir)
  check('lock token increments', a.token === 1 && b.token === 2, { t1: a.token, t2: b.token, epoch: loadManifest(ldir).lockEpoch })
  b.release()

  const { ItemsStore } = await import('../lib/items.js')
  const idir = path.join(root, 'items-fence')
  let allow = true
  const st = new ItemsStore({ dir: idir, logger: { warn() {} }, guard: () => allow })
  const ev = (seq) => [{ sessionId: 's', seq, role: 'user', quote: '测试引用片段', assertionType: 'explicit' }]
  const okAdd = st.add({ type: 'state', text: '允许写入的条目', status: 'active', authority: 'user_explicit', evidence: ev(1) })
  check('guarded append works', okAdd.kind !== 'rejected', okAdd.kind)
  allow = false
  st.add({ type: 'state', text: '不应写入的条目', status: 'active', authority: 'user_explicit', evidence: ev(2) })
  check('fenced append blocked', st.list().length === 1, st.list().map((i) => i.text))
}

check('distill called', llmCalls.length > 0, llmCalls.length)
check('distill produced items', distilled.length >= 2, distilled.map((i) => i.text))
check('distill item uses verified quote', distilled.every((i) => i.evidence.every((e) => e.quote.length > 0)), distilled.map((i) => i.evidence))
check('decision stays pending', distilled.some((i) => i.type === 'decision' && i.status === 'pending'), distilled.map((i) => `${i.type}/${i.status}`))
check('gotcha auto-active', distilled.some((i) => i.type === 'gotcha' && i.status === 'active'), distilled.map((i) => `${i.type}/${i.status}`))
check('fabricated quote dropped', !finalItems.some((i) => i.text.includes('32K')), finalItems.map((i) => i.text).slice(-5))

/* ── C：检索（memory_recall 的打分内核） ───────────────────── */
{
  const { search, tokenize } = await import('../lib/retrieval.js')
  const now = Date.now()
  const corpus = [
    { id: 'a', type: 'constraint', status: 'active', text: '所有实现不依赖单独第三方服务', importance: 'critical', topics: ['第三方', '服务'], updatedAt: now },
    { id: 'b', type: 'decision', status: 'active', text: '改用 pnpm 管理依赖', importance: 'high', topics: ['pnpm'], updatedAt: now },
    { id: 'c', type: 'gotcha', status: 'superseded', text: 'pnpm 安装时报 EPERM', importance: 'medium', topics: ['pnpm'], updatedAt: now },
  ]
  check('tokenize cjk bigram', tokenize('依赖服务').size > 0, [...tokenize('依赖服务')])
  check('search finds constraint', search(corpus, '不依赖第三方')[0]?.item.id === 'a', search(corpus, '不依赖第三方').map((x) => x.item.id))
  check('search finds decision', search(corpus, 'pnpm 依赖')[0]?.item.id === 'b', search(corpus, 'pnpm 依赖').map((x) => x.item.id))
  check('search skips superseded', !search(corpus, 'EPERM').some((x) => x.item.id === 'c'), search(corpus, 'EPERM').map((x) => x.item.id))
  check('empty query returns none', search(corpus, '   ').length === 0)
}

/* ── C：近似去重（否定守卫） ──────────────────────────────── */
{
  const { ItemsStore } = await import('../lib/items.js')
  const store = new ItemsStore({ dir: path.join(root, 'items-near'), logger: { warn() {} } })
  const ev = (seq) => [{ sessionId: 's1', seq, role: 'user', quote: '不依赖第三方服务', assertionType: 'explicit' }]
  const a1 = store.add({ type: 'constraint', text: '所有实现不依赖单独第三方服务', status: 'active', authority: 'user_explicit', evidence: ev(1) })
  const a2 = store.add({ type: 'constraint', text: '不依赖单独的第三方服务（如数据库、Redis 等）', status: 'pending', authority: 'assistant', evidence: ev(2) })
  check('near-duplicate merged', a2.kind === 'merged-near' && a2.item.id === a1.item.id, { kind: a2.kind })
  check('near merge keeps one active item', store.list().length === 1 && store.list()[0].status === 'active', store.list().map((i) => i.status))

  const p1 = store.add({ type: 'decision', text: '构建时使用 pnpm', status: 'active', authority: 'user_explicit', evidence: ev(3) })
  const p2 = store.add({ type: 'decision', text: '构建时不使用 pnpm', status: 'active', authority: 'user_explicit', evidence: ev(4) })
  check('negation not merged', p2.kind === 'added' && p2.item.id !== p1.item.id, p2.kind)

  // D：entity/property 冲突 → 旧项 superseded
  const v1 = store.add({ type: 'decision', text: 'MongoDB 用 4.4', entity: 'mongodb', property: 'version', value: '4.4', status: 'active', authority: 'user_explicit', evidence: ev(5) })
  const v2 = store.add({ type: 'decision', text: 'MongoDB 升级到 7.0', entity: 'mongodb', property: 'version', value: '7.0', status: 'active', authority: 'user_explicit', evidence: ev(6) })
  check('supersede on entity/property', v2.item.supersedes?.includes(v1.item.id) === true, v2.item.supersedes)
  check('old item superseded', store.list().find((i) => i.id === v1.item.id)?.status === 'superseded', store.list().find((i) => i.id === v1.item.id)?.status)

  // 同实体不同属性 → 不冲突
  const v3 = store.add({ type: 'decision', text: 'MongoDB 端口改成 27018', entity: 'mongodb', property: 'port', value: '27018', status: 'active', authority: 'user_explicit', evidence: ev(7) })
  check('different property no supersede', !v3.item.supersedes, v3.item.supersedes)
}

/* ── D：空响应视为无可提炼 ────────────────────────────────── */
{
  const { distill } = await import('../lib/distiller.js')
  const empty = async function* () { yield { type: 'finish', finish: { kind: 'stop' } } }
  const res = await distill({ route: { provider: 'p', model: 'm' }, recent: [{ seq: 1, role: 'user', text: 'hi' }], stream: empty })
  check('empty stream → no candidates', (res.candidates ?? []).length === 0, res)
  check('empty stream → empty rawHead', !res.rawHead, res.rawHead)
}

/* ── 助手给出的技术结论也要能落库 ─────────────────────────── */
{
  const { distill } = await import('../lib/distiller.js')
  const events = [
    { seq: 1, role: 'user', text: '为什么写文件失败', sessionId: 's' },
    { seq: 2, role: 'assistant', text: 'ctx.fs 在工作区内写入会返回 FS_SANDBOX_DENIED', sessionId: 's' },
  ]
  const stream = async function* () {
    yield { type: 'text-delta', text: JSON.stringify({ items: [{ type: 'gotcha', text: 'ctx.fs 在工作区内写入会被拒绝', evidence: [{ seq: 2, quote: 'ctx.fs 在工作区内写入会返回 FS_SANDBOX_DENIED' }] }] }) }
    yield { type: 'finish', finish: { kind: 'stop' } }
  }
  const res = await distill({ route: { provider: 'p', model: 'm' }, recent: events, stream })
  check('assistant technical gotcha captured', res.candidates.length === 1 && res.candidates[0].authority === 'assistant' && res.candidates[0].status === 'active', res.candidates)
}

/* ── 截断的 JSON 也要能救回完整条目 ───────────────────────── */
{
  const { parseItems } = await import('../lib/distiller.js')
  const truncated = '{"items":[{"type":"gotcha","text":"A"},{"type":"decision","text":"B"},{"type":"open","te'
  const got = parseItems(truncated)
  check('truncated json salvaged', got.length === 2 && got[0].text === 'A' && got[1].text === 'B', got)
  check('well-formed json still parsed', parseItems('{"items":[{"type":"state","text":"C"}]}').length === 1)
}

/* ── v3.1.1 P1-3：蒸馏标注任务归属 ────────────────────────── */
{
  const { distill } = await import('../lib/distiller.js')
  const tasks = [{ id: 'task_a', title: '排查 Jenkins' }, { id: 'task_b', title: 'MongoDB 迁移' }]
  const events = [{ seq: 1, role: 'user', text: 'jenkins 流水线挂了', sessionId: 's1' }]
  const mk = (taskId) => async function* () {
    yield { type: 'text-delta', text: JSON.stringify({ items: [{ type: 'gotcha', text: '流水线挂了', taskId, evidence: [{ seq: 1, quote: 'jenkins 流水线挂了' }] }] }) }
    yield { type: 'finish', finish: { kind: 'stop' } }
  }
  const okRes = await distill({ route: { provider: 'p', model: 'm' }, recent: events, stream: mk('task_a'), tasks })
  check('distill keeps valid taskId', okRes.candidates[0]?.taskId === 'task_a', okRes.candidates[0])
  const badRes = await distill({ route: { provider: 'p', model: 'm' }, recent: events, stream: mk('task_ghost'), tasks })
  check('distill rejects unknown taskId', badRes.candidates[0]?.taskId == null, badRes.candidates[0])
}

/* ── v3.1.1 P2-c：schemaV2 的 taskUpdates（默认关闭） ─────── */
{
  const { distill, parseTaskUpdates, buildMessages } = await import('../lib/distiller.js')
  const tasks = [{ id: 'task_a', title: '排查 Jenkins' }]
  const events = [{ seq: 1, role: 'user', text: 'jenkins 修好了，下一步看 maven', sessionId: 's1' }]
  const payload = JSON.stringify({
    items: [],
    taskUpdates: [
      { taskId: 'task_a', progress: 'jenkins 侧已修好', nextSteps: '检查 maven 版本' },
      { taskId: 'task_a', status: 'done' },
      { taskId: 'task_ghost', progress: '不存在任务' },
    ],
  })
  const mk2 = async function* () { yield { type: 'text-delta', text: payload }; yield { type: 'finish', finish: { kind: 'stop' } } }

  const off = await distill({ route: { provider: 'p', model: 'm' }, recent: events, stream: mk2, tasks })
  check('schemaV2 off → no taskUpdates', (off.taskUpdates ?? []).length === 0, off.taskUpdates)

  const on = await distill({ route: { provider: 'p', model: 'm' }, recent: events, stream: mk2, tasks, schemaV2: true })
  check('schemaV2 on → updates validated', on.taskUpdates.length === 1 && on.taskUpdates[0].progress.includes('已修好'), on.taskUpdates)
  check('schemaV2 rejects done', !on.taskUpdates.some((u) => u.status === 'done'), on.taskUpdates)

  const parsed = parseTaskUpdates(payload, tasks)
  check('parseTaskUpdates drops unknown task', parsed.length === 1, parsed)

  const v2Prompt = buildMessages(events, tasks, true)[0].content[0].text
  check('v2 prompt asks taskUpdates', v2Prompt.includes('taskUpdates') && v2Prompt.includes('绝对不要输出 done'))
  const v1Prompt = buildMessages(events, tasks, false)[0].content[0].text
  check('v1 prompt stays clean', !v1Prompt.includes('taskUpdates'), v1Prompt.slice(-120))
}

/* ── 淘汰：只归档失效且过期的条目 ─────────────────────────── */
{
  const { ItemsStore } = await import('../lib/items.js')
  const dirC = path.join(root, 'items-compact')
  const store = new ItemsStore({ dir: dirC, logger: { warn() {} } })
  const old = Date.now() - 200 * 864e5
  const ev = (seq) => [{ sessionId: 's1', seq, role: 'user', quote: '测试引用片段', assertionType: 'explicit' }]
  store.add({ type: 'decision', text: '旧的无效决策内容', status: 'invalid', authority: 'user_explicit', evidence: ev(1) }, old)
  store.add({ type: 'constraint', text: '仍然有效的约束内容', status: 'active', authority: 'user_explicit', evidence: ev(2) }, old)
  const r = store.compact({ olderThanDays: 90 })
  check('compact archives invalid', r.archived === 1 && store.list().length === 1, r)
  check('archive file written', fs.existsSync(path.join(dirC, 'archive')), fs.readdirSync(dirC))
  check('active survives compaction', store.list()[0].status === 'active', store.list()[0].status)
}

// 字段级合并：空增量不得覆盖回填结果（阶段 A 实测踩到的竞态）
{
  const { mergeDigest, emptyDigest } = await import('../lib/ingest.js')
  const good = { ...emptyDigest({ id: 's9', cwd: root, createdAt: 1 }), seq: 10, turns: 3, lastTurn: 3, userText: '真实用户话', userSeq: 8, assistantText: '真实回复', assistantSeq: 9 }
  const staleEmpty = emptyDigest({ id: 's9', cwd: root, createdAt: 1 })
  const merged = mergeDigest(good, staleEmpty)
  check('merge keeps backfilled text', merged.userText === '真实用户话' && merged.assistantText === '真实回复', merged)
  check('merge keeps turns', merged.turns === 3, merged.turns)

  const newer = { ...emptyDigest({ id: 's9', cwd: root, createdAt: 1 }), seq: 20, userText: '更新的用户话', userSeq: 18, assistantText: '更新的回复', assistantSeq: 19, turns: 1 }
  const merged2 = mergeDigest(good, newer)
  check('merge prefers newer text', merged2.userText === '更新的用户话' && merged2.assistantText === '更新的回复', merged2)
  check('merge max turns', merged2.turns === 3 && merged2.seq === 20, { turns: merged2.turns, seq: merged2.seq })
}

/* ── v3.1：证据严格匹配（评审 P0-2 的反例） ───────────────── */
{
  const { quoteMatches } = await import('../lib/evidence.js')
  const src = '我们决定采用 MongoDB 7.0，不再使用 4.4'
  check('exact substring matches', quoteMatches(src, '不再使用 4.4') === true)
  check('reverse-meaning quote rejected', quoteMatches(src, '我们决定采用 MongoDB 7.0，继续使用 4.4') === false)
  check('shorter quote still ok', quoteMatches(src, '我们决定采用 MongoDB 7.0') === true)
  check('too short rejected', quoteMatches(src, '7.0') === false)
}

/* ── v3.1：规则重建只影响 rule 来源 ───────────────────────── */
{
  const { ItemsStore } = await import('../lib/items.js')
  const dirR = path.join(root, 'items-origin')
  const s = new ItemsStore({ dir: dirR, logger: { warn() {} } })
  const ev = (seq) => [{ sessionId: 's1', seq, role: 'user', quote: '测试引用片段', assertionType: 'explicit' }]
  s.add({ type: 'decision', text: '规则抽取的决策内容', origin: 'rule', status: 'active', authority: 'user_explicit', evidence: ev(1) })
  s.add({ type: 'gotcha', text: 'LLM 蒸馏的踩坑内容', origin: 'llm', status: 'active', authority: 'assistant', evidence: ev(2) })
  s.add({ type: 'constraint', text: '用户手动确认的约束', origin: 'manual', status: 'active', authority: 'user_confirmed', evidence: ev(3) })
  const dropped = s.dropWhere((i) => i.origin === 'rule')
  check('rebuild drops only rule items', dropped === 1 && s.list().length === 2, { dropped, n: s.list().length })
  check('llm and manual survive', s.list().every((i) => i.origin !== 'rule'), s.list().map((i) => i.origin))
}

/* ── v3.1：JSONL 尾部半行修复 ─────────────────────────────── */
{
  const { ItemsStore } = await import('../lib/items.js')
  const dirT = path.join(root, 'items-tail')
  fs.mkdirSync(dirT, { recursive: true })
  const good = JSON.stringify({ id: 'mem_1', text: '完整行', hash: 'h1' })
  fs.writeFileSync(path.join(dirT, 'items.jsonl'), `${good}\n{"id":"mem_2","text":"半行被截`)
  const s = new ItemsStore({ dir: dirT, logger: { warn() {} } })
  check('tail repair keeps complete lines', s.list().length === 1 && s.list()[0].id === 'mem_1', s.list().map((i) => i.id))
  const after = fs.readFileSync(path.join(dirT, 'items.jsonl'), 'utf8')
  check('tail repair truncates partial line', after.endsWith('\n') && !after.includes('半行被截'), JSON.stringify(after.slice(-20)))
}

/* ── v3.1 S2：实体层（Task 一等对象） ─────────────────────── */
{
  const { EntitiesStore } = await import('../lib/entities.js')
  const dirE = path.join(root, 'entities-test')
  const es = new EntitiesStore({ dir: dirE, logger: { warn() {} } })
  const t1 = es.createTask({ title: '排查 Jenkins 构建失败', objective: '恢复流水线', keywords: ['jenkins', 'maven'], sessionId: 's1' })
  check('task created active', t1.status === 'active' && t1.id.startsWith('task_'), t1.status)
  es.appendToTask(t1.id, 'progress', '已确认共享库加载正常')
  es.appendToTask(t1.id, 'progress', '已确认共享库加载正常')       // 同文本去重
  check('task progress dedupe', es.get(t1.id).progress.length === 1, es.get(t1.id).progress)
  es.updateTask(t1.id, { status: 'done' })
  check('task done sets closedAt', es.get(t1.id).status === 'done' && es.get(t1.id).closedAt > 0, es.get(t1.id).closedAt)
  es.bindSession(t1.id, 's2')
  check('task session bound', es.get(t1.id).sessionIds.includes('s2'), es.get(t1.id).sessionIds)
  es.snapshot(es.get(t1.id))
  check('task snapshot written', fs.existsSync(path.join(dirE, 'task.json')))
  es.snapshot(es.get(t1.id))
  const snap = JSON.parse(fs.readFileSync(path.join(dirE, 'task.json'), 'utf8'))
  check('snapshot has session pointers', 'activeSessionId' in snap && 'lastActivityAt' in snap && 'nextAction' in snap, Object.keys(snap))

  // v3.1.1 P0-2：会话指针与活动时间
  const t2 = es.createTask({ title: 'MongoDB 迁移', sessionId: 's9' })
  check('task records active session', t2.activeSessionId === 's9' && t2.lastSessionId === 's9', { a: t2.activeSessionId, l: t2.lastSessionId })
  const before = es.get(t2.id).lastActivityAt
  es.appendToTask(t2.id, 'nextSteps', '检查双写延迟')
  check('activity time moves', es.get(t2.id).lastActivityAt >= before, { before, after: es.get(t2.id).lastActivityAt })
  es.bindSession(t2.id, 's10')
  check('bind updates pointers', es.get(t2.id).activeSessionId === 's10' && es.get(t2.id).lastSessionId === 's9', { a: es.get(t2.id).activeSessionId, l: es.get(t2.id).lastSessionId })
  const todo = es.createTask({ title: '待开始的验证任务', status: 'todo', keywords: ['验证'], sessionId: 's11' })
  check('todo status supported', todo.status === 'todo', todo.status)

  // P1-1：每任务一份快照 + 内容不变跳过
  const wrote1 = es.snapshot(es.get(t2.id))
  const wrote2 = es.snapshot(es.get(t2.id))
  check('snapshot writes once', wrote1 === true && wrote2 === false, { wrote1, wrote2 })
  check('snapshot file per task', fs.existsSync(path.join(dirE, 'snapshots', `${t2.id}.json`)), fs.readdirSync(path.join(dirE, 'snapshots')).slice(0, 3))
  es.appendToTask(t2.id, 'nextSteps', '新的下一步动作')
  check('snapshot rewrites on change', es.snapshot(es.get(t2.id)) === true)
}

/* ── v3.1 S2：任务识别与进度信号（规则优先） ───────────────── */
{
  const { detectTask, progressSignal, belongsToTask } = await import('../lib/continuity.js')
  const now = Date.now()
  const tasks = [
    { id: 't1', kind: 'task', title: '排查 Jenkins 构建失败', status: 'active', keywords: ['jenkins', 'maven'], updatedAt: now },
    { id: 't2', kind: 'task', title: 'MongoDB 数据迁移', status: 'paused', keywords: ['mongodb'], updatedAt: now - 5 * 864e5 },
  ]
  check('continue-signal picks active', detectTask({ tasks, text: '继续上次那个排查', now }).task?.id === 't1', detectTask({ tasks, text: '继续上次那个排查', now }))
  check('keyword overlap picks active', detectTask({ tasks, text: 'jenkins 的 maven 构建又报错了', now }).task?.id === 't1')
  check('no live task → create', detectTask({ tasks: [], text: '帮我看看这个', now }).create === true)
  check('progress signal', progressSignal('已经修好了，测试通过')?.kind === 'progress', progressSignal('已经修好了，测试通过'))
  check('blocker signal', progressSignal('现在卡住了，报错 500')?.kind === 'blocker', progressSignal('现在卡住了，报错 500'))
  check('unrelated item filtered', belongsToTask({ text: 'MongoDB 版本 4.4', topics: [] }, tasks[0]) === false)
  check('task item kept', belongsToTask({ taskId: 't1', text: '任意' }, tasks[0]) === true)
  // v3.1.1：粘贴长文不得被当成"进度"写进任务态
  check('long paste not progress', progressSignal(`根据最新意见，给出方案：${'x'.repeat(400)}`) === undefined)
  check('progress picks shortest clause', progressSignal('先说个事\n\n已经修好了\n还有别的')?.text === '已经修好了', progressSignal('先说个事\n\n已经修好了\n还有别的'))

  // v3.1.1 P0-2：todo 不参与"延续"，但被点名时可选
  const withTodo = [
    ...tasks,
    { id: 't3', kind: 'task', title: '补充断点续跑', status: 'todo', keywords: ['断点续跑'], updatedAt: now },
  ]
  check('continuation skips todo', detectTask({ tasks: withTodo, text: '继续上次那个排查', now }).task?.id === 't1', detectTask({ tasks: withTodo, text: '继续上次那个排查', now }).task?.id)
  check('todo matched by keyword', detectTask({ tasks: withTodo, text: '把断点续跑补上', now }).task?.id === 't3', detectTask({ tasks: withTodo, text: '把断点续跑补上', now }))
  check('unrelated still picks active', detectTask({ tasks: withTodo, text: '今天天气不错', now }).task?.id === 't1')
  // v3.1.1：「继续 + 点名」应切到被点名的任务，而不是死守 active
  check('continue + named switches', detectTask({ tasks, text: '继续 mongodb 那边', now }).task?.id === 't2', detectTask({ tasks, text: '继续 mongodb 那边', now }))
}

/* ── v3.1 S2：简报含任务态 ────────────────────────────────── */
{
  const { buildBrief } = await import('../lib/brief.js')
  const task = { id: 't1', title: '排查 Jenkins 构建失败', status: 'active', objective: '恢复流水线', progress: ['已确认共享库加载正常'], nextSteps: ['检查构建 JDK'], blockers: [] }
  const out = buildBrief({ ws: { root }, digests: [], items: [], config: { brief: { enabled: true } }, task })
  check('brief has task section', out.includes('当前任务：') && out.includes('排查 Jenkins'), out.slice(0, 200))
  check('brief has next steps', out.includes('下一步：'), out)
  const noTask = buildBrief({ ws: { root }, digests: [], items: [], config: { brief: { enabled: true } } })
  check('brief without task still ok', !noTask.includes('当前任务：'), noTask.slice(0, 80))
}

/* ── v3.1 S3：任务亲和度 + 无内容不注入 ───────────────────── */
{
  const { taskAffinity } = await import('../lib/continuity.js')
  const { search } = await import('../lib/retrieval.js')
  const now = Date.now()
  const task = { id: 't1', title: '排查 Jenkins 构建失败', keywords: ['jenkins'], startedAt: now - 864e5 }
  check('affinity same task = 1', taskAffinity({ taskId: 't1' }, task, now) === 1)
  check('affinity other task low', taskAffinity({ taskId: 't2', text: 'jenkins 报错' }, task, now) <= 0.1, taskAffinity({ taskId: 't2', text: 'jenkins 报错' }, task, now))
  check('affinity keyword overlap', taskAffinity({ text: 'jenkins 流水线卡住' }, task, now) >= 0.4, taskAffinity({ text: 'jenkins 流水线卡住' }, task, now))

  const items = [
    { id: 'a', type: 'gotcha', status: 'active', text: 'jenkins 构建失败', taskId: 't1', importance: 'high', updatedAt: now },
    { id: 'b', type: 'gotcha', status: 'active', text: 'jenkins 构建失败', taskId: 't2', importance: 'high', updatedAt: now },
  ]
  const hits = search(items, 'jenkins 构建失败', { task, limit: 2 })
  check('task-aware search ranks current task first', hits[0]?.item.id === 'a', hits.map((h) => h.item.id))

  const { buildBrief } = await import('../lib/brief.js')
  const empty = buildBrief({ ws: { root }, digests: [], items: [], config: { brief: { enabled: true } } })
  check('empty brief when nothing to inject', empty === '', JSON.stringify(empty))
}

/* ── v3.1.1 P2-a：动态召回触发与渲染 ─────────────────────── */
{
  const { wantsRecall } = await import('../lib/continuity.js')
  const { buildBrief } = await import('../lib/brief.js')
  check('recall trigger on history question', wantsRecall('我们之前定了什么约束？') === true)
  check('recall trigger on why-question', wantsRecall('为什么当初选 JSONL？') === true)
  check('no trigger on task action', wantsRecall('把这个函数改成异步') === false)
  check('no trigger on long paste', wantsRecall(`之前${'x'.repeat(400)}`) === false)

  const hits = [{ id: 'mem_aaa', type: 'decision', status: 'active', text: '采用 JSONL 存储', updatedAt: Date.now() }]
  const withHits = buildBrief({ ws: { root }, digests: [], items: [], config: { brief: { enabled: true } }, recallHits: hits })
  check('brief renders recall section', withHits.includes('相关历史（自动召回）') && withHits.includes('JSONL'), withHits.slice(0, 200))
  const noHits = buildBrief({ ws: { root }, digests: [], items: [], config: { brief: { enabled: true } }, recallHits: [] })
  check('no recall section without hits', !noHits.includes('自动召回'), JSON.stringify(noHits))
}

/* ── v3.1.1 P2-b：临时决策不取代长期，且会过期失效 ────────── */
{
  const { ItemsStore } = await import('../lib/items.js')
  const { search } = await import('../lib/retrieval.js')
  const dirTmp = path.join(root, 'items-temp')
  const st = new ItemsStore({ dir: dirTmp, logger: { warn() {} } })
  const ev = (seq) => [{ sessionId: 's', seq, role: 'user', quote: '测试引用片段', assertionType: 'explicit' }]
  const base = st.add({ type: 'decision', text: 'MongoDB 用 7.0', entity: 'mongodb', property: 'version', value: '7.0', status: 'active', authority: 'user_explicit', evidence: ev(1) })
  const tmp = st.add({ type: 'decision', text: '临时先用 4.4', entity: 'mongodb', property: 'version', value: '4.4', decisionScope: 'temporary', overrideUntil: Date.now() - 1000, status: 'active', authority: 'user_explicit', evidence: ev(2) })
  check('temporary does not supersede', st.get(base.item.id).status === 'active', st.get(base.item.id).status)
  check('temporary item created', tmp.kind === 'added' && tmp.item.decisionScope === 'temporary', tmp.kind)

  const swept = st.sweepExpired()
  check('expired temporary swept', swept === 1 && st.get(tmp.item.id).status === 'stale', { swept, status: st.get(tmp.item.id).status })
  const hits = search(st.list(), 'mongodb 版本', { limit: 5 })
  check('stale excluded from search', !hits.some((h) => h.item.id === tmp.item.id), hits.map((h) => h.item.id))
}

/* ── v3.1.1 P0-1：历史回填队列 ────────────────────────────── */
{
  const { BackfillQueue } = await import('../lib/backfill.js')
  const qdir = path.join(root, 'queue-test')
  const q = new BackfillQueue({ dir: qdir, logger: { warn() {} } })
  const now2 = Date.now()
  const found = [
    { header: { id: 'old', createdAt: now2 - 200 * 864e5 } },
    { header: { id: 'recent', createdAt: now2 - 864e5 } },
    { header: { id: 'mid', createdAt: now2 - 100 * 864e5 } },
  ]
  check('queue discover', q.discover(found) === 3, q.summary())
  check('queue discover dedupe', q.discover(found) === 0)
  const batch = q.nextBatch({ limit: 2 })
  check('queue priority window first', batch[0].sessionId === 'recent', batch.map((b) => b.sessionId))
  q.markChunk('recent', 100)
  q.markDone('recent')
  q.markFailed('old', 'boom')
  const reloaded = new BackfillQueue({ dir: qdir, logger: { warn() {} } })
  check('queue persists state', reloaded.summary().completed === 1 && reloaded.summary().retryWait === 1, reloaded.summary())
  check('queue retry failed', reloaded.retryFailed() === 1 && reloaded.summary().pending === 2, reloaded.summary())
}

/* 队列处理：预算生效、从最近往前、可续跑 */
{
  const { Ingestor } = await import('../lib/ingest.js')
  const { ItemsStore } = await import('../lib/items.js')
  const wdir = path.join(root, 'queue-ws')
  fs.mkdirSync(wdir, { recursive: true })
  fs.writeFileSync(path.join(wdir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, createdAt: Date.now(), cursors: {}, itemCursors: {}, stats: {}, route: { provider: 'p', model: 'm' } }))

  const events = []
  for (let i = 1; i <= 60; i += 1) {
    events.push(i % 2
      ? { seq: i, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `消息 ${i} 关于 jenkins` }] } }
      : { seq: i, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `回复 ${i} 关于构建` }] } } })
  }
  const sessions2 = new Map([['s1', { header: { id: 's1', cwd: wdir, createdAt: Date.now() - 3600_000, delegationDepth: 0 }, events }]])
  const fakeQ2 = {
    async filterSessions() { return [...sessions2.values()] },
    async readSession(id) { return { events: sessions2.get(id).events } },
  }
  let llmCalls = 0
  const fakeLlm2 = {
    async *stream() {
      llmCalls += 1
      yield { type: 'text-delta', text: JSON.stringify({ items: [{ type: 'gotcha', text: '队列测试条目', evidence: [{ seq: 59, quote: '消息 59 关于 jenkins' }] }] }) }
      yield { type: 'finish', finish: { kind: 'stop' } }
    },
  }
  const items2 = new ItemsStore({ dir: wdir, logger: { warn() {} } })
  const ing = new Ingestor({
    config: { distill: { maxEvents: 40, enabled: true, maxCandidates: 6 }, rules: { enabled: false }, ingest: {} },
    logger: { info() {}, warn() {} },
    getSessionQuery: () => fakeQ2,
    itemsFor: () => items2,
    getLlm: () => fakeLlm2,
  })
  const ws2 = { dir: wdir, root: wdir, workspaceId: 'ws_test' }

  const run1 = await ing.processQueue(ws2, { maxSessions: 1, maxChunks: 1 })
  check('queue run respects chunk budget', run1.chunks === 1 && llmCalls === 1, run1)
  check('queue run leaves pending', run1.pending >= 1, run1)

  const run2 = await ing.processQueue(ws2, { maxSessions: 1, maxChunks: 1 })
  check('queue resumes next chunk', run2.chunks === 1 && llmCalls === 2, run2)
  check('queue advanced chunks total', run2.chunks === 1 && ing.queueStatus(ws2).chunks === 2, ing.queueStatus(ws2))
}

fs.rmSync(root, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2))
process.exit(failed.length ? 1 : 0)
