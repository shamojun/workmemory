/**
 * 任务连续性（v3.1，规则优先 + LLM 兜底）。
 *
 * 设计取舍（用户确认）：
 *   - 识别：先规则（零成本），不确定时才用 LLM（每轮最多 1 次）；
 *   - 更新：只在"显式进度信号"时改内容，不做逐轮 LLM 更新；
 *   - 快照：每轮 turn/end 写本地 task.json（无 token 成本）。
 */

const CONTINUE_RE = /(继续|接着|还是那个|上次那个|接着上次|回到|回到刚才|继续排查|接着做|往下做|刚才那个)/
const PROGRESS_RE = /(已(?:经)?(?:完成|修好|修复|解决|确认|搞定|上线|合并|跑通)|完成了|搞定了|修好了|通过了|测试通过|跑通了)/
const BLOCKER_RE = /(卡住|阻塞|报错|失败|不行|不通|挂了|超时)/
const NEXT_RE = /(下一步|接下来|然后去|再去|还需要|待办|TODO|准备去)/
const DONE_RE = /(这个任务(?:已经)?(?:完成|结束)|任务完成|可以收尾了|收工了)/
// 需要主动翻历史的问题（v3.1.1 动态召回触发条件）
const RECALL_RE = /(之前|上次|当初|以前|我们(?:定|说|聊)过|为什么(?:这么|这样)?(?:定|选|改)|记得|历史上|以前那个)/

/** 时间窗内、有活跃性的任务才可能是"当前任务"。 */
const ACTIVE_WINDOW_MS = 72 * 3600 * 1000

export function continuationSignal(text) {
  return CONTINUE_RE.test(String(text ?? ''))
}

/* ── 事实归属任务（S2，契约 §3.4） ─────────────────────────
 * 三态：resolved / unresolved / rejected。原则：宁可 null，不写错任务。
 *
 * 判定顺序（用户确认）：
 *   1. 模型给的 taskId 必须在候选集合里，否则 rejected；
 *   2. 当前会话绑定任务——但仅在没有别的任务标题被明确点名时信任；
 *   3. 歧义：两个以上候选都有文本支持，且任务关键词相似度 ≥ 0.3 → unresolved；
 *   4. 显式标题命中；
 *   5. 唯一关键词命中；
 *   6. 否则 unresolved（不给"猜一个"的机会）。
 */

const TASK_LIVE_STATUSES = ['todo', 'active', 'paused', 'blocked']
export const AMBIGUITY_THRESHOLD = 0.3

export function taskKeywords(task) {
  const out = new Set()
  for (const k of task?.keywords ?? []) {
    const t = String(k).toLowerCase().trim()
    if (t.length >= 2) out.add(t)
  }
  for (const w of String(task?.title ?? '').split(/[\s，,、。:：()（）/\\-]+/)) {
    const t = w.toLowerCase().trim()
    if (t.length >= 2) out.add(t)
  }
  return out
}

/** 关键词集合的 Jaccard 相似度。 */
export function keywordSimilarity(a, b) {
  const sa = a instanceof Set ? a : taskKeywords(a)
  const sb = b instanceof Set ? b : taskKeywords(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const x of sa) if (sb.has(x)) inter += 1
  return inter / (sa.size + sb.size - inter)
}

function assignment(status, taskId, confidence, reason, supportingEvidence = [], candidateTaskIds = []) {
  return { status, taskId, confidence, reason, supportingEvidence, candidateTaskIds }
}

/**
 * @param {{text:string, tasks:Array, currentTaskId?:string, modelTaskId?:string}} opts
 * @returns {{status:'resolved'|'unresolved'|'rejected', taskId:string|null, confidence:number, reason:string, supportingEvidence:string[], candidateTaskIds:string[]}}
 */
export function assignTask({ text, context, tasks = [], currentTaskId, modelTaskId } = {}) {
  // 没写 status 的（旧数据/测试夹具）按活跃处理，不能因为缺字段就判"无候选"
  const live = (tasks ?? []).filter((t) => t?.id && (!t.status || TASK_LIVE_STATUSES.includes(t.status)))
  const ids = new Set(live.map((t) => t.id))
  // 归属同时看条目正文与证据原文：正文可能只是结论（"流水线挂了"），
  // 关键词往往在证据里（"jenkins 流水线挂了"）
  const hay = `${text ?? ''} ${context ?? ''}`.toLowerCase()

  // 1) 模型给的 id 必须真实存在
  if (modelTaskId && !ids.has(modelTaskId)) {
    return assignment('rejected', null, 0, 'invalid-id', [], [...ids])
  }

  const kws = new Map(live.map((t) => [t.id, taskKeywords(t)]))
  const hitsOf = (t) => [...(kws.get(t.id) ?? [])].filter((k) => hay.includes(k))
  const supported = live.filter((t) => hitsOf(t).length > 0)
  const titleHit = live.filter((t) => {
    const title = String(t.title ?? '').toLowerCase().trim()
    return title.length >= 3 && hay.includes(title)
  })

  // 2) 当前会话绑定任务：唯一候选时信任；若点名了别的任务标题则不信任
  const bound = live.find((t) => t.id === currentTaskId)
  if (bound) {
    const namedOther = titleHit.some((t) => t.id !== bound.id)
    const othersSupported = supported.some((t) => t.id !== bound.id)
    const boundHits = hitsOf(bound)
    if (!namedOther && !othersSupported && boundHits.length > 0) {
      return assignment('resolved', bound.id, 0.9, 'active-task-and-topic', boundHits, [bound.id])
    }
  }

  // 3) 歧义：多个候选都有支持，且彼此相似度达到阈值
  for (let i = 0; i < supported.length; i += 1) {
    for (let j = i + 1; j < supported.length; j += 1) {
      const sim = keywordSimilarity(kws.get(supported[i].id), kws.get(supported[j].id))
      if (sim >= AMBIGUITY_THRESHOLD) {
        return assignment('unresolved', null, 0.2, 'ambiguous', [], supported.map((t) => t.id))
      }
    }
  }

  // 4) 显式标题（唯一命中才算数）
  if (titleHit.length === 1) {
    return assignment('resolved', titleHit[0].id, 0.95, 'explicit-title', hitsOf(titleHit[0]), [titleHit[0].id])
  }

  // 5) 唯一关键词命中
  if (supported.length === 1) {
    return assignment('resolved', supported[0].id, 0.85, 'unique-keyword', hitsOf(supported[0]), [supported[0].id])
  }

  // 6) 模型判断 + 文本支持（模型 id 在支持集合内）
  const modelSupported = modelTaskId ? supported.find((t) => t.id === modelTaskId) : undefined
  if (modelSupported) {
    return assignment('resolved', modelSupported.id, 0.8, 'unique-keyword', hitsOf(modelSupported), [modelSupported.id])
  }

  return assignment(
    'unresolved', null, 0,
    supported.length ? 'ambiguous' : 'insufficient-evidence',
    [], supported.map((t) => t.id),
  )
}

/** 这句话是否需要主动翻历史（动态召回触发）。 */
export function wantsRecall(text) {
  const t = String(text ?? '').trim()
  if (!t || t.length < 2) return false
  if (t.length > 300) return false
  return RECALL_RE.test(t)
}

/**
 * 从一句话里抽"显式进度"，返回 {kind, text} 或 undefined。
 *
 * v3.1.1 修正：长文/文档粘贴不得触发进度记录。
 * 之前把用户贴的整篇方案当成了"进度"，直接污染任务态——所以先做形态闸门，
 * 再只取**包含信号的最短子句**，而不是整条消息前 160 字。
 */
export function progressSignal(text) {
  const t = String(text ?? '').trim()
  if (!t || t.length < 4) return undefined
  if (t.length > 300) return undefined                       // 长文本是文档，不是进度声明
  if (t.includes('```') || (t.match(/\n/g) ?? []).length > 6) return undefined

  const clauses = t
    .split(/[。！？\n；;，,]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)

  const pick = (re) => clauses.filter((c) => re.test(c)).sort((a, b) => a.length - b.length)[0]
  const done = pick(DONE_RE)
  if (done) return { kind: 'done', text: done.slice(0, 120) }
  const progress = pick(PROGRESS_RE)
  if (progress) return { kind: 'progress', text: progress.slice(0, 120) }
  const blocker = pick(BLOCKER_RE)
  if (blocker) return { kind: 'blocker', text: blocker.slice(0, 120) }
  const next = pick(NEXT_RE)
  if (next) return { kind: 'next', text: next.slice(0, 120) }
  return undefined
}

/** 任务与文本的实体重合度（用 task.keywords 与任务标题做词面匹配）。 */
export function overlapScore(task, text) {
  if (!task) return 0
  const hay = String(text ?? '').toLowerCase()
  const words = [...(task.keywords ?? []), ...String(task.title ?? '').split(/[\s，,、。]+/)]
    .map((w) => String(w).toLowerCase().trim())
    .filter((w) => w.length >= 2)
  let hit = 0
  for (const w of words) if (hay.includes(w)) hit += 1
  return hit
}

/**
 * 规则识别：当前对话应归属哪个任务。
 * @returns {{task:object, reason:string} | {create:true, reason:string} | {none:true}}
 */
export function detectTask({ tasks, text, now = Date.now() }) {
  // todo 参与"关键词命中"（用户点名了某个待开始的任务），但不参与"延续"默认与窗口沿用
  const matched = (tasks ?? []).filter((t) => ['active', 'paused', 'blocked', 'todo'].includes(t.status))
  const live = matched.filter((t) => t.status !== 'todo')
  const active = live.find((t) => t.status === 'active')

  // 1) 明确延续词 → 优先"被点名的任务"，其次当前活跃任务
  //    （v3.1.1 修复："继续 mongodb 那边" 不能因为有个 active 就忽略点名的任务）
  if (continuationSignal(text)) {
    const named = matched
      .map((t) => ({ t, score: overlapScore(t, text) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (b.t.updatedAt ?? 0) - (a.t.updatedAt ?? 0))[0]
    if (named) return { task: named.t, reason: `continue+named:${named.score}` }
    const pick = active ?? [...live].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
    if (pick) return { task: pick, reason: 'continue-signal' }
  }

  // 2) 全量比对实体重合：别的任务明显更匹配时**要能切过去**
  //    （v3.1 修复：旧逻辑只要存在 active 就永远用它，导致多任务串扰）
  const ranked = matched
    .map((t) => ({ t, score: overlapScore(t, text) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (b.t.updatedAt ?? 0) - (a.t.updatedAt ?? 0))
  const best = ranked[0]

  if (best) {
    const activeScore = active ? overlapScore(active, text) : 0
    if (active && best.t.id === active.id) return { task: active, reason: `keyword-overlap:${activeScore}` }
    if (active && best.score <= activeScore) return { task: active, reason: `keyword-overlap:${activeScore}` }
    if (best.t.status === 'todo') return { task: best.t, reason: `todo-match:${best.score}` }
    return { task: best.t, reason: `${active ? 'switch' : 'pick'}-better:${best.score}` }
  }

  // 3) 没有实体重合：沿用活跃任务（窗口内），否则尝试恢复最近任务
  if (active) {
    const age = now - (active.updatedAt ?? 0)
    if (age < ACTIVE_WINDOW_MS) return { task: active, reason: 'active-window' }
    return { task: active, reason: 'active-stale' }
  }

  const recent = live
    .filter((t) => now - (t.updatedAt ?? 0) < ACTIVE_WINDOW_MS)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
  if (recent) return { task: recent, reason: 'resume-recent' }

  return { create: true, reason: 'no-live-task' }
}

/** 判断某条内容是否属于某任务（简报过滤用）。 */
export function belongsToTask(item, task) {
  if (!task) return true
  if (item.taskId === task.id) return true
  if (!item.taskId) {
    // 无归属的历史条目：只有实体重合时才认为相关
    return overlapScore(task, `${item.text} ${(item.topics ?? []).join(' ')}`) > 0
  }
  return false
}

/**
 * 任务亲和度（0–1）：把"这条记忆对当前任务有多相关"做成可打分的量。
 * 检索与简报排序用，避免所有历史记忆平权。
 */
export function taskAffinity(item, task, now = Date.now()) {
  if (!task) return 0
  if (item.taskId === task.id) return 1
  let score = 0
  const overlap = overlapScore(task, `${item.text} ${(item.topics ?? []).join(' ')}`)
  if (overlap > 0) score = Math.min(0.8, 0.4 + 0.1 * overlap)
  if ((item.createdAt ?? 0) >= (task.startedAt ?? 0)) score = Math.max(score, 0.3)
  if (item.taskId && item.taskId !== task.id) score = Math.min(score, 0.1)   // 属于别的任务 → 压低
  return score
}

/** LLM 兜底用的提示词：让模型只在候选中选，或明确新建。 */
export function buildTaskPrompt(candidates, recentText) {
  const list = candidates.map((t, i) => `${i + 1}. [${t.status}] ${t.title}｜目标：${t.objective || '（未记录）'}`).join('\n')
  return [{
    role: 'user',
    content: [{
      type: 'text',
      text: `判断用户最新一句话是否延续已有任务。只输出 JSON，不要解释。
候选任务：
${list || '（无）'}

最近对话：
${String(recentText ?? '').slice(-1200)}

输出格式（三选一）：
{"taskIndex": 数字}                     表示延续第几个候选
{"new":{"title":"短标题","objective":"完成标准"}}   表示新任务
{"none":true}                           表示只是闲聊，不涉及任务`,
    }],
  }]
}

/** 解析 LLM 兜底结果。 */
export function parseTaskChoice(raw, candidates) {
  if (typeof raw !== 'string') return undefined
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  let obj
  try { obj = JSON.parse(raw.slice(start, end + 1)) } catch { return undefined }
  if (obj?.none) return { none: true }
  if (Number.isInteger(obj?.taskIndex)) {
    const t = candidates[obj.taskIndex - 1]
    return t ? { task: t } : undefined
  }
  if (obj?.new?.title) return { create: true, title: String(obj.new.title).slice(0, 80), objective: String(obj.new.objective ?? '').slice(0, 200) }
  return undefined
}
