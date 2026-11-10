/**
 * LLM 蒸馏（B2）：把一段对话折成结构化记忆候选。
 *
 * 三条铁律：
 *   1. 只产出候选，不决定状态（status 由调用方按授权边界给）；
 *   2. 每条候选必须带 evidence（seq + quote），quote 必须逐字命中；
 *   3. 解析/校验失败一律降级为空，不抛给轮次。
 */
import { findVerifiedEvent } from './evidence.js'
import { ITEM_TYPES, clip } from './model.js'
import { assignTask } from './continuity.js'
import { KINDS, inferKind, isInjectableKind, isValueOnly, hasCause } from './knowledge.js'

const MAX_PROMPT_CHARS = 60_000
const MAX_ITEMS = 12

/** 低风险类型：模型说了就能直接生效；决策/约束/偏好仍需用户确认。 */
const LOW_RISK_TYPES = new Set(['state', 'gotcha', 'timeline'])

/** 蒸馏策略版本：变更后可按版本重跑历史，不影响其他来源条目。 */
export const DISTILLER_VERSION = 1

/**
 * 过程元信息：对后续工作没有复用价值，只是"本次干了什么"的日记。
 *
 * 实机教训：第一版写得过宽（连 `scripts/acceptance-30d.mjs` 这种真实路径、
 * "测试临时目录"这种性能观察都杀掉），所以只保留**明确的日记特征**：
 *   1. 测试通过数量       "226 项测试全部通过"
 *   2. 一次性诊断脚本     "scripts/_verify-xxx.mjs"（下划线前缀 = 临时脚本）
 *   3. 以"本次…"开头     "本次会话…"
 * 宁可漏杀，不可误杀。
 */
export const META_PATTERNS = [
  /\d+\s*项?测试(全部)?(绿|通过)/,
  /scripts\/_[a-z][a-z0-9-]*\.mjs/i,
  /^本次(会话|工作|对话|改动)/,
]

/** 只接受候选列表里的 taskId，防止模型编造归属。 */
function validTaskId(raw, tasks) {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const list = Array.isArray(tasks) ? tasks : []
  const hit = list.find((t) => t.id === raw.trim())
  return hit ? hit.id : undefined
}

const INSTRUCTION = `你是"工作区长期记忆"的记忆提炼器。
输入是本次会话最近若干条消息（编号为 seq，带 [user] / [assistant] / [tool] 角色）。

**最高原则**：只提炼"文件里不会写"的知识。删掉这条记忆后，如果模型读一次文件或跑一次命令
就能得到同样的信息，就不要输出。

按"知识形态"输出，每类必须给出原因或信号：
1 rationale  为什么这样选，代价是什么
   {"kind":"rationale","type":"decision","text":"…","because":"…","cost":"…"}
2 lesson     哪样做会失败，什么信号，怎么修
   {"kind":"lesson","type":"gotcha","text":"…","failedApproach":"…","signal":"…","fix":"…"}
3 constraint 不能碰什么，为什么
   {"kind":"constraint","type":"constraint","text":"…","because":"…"}
4 scope      明确不做什么
   {"kind":"scope","type":"open","text":"…","excludes":"…"}
5 position   做到哪、卡在哪
   {"kind":"position","type":"state","text":"…","done":["…"],"blocking":"…"}
6 environment 外部系统现状（必须给出"目前/截至今天"这类时间语义）
   {"kind":"environment","type":"state","text":"…"}

禁止输出（即使原文提到）：
- 纯值陈述：路径、端口、IP、版本号、配置项取值、文件清单
  （只有当它表达"不能改/不能用"的约束时才允许，且必须给 because）
- 过程播报：测试通过数量、脚本或文件改名、临时目录、本次改了哪几行
- 没有 because / signal 支撑的断言

其余字段：
- type 只能是：${ITEM_TYPES.join(' / ')}；text 是一句结论（≤120 字），不是对话摘录。
- importance：critical / high / medium / low。
- 决策类可选 entity / property / value（对象/属性/取值）。
- evidence 是数组，元素 {"seq": 数字, "quote": "原文片段"}；quote 必须是该 seq 的**原文子串**。
- [tool:名称 状态] 行是工具真实输出，是最强证据；error 尤其适合提炼为 lesson。
- 没有可靠原文证据的条目不要输出。
- 最多 ${MAX_ITEMS} 条；宁缺毋滥。
- 如果候选任务列表非空，且该条明显属于其中某个任务，请填写 taskId（必须是列表里的 id）。
- **即使没有任何可提炼内容，也必须输出 {"items":[]}**。

输出示例：
{"items":[{"kind":"rationale","type":"decision","text":"Jenkins core 锁死 2.387.3","because":"新版插件签名校验变了，升级会加载失败","cost":"无法使用新版特性","importance":"high","evidence":[{"seq":12,"quote":"必须锁死 2.387.3"}]}]}`

/** schemaV2（默认关闭）：额外要求任务状态更新，与 items 分开返回。 */
const INSTRUCTION_V2 = `
- 如果片段表明某个任务有明确进展/阻塞/恢复，额外输出 taskUpdates 数组：
  {"taskUpdates":[{"taskId":"…","progress":"已完成的那件事","nextSteps":"下一步动作"}]}
  只允许填 progress / nextSteps / status（status 只能是 active、paused、blocked）。
  不确定就不要输出；**绝对不要输出 done**，完成必须由用户确认。
- 没有任何任务的明确进展时，taskUpdates 省略或给 []。`

export function buildMessages(recent, tasks = [], schemaV2 = false) {
  const body = recent
    .map((e) => `#${e.seq} [${e.role === 'tool' ? `tool:${e.tool ?? 'tool'} ${e.status ?? ''}` : e.role}] ${clip(e.text, 400)}`)
    .join('\n')
    .slice(-MAX_PROMPT_CHARS)
  const taskList = Array.isArray(tasks) && tasks.length
    ? `\n候选任务（可用 taskId）：\n${tasks.slice(0, 5).map((t) => `- ${t.id}｜${clip(t.title, 40)}`).join('\n')}`
    : ''
  const instruction = schemaV2 ? `${INSTRUCTION}${INSTRUCTION_V2}${taskList}` : `${INSTRUCTION}${taskList}`
  return [{ role: 'user', content: [{ type: 'text', text: `${instruction}\n\n--- 会话片段 ---\n${body}` }] }]
}

/** 截断兜底：从 `[...]` 里逐个扫出完整对象，能救几条是几条。 */
function scanCompleteObjects(text) {
  const out = []
  const start = text.indexOf('[')
  if (start === -1) return out
  let depth = 0
  let objStart = -1
  for (let i = start; i < text.length; i += 1) {
    const c = text[i]
    if (c === '{') {
      if (depth === 0) objStart = i
      depth += 1
    } else if (c === '}') {
      depth -= 1
      if (depth === 0 && objStart >= 0) {
        try { out.push(JSON.parse(text.slice(objStart, i + 1))) } catch { /* 跳过坏对象 */ }
        objStart = -1
      }
    }
  }
  return out
}

export function parseItems(raw) {
  if (typeof raw !== 'string') return []
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1) return []
  if (end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1))
      if (Array.isArray(obj?.items)) return obj.items
    } catch { /* 落到截断兜底 */ }
  }
  // 输出被 maxTokens 截断时，整段 JSON 无法解析，但前面的条目是完整的
  return scanCompleteObjects(text)
}

/**
 * @param {object} opts
 * @param {{provider:string, model:string}} opts.route
 * @param {Array<{seq:number, role:'user'|'assistant', text:string}>} opts.recent
 * @param {(opts:any)=>AsyncIterable<any>} opts.stream  ctx.llm.stream
 */
export async function distill({ route, recent, stream, signal, logger, tasks, currentTaskId, schemaV2 = false }) {
  if (!route?.provider || !route?.model) return { skipped: 'no-route' }
  if (!recent?.length) return { skipped: 'no-events' }

  let raw = ''
  try {
    const it = stream({
      provider: route.provider,
      model: route.model,
      messages: buildMessages(recent, tasks, schemaV2),
      temperature: 0.1,
      // 1200 会把多条目 JSON 截断 → 解析失败却看不出原因（实机：rawHead 是半截 JSON）
      maxTokens: 4000,
      signal,
    })
    for await (const chunk of it) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
      if (chunk?.type === 'finish' && chunk.finish?.kind === 'error') {
        return { error: chunk.finish.failure?.code ?? 'stream-error' }
      }
    }
  } catch (e) {
    logger?.warn?.('distill stream failed', e)
    return { error: String(e?.message ?? e).slice(0, 200) }
  }

  const parsed = parseItems(raw).slice(0, MAX_ITEMS)
  const candidates = []
  let dropped = 0
  for (const it of parsed) {
    if (!it || !ITEM_TYPES.includes(it.type)) { dropped += 1; continue }
    const text = clip(it.text, 160)
    if (!text || text.length < 4) { dropped += 1; continue }
    // 过程元信息（测试数、临时目录、本仓库脚本名）不进记忆
    if (META_PATTERNS.some((re) => re.test(text))) { dropped += 1; continue }

    // v3：知识形态与理由字段；纯值陈述（无因果支撑）直接丢弃
    const kindRaw = KINDS.includes(it.kind) ? it.kind : inferKind(text, it.type)
    const because = typeof it.because === 'string' ? clip(it.because, 160) : null
    const cost = typeof it.cost === 'string' ? clip(it.cost, 120) : null
    const failedApproach = typeof it.failedApproach === 'string' ? clip(it.failedApproach, 120) : null
    const signal = typeof it.signal === 'string' ? clip(it.signal, 160) : null
    const fix = typeof it.fix === 'string' ? clip(it.fix, 160) : null
    const excludes = typeof it.excludes === 'string' ? clip(it.excludes, 120) : null
    const kindFields = { because, signal, excludes, observedAt: Date.now() }
    if (isValueOnly(text) && !hasCause(text) && !because) { dropped += 1; continue }
    // 有形态但缺支撑字段 → 降级为低价值陈述（入库不注入）
    const kind = kindRaw && isInjectableKind(kindRaw, kindFields) ? kindRaw : null
    const ev = (it.evidence ?? [])
      .map((e) => {
        const hit = findVerifiedEvent(recent, e?.seq, e?.quote)
        return hit ? {
          sessionId: hit.sessionId ?? '',
          seq: hit.seq,
          role: hit.role,
          quote: clip(String(hit.text).replace(/\s+/g, ' ').trim(), 200),
          assertionType: hit.role === 'user' ? 'explicit' : 'inferred',
        } : undefined
      })
      .filter(Boolean)
    if (ev.length === 0) { dropped += 1; continue }   // 证据对不上 → 丢弃
    // S1.5：来源由证据角色决定，不由模型自述。
    // 工具输出是最强证据（tool_verified）；用户原话次之（LLM 提炼 → user_derived）；
    // 只有助手消息时为 assistant。
    const hasTool = ev.some((e) => e.role === 'tool')
    const hasUser = ev.some((e) => e.role === 'user')
    const source = hasTool ? 'tool' : hasUser ? 'user' : 'assistant'
    const authority = hasTool ? 'tool_verified' : hasUser ? 'user_derived' : 'assistant'
    candidates.push({
      type: it.type,
      knowledgeKind: kind,
      because,
      cost,
      failedApproach,
      signal,
      fix,
      excludes,
      origin: 'llm',
      distillerVersion: DISTILLER_VERSION,
      text,
      importance: ['critical', 'high', 'medium', 'low'].includes(it.importance) ? it.importance : 'medium',
      confidence: 0.8,                                  // LLM 推断封顶
      source,
      authority,
      // 授权边界：低风险类型直接 active，决策/约束/偏好必须待确认
      status: LOW_RISK_TYPES.has(it.type) ? 'active' : 'pending',
      topics: it.topics,
      // 任务归属（S2）：模型给的 id 只作参考，最终由 assignTask 按证据判三态
      ...(() => {
        const context = ev.map((e) => e.quote).join(' ')
        const ta = assignTask({ text, context, tasks, currentTaskId, modelTaskId: it.taskId })
        return { taskId: ta.taskId, taskAssignment: ta }
      })(),
      entity: typeof it.entity === 'string' ? clip(it.entity, 40) : undefined,
      property: typeof it.property === 'string' ? clip(it.property, 40) : undefined,
      value: typeof it.value === 'string' ? clip(it.value, 60) : undefined,
      evidence: ev,
    })
  }
  return { candidates, parsed: parsed.length, dropped, rawHead: raw.slice(0, 240), taskUpdates: schemaV2 ? parseTaskUpdates(raw, tasks) : [] }
}

/**
 * 解析并校验 taskUpdates（schemaV2）。
 * 规则：taskId 必须在候选列表里；status 只允许 active/paused/blocked；
 *      progress/nextSteps 必须是可读短句；**永远不接受 done**。
 */
export function parseTaskUpdates(raw, tasks = []) {
  if (typeof raw !== 'string') return []
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return []
  let obj
  try { obj = JSON.parse(raw.slice(start, end + 1)) } catch { return [] }
  const list = Array.isArray(obj?.taskUpdates) ? obj.taskUpdates : []
  const out = []
  for (const u of list) {
    const taskId = validTaskId(u?.taskId, tasks)
    if (!taskId) continue
    const update = { taskId }
    if (['active', 'paused', 'blocked'].includes(u?.status)) update.status = u.status
    if (typeof u?.progress === 'string' && u.progress.trim().length >= 4) update.progress = clip(u.progress.trim(), 120)
    if (typeof u?.nextSteps === 'string' && u.nextSteps.trim().length >= 3) update.nextSteps = clip(u.nextSteps.trim(), 120)
    if (Object.keys(update).length > 1) out.push(update)
  }
  return out
}
