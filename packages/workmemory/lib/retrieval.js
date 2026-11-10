/**
 * 轻量检索（C/D）：中文二元组 + 英文词，BM25 近似打分（不含 IDF，语料太小）。
 *
 * 实机回放发现的问题：用户问"我们之前定了什么约束"时，与条目原文
 * （"所有实现不依赖单独第三方服务"）没有任何共享二元组，词法打分直接归零。
 * 因此加两层兜底：
 *   1. 查询里的类型词（约束/决策/坑…）先把候选池收窄到该类型；
 *   2. 词法无命中时，按"类型 → 重要度 → 时间"返回该类型的条目（列出语义）。
 */

import { deriveUsagePolicy } from './schema.js'
import { sameEvent } from './cluster.js'

const STOP = new Set(['的', '了', '是', '在', '和', '与', '也', '就', '都', '把', '被', '对', '从', '到', '我们', '之前', '什么', '哪些'])
const TYPE_W = { constraint: 1.3, decision: 1.2, preference: 1.1, gotcha: 1.1, open: 1.0, state: 1.0, timeline: 0.8 }
const IMP_W = { critical: 1.5, high: 1.2, medium: 1.0, low: 0.7 }

import { taskAffinity } from './continuity.js'

const TYPE_HINTS = [
  { type: 'constraint', re: /约束|限制|禁止|不允许|不能做什么/ },
  { type: 'decision', re: /决策|决定|选型|方案|定了什么|采用/ },
  { type: 'gotcha', re: /坑|报错|失败|踩过/ },
  { type: 'open', re: /未决|待定|还没|阻塞|欠/ },
  { type: 'preference', re: /偏好|习惯|要求/ },
]

export function detectType(query) {
  for (const h of TYPE_HINTS) if (h.re.test(String(query ?? ''))) return h.type
  return undefined
}

/**
 * 查询同义词扩展（v3.1.1）：用户说"存储"，条目里可能写的是"JSONL / 本地 / node:fs"。
 * 只在**匹配**时给机会，不改变分母（bm 仍按原 token 数算），避免稀释分数。
 */
const SYNONYMS = {
  存储: ['jsonl', '本地', '文件', '磁盘', '持久'],
  持久化: ['jsonl', '本地', '存储'],
  落盘: ['jsonl', '写入', '存储'],
  数据库: ['redis', 'jsonl', '第三方'],
  第三方: ['依赖', '数据库', 'redis', '独立组件'],
  部署: ['profile', 'sync', '挂载', 'plugins'],
  测试: ['用例', '验收', 'acceptance', 'replay'],
  约束: ['不允许', '不依赖', '禁止', '必须'],
  决策: ['采用', '改为', '定为', '方案'],
  验证: ['测试', '跑通', '通过'],
  坑: ['报错', '失败', '踩坑', '异常', '拒绝'],
  报错: ['失败', '异常', '错误'],
}

function matchesWithSynonyms(token, hay) {
  if (hay.has(token)) return true
  const extra = SYNONYMS[token]
  if (!extra) return false
  return extra.some((w) => hay.has(w))
}

export function tokenize(s) {
  const t = String(s ?? '').toLowerCase()
  const out = new Set()
  for (const w of t.match(/[a-z][a-z0-9_+#.\-]{1,}/g) ?? []) out.add(w)
  const cjk = t.replace(/[^\u4e00-\u9fa5]/g, '')
  for (let i = 0; i + 1 < cjk.length; i += 1) {
    const bg = cjk.slice(i, i + 2)
    if (!STOP.has(bg)) out.add(bg)
  }
  return out
}

function rank(item, now) {
  const days = Math.max(0, (now - (item.updatedAt ?? item.createdAt ?? now)) / 864e5)
  const recency = 0.5 ** (days / 14)
  return 0.5 * recency + 0.3 * ((IMP_W[item.importance] ?? 1) / 1.5) + 0.2 * ((TYPE_W[item.type] ?? 1) / 1.3)
}

export function search(items, query, { limit = 10, now = Date.now(), task, noHint = false, policy = 'any', collapse = true } = {}) {
  const q = tokenize(query)
  // 自动召回时不要按类型收窄：问"做了什么决定"里的"决定"会把 constraint/gotcha 全排掉
  const hint = noHint ? undefined : detectType(query)
  // S1c：按注入权限过滤（fact=可作事实；decision=可作决策依据；any=不过滤，供人工浏览）
  const live = items
    .filter((i) => i.status === 'active' || i.status === 'pending')
    .filter((i) => {
      if (policy === 'any') return true
      const p = deriveUsagePolicy(i)
      return policy === 'decision' ? p.decisionBasis : p.factualInjection
    })
  const pool = hint ? live.filter((i) => i.type === hint) : live

  const scored = []
  for (const item of pool) {
    const aff = task ? taskAffinity(item, task, now) : 0
    if (q.size === 0) break
    const hay = tokenize(`${item.text} ${(item.topics ?? []).join(' ')}`)
    let hit = 0
    for (const t of q) if (matchesWithSynonyms(t, hay)) hit += 1
    const bm = hit / q.size
    if (hit === 0) {
      // 零命中：只有"强任务相关"或"类型提示查询"才给机会
      if (aff >= 0.6) scored.push({ item, score: 0.30 * aff, bm: 0, aff })
      else if (hint) scored.push({ item, score: 0.20 * rank(item, now), bm: 0, aff })
      continue
    }
    // v3.1：任务亲和度进主分，词法不再一家独大
    scored.push({ item, score: 0.35 * bm + 0.30 * aff + 0.20 * rank(item, now) + 0.15, bm, aff })
  }
  // 自动召回场景：先按词法命中率排，再按综合分（避免"最新决策"压过"真正相关的那条"）
  scored.sort((a, b) => (noHint ? (b.bm - a.bm) : 0) || b.score - a.score || (b.item.updatedAt ?? 0) - (a.item.updatedAt ?? 0))

  // 兜底：完全无候选但问的是某类东西 → 按类型列出（仍只返回该类型）
  if (scored.length === 0 && hint) {
    return [...pool]
      .sort((a, b) => rank(b, now) - rank(a, now))
      .slice(0, limit)
      .map((item) => ({ item, score: 0.1, fallback: true }))
  }
  // S6a 读时折叠：同一件事的多条记录只占一个槽位（取分最高的那条当代表）
  if (collapse === false) return scored.slice(0, limit)
  const out = []
  for (const h of scored) {
    if (out.some((x) => sameEvent(x.item, h.item))) continue
    out.push(h)
    if (out.length >= limit) break
  }
  return out
}
