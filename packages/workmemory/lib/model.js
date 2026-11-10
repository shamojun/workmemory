/**
 * 记忆项模型（B1：无 LLM）。
 * 只做确定性可验证的事：类型枚举、归一化、指纹、主题词、基本校验。
 */
import crypto from 'node:crypto'

export const ITEM_TYPES = ['state', 'decision', 'open', 'gotcha', 'preference', 'constraint', 'timeline']
export const STATUSES = ['active', 'pending', 'stale', 'superseded', 'invalid', 'archived']
export const IMPORTANCE = ['critical', 'high', 'medium', 'low']
export const AUTHORITY = ['user_explicit', 'user_confirmed', 'tool_verified', 'user_historical', 'assistant']
export const ASSERTION = ['explicit', 'confirmed', 'inferred', 'assistant_suggestion', 'tool_observed', 'historical']

export const SCHEMA_VERSION = 1
export const TEXT_MAX = 200
export const QUOTE_MAX = 200

const STOP = new Set(['的', '了', '是', '在', '和', '与', '也', '就', '都', '把', '被', '对', '从', '到', '用', '做', '这个', '那个', '我们', '你们', '可以', '需要', '什么', '怎么'])

export function normalize(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[，。！？、；：“”‘’（）【】《》]/g, ' ')
    .trim()
    .toLowerCase()
}

export function itemHash(type, text) {
  return crypto.createHash('sha1').update(`${type}|${normalize(text)}`).digest('hex').slice(0, 16)
}

export function newId(now = Date.now()) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `mem_${stamp}_${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`
}

/** 中文二元组 + 英文词；去掉停用词与噪声，最多 8 个。 */
export function topicsOf(text, max = 8) {
  const t = normalize(text)
  const out = new Set()
  for (const w of t.match(/[a-z][a-z0-9_+#.\-]{1,}/g) ?? []) out.add(w)
  const cjk = t.replace(/[^\u4e00-\u9fa5]/g, '')
  for (let i = 0; i + 1 < cjk.length; i += 1) {
    const bg = cjk.slice(i, i + 2)
    if (!STOP.has(bg)) out.add(bg)
  }
  return [...out].slice(0, max)
}

export function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 校验 + 补默认值；返回 null 表示不可入库。 */
export function buildItem(candidate, now = Date.now()) {
  if (!candidate || typeof candidate !== 'object') return null
  if (!ITEM_TYPES.includes(candidate.type)) return null
  const text = clip(candidate.text, TEXT_MAX)
  if (!text || text.length < 4) return null
  const evidence = (candidate.evidence ?? []).filter((e) => e && e.sessionId && Number.isInteger(e.seq))
  if (evidence.length === 0) return null   // 无证据不入库

  const authority = AUTHORITY.includes(candidate.authority) ? candidate.authority : 'user_explicit'
  const confidence = typeof candidate.confidence === 'number' ? Math.min(1, Math.max(0, candidate.confidence)) : 0.9

  return {
    schemaVersion: SCHEMA_VERSION,
    id: candidate.id ?? newId(now),
    type: candidate.type,
    text,
    topics: candidate.topics?.length ? candidate.topics.slice(0, 8) : topicsOf(text),
    // v3.1.1：决策作用域（permanent/temporary/experiment/rejected）与临时覆盖
    decisionScope: ['permanent','temporary','experiment','rejected'].includes(candidate.decisionScope) ? candidate.decisionScope : 'permanent',
    overrideUntil: typeof candidate.overrideUntil === 'number' ? candidate.overrideUntil : null,
    baseDecisionId: typeof candidate.baseDecisionId === 'string' ? candidate.baseDecisionId : null,
    // 事实归属任务（S2）：taskId 是 taskAssignment 的镜像
    taskId: typeof candidate.taskId === 'string' && candidate.taskId ? candidate.taskId : null,
    taskAssignment: candidate.taskAssignment && typeof candidate.taskAssignment === 'object'
      ? candidate.taskAssignment
      : undefined,
    // v3：知识形态与理由字段（值进 anchors，不进正文）
    knowledgeKind: candidate.knowledgeKind ?? null,
    because: candidate.because ?? null,
    cost: candidate.cost ?? null,
    failedApproach: candidate.failedApproach ?? null,
    signal: candidate.signal ?? null,
    fix: candidate.fix ?? null,
    excludes: candidate.excludes ?? null,
    anchors: Array.isArray(candidate.anchors) ? candidate.anchors.slice(0, 8) : [],
    validUntil: candidate.validUntil ?? null,
    entity: candidate.entity ?? null,
    property: candidate.property ?? null,
    value: candidate.value ?? null,
    status: STATUSES.includes(candidate.status) ? candidate.status : 'active',
    importance: IMPORTANCE.includes(candidate.importance) ? candidate.importance : 'medium',
    confidence,
    authority,
    // 来源与版本：规则重建时据此只重做 origin=rule 的条目（v3.1 防清库）
    origin: ['rule', 'llm', 'manual'].includes(candidate.origin) ? candidate.origin : 'rule',
    extractorVersion: Number.isInteger(candidate.extractorVersion) ? candidate.extractorVersion : null,
    distillerVersion: Number.isInteger(candidate.distillerVersion) ? candidate.distillerVersion : null,
    evidence: evidence.map((e) => ({
      sessionId: e.sessionId,
      seq: e.seq,
      role: e.role ?? 'user',
      quote: clip(e.quote, QUOTE_MAX),
      assertionType: ASSERTION.includes(e.assertionType) ? e.assertionType : 'explicit',
    })),
    relations: candidate.relations ?? [],
    files: candidate.files ?? [],
    hash: itemHash(candidate.type, text),
    createdAt: now,
    updatedAt: now,
    rev: 1,
  }
}
