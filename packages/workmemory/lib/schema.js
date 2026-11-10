/**
 * 数据契约校验器（v3.1.2.1-final）。
 *
 * 手写，零依赖——不引入 ajv，保持"不依赖第三方"的硬约束。
 *
 * 设计原则：
 *   1. 字段级约束表达在 schema/*.schema.json；
 *   2. **跨字段不变式**表达在这里（JSON Schema 写不动或写不清的）；
 *   3. 校验失败返回 { ok:false, errors:[...] }，不抛异常，由调用方决定拒绝还是降级。
 *
 * 冻结决议（见 WorkMemory-v3.1.2.1-final）：
 *   C1 importance 保留枚举，数值仅派生
 *   C2 字段名统一 revision，读取兼容 rev
 *   C3 taskAssignment 权威，taskId 是镜像
 *   C4 decision 类看 scope，非 decision 类看 assertionMode，互斥
 *   C6 tool / tool_verified 标 reserved，暂拒绝写入
 *   C8 item.supersedes 是唯一字段（decision.supersedes 取消）
 */

import { isItemInjectionRisk } from './injection.js'
import { KINDS, KIND_REQUIRED, inferKind, isInjectableKind } from './knowledge.js'

export const SCHEMA_VERSION = 3

export const ITEM_TYPES = ['state', 'decision', 'open', 'gotcha', 'preference', 'constraint', 'timeline']
// S1.5：tool 已解除 reserved（DSH 实测有 tool/call 与 tool/result 事件）
export const SOURCES = ['user', 'assistant', 'tool']
export const RESERVED_SOURCES = []
export const ORIGINS = ['rule', 'llm', 'backfill', 'manual', 'migration']
export const AUTHORITIES = ['user_explicit', 'user_derived', 'assistant', 'tool_verified']
export const RESERVED_AUTHORITIES = []
export const CONFIRMATION = ['unconfirmed', 'confirmed', 'rejected']
export const ASSERTION_MODES = ['fact_assertion', 'explicit_rule', 'decision', 'temporary_intent', 'hypothesis']
export const ITEM_STATUSES = ['active', 'pending', 'stale', 'superseded', 'invalid']
export const IMPORTANCE = ['critical', 'high', 'medium', 'low']
export const TASK_STATUSES = ['todo', 'active', 'paused', 'blocked', 'done', 'abandoned']
export const ASSIGNMENT_STATUSES = ['resolved', 'unresolved', 'rejected']
export const ASSIGNMENT_REASONS = ['explicit-title', 'unique-keyword', 'active-task-and-topic', 'ambiguous', 'no-candidate', 'invalid-id', 'insufficient-evidence']
export const DECISION_SCOPES = ['permanent', 'temporary', 'experiment']
export const DECISION_STATUSES = ['active', 'expired', 'rejected', 'superseded']
export const QUEUE_STATES = ['pending', 'processing', 'retry_wait', 'completed', 'failed', 'skipped']
export const VERIFY_STATES = ['verified', 'unverifiable', 'mismatch', 'stale']
export const SOURCE_ROLES = ['user', 'assistant', 'tool']

const AUTHORITY_RANK = { confirmed: 5, user_explicit: 4, user_derived: 3, tool_verified: 2, assistant: 1 }
const STATUS_RANK = { active: 5, pending: 4, stale: 3, superseded: 2, invalid: 1 }

const isStr = (v) => typeof v === 'string' && v.length > 0
const isInt = (v) => Number.isInteger(v)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const inEnum = (v, list) => list.includes(v)
const isSha256 = (v) => typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v)

function make() {
  const errors = []
  return {
    errors,
    err: (path, msg) => errors.push(`${path}: ${msg}`),
    done: () => ({ ok: errors.length === 0, errors }),
  }
}

/* ── Evidence ─────────────────────────────────────────────── */

export function validateEvidence(ev, path = 'evidence') {
  const { err, done } = make()
  if (!ev || typeof ev !== 'object') { err(path, 'must be object'); return done() }
  if (!isStr(ev.id)) err(`${path}.id`, 'required string')
  if (!isStr(ev.sessionId)) err(`${path}.sessionId`, 'required string')
  if (!isInt(ev.seq)) err(`${path}.seq`, 'required integer')
  if (!inEnum(ev.sourceRole, SOURCE_ROLES)) err(`${path}.sourceRole`, `must be one of ${SOURCE_ROLES.join('|')}`)
  if (!isStr(ev.quote)) err(`${path}.quote`, 'required string')
  else if (ev.quote.trim().length < 4) err(`${path}.quote`, 'must be >= 4 chars')
  if (!inEnum(ev.verifyState, VERIFY_STATES)) err(`${path}.verifyState`, `must be one of ${VERIFY_STATES.join('|')}`)
  if (ev.verifyState === 'verified' && !isInt(ev.verifiedAt)) err(`${path}.verifiedAt`, 'required when verifyState=verified')
  if (ev.sourceHash != null && !isSha256(ev.sourceHash)) err(`${path}.sourceHash`, 'must be sha256:<64 hex>')
  if (ev.quoteHash != null && !isSha256(ev.quoteHash)) err(`${path}.quoteHash`, 'must be sha256:<64 hex>')
  return done()
}

/* ── Item ─────────────────────────────────────────────────── */

export function validateItem(item, path = 'item') {
  const { errors, err, done } = make()
  if (!item || typeof item !== 'object') { err(path, 'must be object'); return done() }

  // 必填与枚举
  if (!isStr(item.id)) err(`${path}.id`, 'required string')
  if (item.schemaVersion !== SCHEMA_VERSION) err(`${path}.schemaVersion`, `must be ${SCHEMA_VERSION}`)
  if (!inEnum(item.type, ITEM_TYPES)) err(`${path}.type`, `must be one of ${ITEM_TYPES.join('|')}`)
  if (!isStr(item.text) || item.text.trim().length < 4) err(`${path}.text`, 'required, >= 4 chars')

  // S1.5：tool 已解除 reserved；改为校验 source/authority 一致
  if (!inEnum(item.source, SOURCES)) err(`${path}.source`, `must be one of ${SOURCES.join('|')}`)
  if (!inEnum(item.authority, AUTHORITIES)) err(`${path}.authority`, `must be one of ${AUTHORITIES.join('|')}`)
  if (!inEnum(item.origin, ORIGINS)) err(`${path}.origin`, `must be one of ${ORIGINS.join('|')}`)
  if (!inEnum(item.confirmationStatus, CONFIRMATION)) err(`${path}.confirmationStatus`, `must be one of ${CONFIRMATION.join('|')}`)
  if (!inEnum(item.assertionMode, ASSERTION_MODES)) err(`${path}.assertionMode`, `must be one of ${ASSERTION_MODES.join('|')}`)
  if (!inEnum(item.status, ITEM_STATUSES)) err(`${path}.status`, `must be one of ${ITEM_STATUSES.join('|')}`)
  if (!inEnum(item.importance, IMPORTANCE)) err(`${path}.importance`, `must be one of ${IMPORTANCE.join('|')}`)
  if (!isNum(item.confidence) || item.confidence < 0 || item.confidence > 1) err(`${path}.confidence`, 'number in [0,1]')

  // C2：revision（兼容 rev）
  const revision = item.revision ?? item.rev
  if (!isInt(revision) || revision < 1) err(`${path}.revision`, 'integer >= 1 (or legacy rev)')

  // v3：知识形态。null 允许（低价值陈述，入库但不注入）
  if (item.knowledgeKind != null && !inEnum(item.knowledgeKind, KINDS)) {
    err(`${path}.knowledgeKind`, `must be one of ${KINDS.join('|')} or null`)
  }
  if (item.knowledgeKind && KIND_REQUIRED[item.knowledgeKind]) {
    for (const f of KIND_REQUIRED[item.knowledgeKind]) {
      if (item[f] == null || item[f] === '') err(`${path}.${f}`, `required when knowledgeKind=${item.knowledgeKind}`)
    }
  }

  // I1–I4：来源与授权一致性
  if (item.source === 'user' && !['user_explicit', 'user_derived'].includes(item.authority)) {
    err(`${path}.authority`, 'source=user requires user_explicit|user_derived')
  }
  if (item.source === 'assistant' && item.authority !== 'assistant') {
    err(`${path}.authority`, 'source=assistant requires assistant')
  }
  if (item.authority === 'user_explicit' && item.source !== 'user') {
    err(`${path}.source`, 'authority=user_explicit requires source=user')
  }
  // S1.5：工具证据必须双向匹配
  if (item.source === 'tool' && item.authority !== 'tool_verified') {
    err(`${path}.authority`, 'source=tool requires tool_verified')
  }
  if (item.authority === 'tool_verified' && item.source !== 'tool') {
    err(`${path}.source`, 'tool_verified requires source=tool')
  }

  // I5–I7：确认状态与生命周期
  if (item.confirmationStatus === 'confirmed' && !['active', 'stale', 'superseded'].includes(item.status)) {
    err(`${path}.status`, 'confirmed requires active|stale|superseded')
  }
  if (item.confirmationStatus === 'rejected' && item.status !== 'invalid') {
    err(`${path}.status`, 'rejected requires invalid')
  }
  if (item.confirmationStatus === 'confirmed' && item.confirmedBy != null && item.confirmedBy !== 'user') {
    err(`${path}.confirmedBy`, 'only user can confirm')
  }

  // C3：归属镜像不变式
  const ta = item.taskAssignment
  if (!ta || typeof ta !== 'object') {
    err(`${path}.taskAssignment`, 'required object')
  } else {
    if (!inEnum(ta.status, ASSIGNMENT_STATUSES)) err(`${path}.taskAssignment.status`, `must be one of ${ASSIGNMENT_STATUSES.join('|')}`)
    if (!inEnum(ta.reason, ASSIGNMENT_REASONS)) err(`${path}.taskAssignment.reason`, `must be one of ${ASSIGNMENT_REASONS.join('|')}`)
    if (ta.status === 'resolved') {
      if (!isStr(ta.taskId)) err(`${path}.taskAssignment.taskId`, 'required when status=resolved')
      if (item.taskId !== ta.taskId) err(`${path}.taskId`, 'must mirror taskAssignment.taskId when resolved')
    } else if (item.taskId !== null) {
      err(`${path}.taskId`, 'must be null when assignment is not resolved')
    }
    if (!isNum(ta.confidence) || ta.confidence < 0 || ta.confidence > 1) err(`${path}.taskAssignment.confidence`, 'number in [0,1]')
    if (ta.supportingEvidence != null && !Array.isArray(ta.supportingEvidence)) err(`${path}.taskAssignment.supportingEvidence`, 'array')
    if (ta.candidateTaskIds != null && !Array.isArray(ta.candidateTaskIds)) err(`${path}.taskAssignment.candidateTaskIds`, 'array')
  }

  // C4：decision 与 assertionMode 互斥
  const isDecision = item.type === 'decision'
  if (isDecision !== (item.decision != null)) {
    err(`${path}.decision`, 'decision object iff type=decision')
  }
  if (item.decision != null) {
    const d = item.decision
    if (!inEnum(d.scope, DECISION_SCOPES)) err(`${path}.decision.scope`, `must be one of ${DECISION_SCOPES.join('|')}`)
    if (!inEnum(d.status, DECISION_STATUSES)) err(`${path}.decision.status`, `must be one of ${DECISION_STATUSES.join('|')}`)
    if (d.scope === 'temporary' && !isInt(d.validUntil)) err(`${path}.decision.validUntil`, 'required when scope=temporary')
    if (d.scope === 'permanent' && d.validUntil != null) err(`${path}.decision.validUntil`, 'must be null when scope=permanent')
    if (d.scope === 'experiment' && !isStr(d.endCondition)) err(`${path}.decision.endCondition`, 'required when scope=experiment')
    if (item.assertionMode !== 'decision') err(`${path}.assertionMode`, 'must be decision when decision object present')
    if (d.supersedes != null) err(`${path}.decision.supersedes`, 'use item.supersedes instead (C8)')
  } else if (item.assertionMode === 'decision') {
    err(`${path}.assertionMode`, 'decision requires a decision object')
  }
  if (item.assertionMode === 'temporary_intent' && isDecision) {
    err(`${path}.assertionMode`, 'temporary_intent is for non-decision items; use decision.scope=temporary')
  }

  // M1：时间语义
  if (!isInt(item.observedAt)) err(`${path}.observedAt`, 'required integer (original event time)')
  if (!isInt(item.recordedAt)) err(`${path}.recordedAt`, 'required integer (write time)')
  if (isInt(item.observedAt) && isInt(item.recordedAt) && item.observedAt > item.recordedAt) {
    err(`${path}.observedAt`, 'must be <= recordedAt')
  }

  // 证据
  if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
    err(`${path}.evidence`, 'non-empty array required')
  } else {
    item.evidence.forEach((ev, i) => {
      const r = validateEvidence(ev, `${path}.evidence[${i}]`)
      if (!r.ok) errors.push(...r.errors)
    })
  }

  if (item.topics != null && !Array.isArray(item.topics)) err(`${path}.topics`, 'array')
  if (item.provenance != null) {
    const p = item.provenance
    if (!isInt(p.firstSeenAt)) err(`${path}.provenance.firstSeenAt`, 'integer')
    if (!Array.isArray(p.sourceKinds)) err(`${path}.provenance.sourceKinds`, 'array')
    if (!isInt(p.mergeCount) || p.mergeCount < 1) err(`${path}.provenance.mergeCount`, 'integer >= 1')
  }
  return done()
}

/* ── Task ─────────────────────────────────────────────────── */

export function validateTask(task, path = 'task') {
  const { err, done } = make()
  if (!task || typeof task !== 'object') { err(path, 'must be object'); return done() }
  if (!isStr(task.id)) err(`${path}.id`, 'required string')
  if (task.schemaVersion != null && task.schemaVersion !== SCHEMA_VERSION) err(`${path}.schemaVersion`, `must be ${SCHEMA_VERSION}`)
  if (!isStr(task.title)) err(`${path}.title`, 'required string')
  if (!inEnum(task.status, TASK_STATUSES)) err(`${path}.status`, `must be one of ${TASK_STATUSES.join('|')}`)
  for (const k of ['progress', 'nextSteps', 'blockers', 'keywords', 'sessionIds', 'completionCriteria', 'criterionResults', 'completionEvidence']) {
    if (task[k] != null && !Array.isArray(task[k])) err(`${path}.${k}`, 'array')
  }
  const revision = task.revision ?? task.rev
  if (!isInt(revision) || revision < 1) err(`${path}.revision`, 'integer >= 1 (or legacy rev)')

  // T1/T2/T3：完成语义
  if (task.status === 'done') {
    if (!isInt(task.completedAt)) err(`${path}.completedAt`, 'required when done')
    if (!['user', 'tool'].includes(task.completedBy)) err(`${path}.completedBy`, 'must be user|tool when done')
    if (task.completedBy === 'tool') {
      const ev = Array.isArray(task.completionEvidence) ? task.completionEvidence : []
      const verifiedTool = ev.filter((e) => e?.type === 'tool_result' && e?.status === 'verified')
      if (verifiedTool.length === 0) err(`${path}.completionEvidence`, 'completedBy=tool requires a verified tool_result')
    }
  } else if (task.completedAt != null) {
    err(`${path}.completedAt`, 'must be null when status is not done')
  }

  // T5：会话指针一致性
  if (task.activeSessionId != null && Array.isArray(task.sessionIds) && !task.sessionIds.includes(task.activeSessionId)) {
    err(`${path}.activeSessionId`, 'must be included in sessionIds')
  }
  if (task.completionCriteria != null) {
    for (const [i, c] of task.completionCriteria.entries()) {
      if (!isStr(c?.id)) err(`${path}.completionCriteria[${i}].id`, 'required string')
      if (!isStr(c?.type)) err(`${path}.completionCriteria[${i}].type`, 'required string')
    }
  }
  return done()
}

/* ── QueueItem ────────────────────────────────────────────── */

export function validateQueueItem(q, path = 'queueItem') {
  const { err, done } = make()
  if (!q || typeof q !== 'object') { err(path, 'must be object'); return done() }
  if (q.schemaVersion != null && q.schemaVersion !== SCHEMA_VERSION) err(`${path}.schemaVersion`, `must be ${SCHEMA_VERSION}`)
  if (!isStr(q.sessionId)) err(`${path}.sessionId`, 'required string')
  if (!inEnum(q.state, QUEUE_STATES)) err(`${path}.state`, `must be one of ${QUEUE_STATES.join('|')}`)
  if (q.readCursorSeq != null && !isInt(q.readCursorSeq)) err(`${path}.readCursorSeq`, 'integer')
  if (q.committedCursorSeq != null && !isInt(q.committedCursorSeq)) err(`${path}.committedCursorSeq`, 'integer')
  if (isInt(q.readCursorSeq) && isInt(q.committedCursorSeq) && q.committedCursorSeq > q.readCursorSeq) {
    err(`${path}.committedCursorSeq`, 'must be <= readCursorSeq')
  }
  if (q.state === 'retry_wait' && !isInt(q.nextRetryAt)) err(`${path}.nextRetryAt`, 'required when retry_wait')
  if (q.state === 'completed') {
    if (q.nextRetryAt != null) err(`${path}.nextRetryAt`, 'must be null when completed')
    if (q.currentChunkId != null) err(`${path}.currentChunkId`, 'must be null when completed')
  }
  if (!isInt(q.retryCount) || q.retryCount < 0) err(`${path}.retryCount`, 'integer >= 0')
  return done()
}

/* ── 派生（不入库） ───────────────────────────────────────── */

const IMPORTANCE_SCORE = { critical: 1, high: 0.8, medium: 0.5, low: 0.25 }

/** C1：枚举是事实，分值是渲染。 */
export function deriveImportanceScore(importance) {
  return IMPORTANCE_SCORE[importance] ?? 0.5
}

/**
 * 注入权限（M3）：不落库，读取时按 status / confirmationStatus / assertionMode 派生。
 * 这样状态一变，权限自动跟着变，不会出现"权限字段过期"。
 */
export function deriveUsagePolicy(item) {
  const denied = { taskContext: false, factualInjection: false, decisionBasis: false }
  if (!item) return denied
  // S5：疑似历史注入的内容一律不注入（不删除，条目仍在库里可审计）
  if (isItemInjectionRisk(item)) return denied
  if (item.status === 'invalid') return denied
  if (item.confirmationStatus === 'rejected') return denied
  if (item.status === 'superseded') return { taskContext: false, factualInjection: false, decisionBasis: false }
  if (item.status === 'stale') return { taskContext: true, factualInjection: false, decisionBasis: false }

  const confirmed = item.confirmationStatus === 'confirmed'
  const explicit = item.authority === 'user_explicit'
  const derived = item.authority === 'user_derived'
  const assistant = item.authority === 'assistant'
  const hypothesis = item.assertionMode === 'hypothesis'

  const tooled = item.authority === 'tool_verified' || item.source === 'tool'
  const factualInjection = !hypothesis && (confirmed || explicit || tooled)
  // 规则类：约束/偏好本身就是规则；即使 assertionMode 没标 explicit_rule 也算
  const ruleLike = ['constraint', 'preference'].includes(item.type) || ['explicit_rule', 'decision'].includes(item.assertionMode)
  const decisionBasis = !hypothesis && (confirmed || (explicit && ruleLike))
  const taskContext = item.status === 'active' || item.status === 'pending' || confirmed || explicit || derived || assistant

  return { taskContext, factualInjection, decisionBasis }
}

/** M2：跨来源合并时取强，不允许降级。 */
export function mergePrecedence(a, b) {
  const pa = AUTHORITY_RANK[a?.confirmationStatus === 'confirmed' ? 'confirmed' : a?.authority] ?? 0
  const pb = AUTHORITY_RANK[b?.confirmationStatus === 'confirmed' ? 'confirmed' : b?.authority] ?? 0
  const sa = STATUS_RANK[a?.status] ?? 0
  const sb = STATUS_RANK[b?.status] ?? 0
  return {
    authority: pb > pa ? b.authority : a.authority,
    confirmationStatus: (a?.confirmationStatus === 'confirmed' || b?.confirmationStatus === 'confirmed') ? 'confirmed' : (a?.confirmationStatus ?? b?.confirmationStatus),
    status: sb > sa ? b.status : a.status,
  }
}

/* ── 写入前归一化（S1b） ─────────────────────────────────── */

/**
 * 把任意形状的 item 补齐成 v2 结构。
 *
 * 与 normalizeItemV1 的区别：
 *   - 那是"迁移存量"，证据一律 stale（还没回读源会话）；
 *   - 这是"新写入"，证据刚过 quoteMatches 校验，因此 verifyState=verified。
 *
 * 原则：只补缺省值，不改已有关键字段；派生不出来的宁可留空，不猜。
 */
export function coerceItemV2(item, { now = Date.now() } = {}) {
  if (!item || typeof item !== 'object') return item
  // 不要用"看起来像 v2 就直接返回"的短路：迁移窗口期会写出
  // "v2 字段齐全但 source/authority 打架"的混合形状，短路会让它逃过自愈。
  // 下面的逻辑本身幂等（只用 ?? 补缺省）。

  const evidence = (item.evidence ?? []).map((e, i) => ({
    id: e.id ?? `ev_${String(e.sessionId ?? 's').slice(0, 8)}_${e.seq ?? i}`,
    sessionId: e.sessionId,
    seq: e.seq,
    sourceRole: e.sourceRole ?? (e.role === 'assistant' ? 'assistant' : e.role === 'tool' ? 'tool' : 'user'),
    quote: e.quote,
    sourceHash: e.sourceHash ?? null,
    quoteHash: e.quoteHash ?? null,
    sourceVersion: e.sourceVersion ?? 'session_v1',
    verifyState: e.verifyState ?? 'verified',
    createdAt: e.createdAt ?? now,
    verifiedAt: e.verifiedAt ?? now,
  }))

  const fromUser = evidence.some((e) => e.sourceRole === 'user')
  let source = item.source ?? (fromUser ? 'user' : 'assistant')
  let authority = item.authority
  if (!authority || !AUTHORITIES.includes(authority) || authority === 'user_confirmed' || authority === 'user_historical') {
    if (source === 'assistant') authority = 'assistant'
    else if (item.origin === 'llm' || item.origin === 'backfill') authority = 'user_derived'
    else authority = 'user_explicit'
  }
  // 用 authority 反推 source：它是"谁做出的断言"的更强信号，避免 source/authority 打架被拒写
  if (authority === 'assistant') source = 'assistant'
  else if (authority === 'user_explicit' || authority === 'user_derived') source = 'user'

  // S1.5：非决策类条目若有工具证据，升级为 tool_verified（事实类由工具背书最诚实）。
  // 决策/规则类不升级——工具不能证明"用户想这么做"。
  const isDecision = item.type === 'decision'
  if (!isDecision && evidence.some((e) => e.sourceRole === 'tool')) {
    source = 'tool'
    authority = 'tool_verified'
  } else if (source === 'tool' || authority === 'tool_verified') {
    // 反向：标了 tool 却没有工具证据 → 退回 assistant，避免虚标
    if (!evidence.some((e) => e.sourceRole === 'tool')) {
      source = evidence.some((e) => e.sourceRole === 'user') ? 'user' : 'assistant'
      authority = source === 'user' ? 'user_derived' : 'assistant'
    }
  }

  const assertionMode = item.assertionMode ?? (isDecision ? 'decision' : 'fact_assertion')
  const revision = item.revision ?? item.rev ?? 1
  const status = item.status ?? 'active'
  const confirmationStatus = item.confirmationStatus ?? (status === 'invalid' ? 'rejected' : 'unconfirmed')

  const decision = isDecision
    ? (item.decision ?? {
      scope: item.decisionScope === 'temporary' ? 'temporary' : 'permanent',
      status: 'active',
      validFrom: item.createdAt ?? now,
      validUntil: item.decisionScope === 'temporary' ? (item.overrideUntil ?? now + 7 * 864e5) : null,
      baseDecisionId: item.baseDecisionId ?? null,
    })
    : null

  return {
    ...item,
    schemaVersion: SCHEMA_VERSION,
    source,
    authority,
    origin: item.origin ?? 'rule',
    confirmationStatus,
    assertionMode,
    confidence: typeof item.confidence === 'number' ? item.confidence : 0.9,
    importance: IMPORTANCE.includes(item.importance) ? item.importance : 'medium',
    status,
    revision,
    rev: undefined,
    evidence,
    taskId: item.taskId ?? null,
    taskAssignment: item.taskAssignment ?? {
      status: item.taskId ? 'resolved' : 'unresolved',
      taskId: item.taskId ?? null,
      confidence: item.taskId ? 0.8 : 0,
      reason: item.taskId ? 'unique-keyword' : 'no-candidate',
      supportingEvidence: [],
      candidateTaskIds: item.taskId ? [item.taskId] : [],
    },
    decision,
    // v3：知识形态与理由字段。
    // 关键：只有"支撑字段齐全"才保留 kind；否则降为 null（入库但不注入），
    // 避免把推断出的 rationale 但缺 because 的条目写成非法对象。
    knowledgeKind: (() => {
      const k = item.knowledgeKind ?? inferKind(item.text, item.type)
      if (!k) return null
      const f = { because: item.because ?? null, signal: item.signal ?? null, excludes: item.excludes ?? null, observedAt: item.observedAt ?? item.createdAt ?? now }
      return isInjectableKind(k, f) ? k : null
    })(),
    because: item.because ?? null,
    cost: item.cost ?? null,
    failedApproach: item.failedApproach ?? null,
    signal: item.signal ?? null,
    fix: item.fix ?? null,
    excludes: item.excludes ?? null,
    anchors: Array.isArray(item.anchors) ? item.anchors.slice(0, 8) : [],
    validUntil: item.validUntil ?? null,
    observedAt: item.observedAt ?? item.createdAt ?? now,
    recordedAt: item.recordedAt ?? now,
    provenance: item.provenance ?? { firstSeenAt: item.createdAt ?? now, sourceKinds: [source], mergeCount: 1 },
  }
}

/** 写入前归一化 Task（rev → revision，补完成字段）。 */
export function coerceTaskV2(task, { now = Date.now() } = {}) {
  if (!task || typeof task !== 'object') return task
  return {
    ...task,
    schemaVersion: SCHEMA_VERSION,
    revision: task.revision ?? task.rev ?? 1,
    rev: undefined,
    progress: task.progress ?? [],
    nextSteps: task.nextSteps ?? [],
    blockers: task.blockers ?? [],
    keywords: task.keywords ?? [],
    sessionIds: task.sessionIds ?? [],
    activeSessionId: task.activeSessionId ?? null,
    lastSessionId: task.lastSessionId ?? null,
    completionCriteria: task.completionCriteria ?? [],
    criterionResults: task.criterionResults ?? [],
    completionEvidence: task.completionEvidence ?? [],
    completedAt: task.completedAt ?? null,
    completedBy: task.completedBy ?? null,
    createdAt: task.createdAt ?? task.startedAt ?? now,
    updatedAt: task.updatedAt ?? now,
    lastActivityAt: task.lastActivityAt ?? task.updatedAt ?? now,
  }
}

/* ── 迁移（v1 → v2） ─────────────────────────────────────── */

/**
 * 旧条目归一化。关键决议：
 *   - authority=user_confirmed 且有确认记录 → confirmed
 *   - authority=user_confirmed 但无确认记录 → user_derived + unconfirmed（禁止 rev>1 推确认）
 *   - 旧 taskId 一律重算归属：无支持 → unresolved
 */
export function normalizeItemV1(item, { now = Date.now(), hasConfirmRecord = false } = {}) {
  const legacyAuthority = item.authority
  let source = 'user'
  let authority = 'user_explicit'
  let confirmationStatus = 'unconfirmed'

  if (legacyAuthority === 'assistant') { source = 'assistant'; authority = 'assistant' }
  else if (legacyAuthority === 'user_confirmed') {
    if (hasConfirmRecord) { source = 'user'; authority = 'user_explicit'; confirmationStatus = 'confirmed' }
    else { source = 'user'; authority = 'user_derived' }
  } else if (legacyAuthority === 'user_historical') { source = 'user'; authority = 'user_derived' }
  else { source = 'user'; authority = 'user_explicit' }

  const isDecision = item.type === 'decision'
  const assertionMode = isDecision ? 'decision' : 'fact_assertion'
  const revision = item.revision ?? item.rev ?? 1
  const status = confirmationStatus === 'confirmed' ? 'active' : (item.status ?? 'pending')

  // 证据升级：补齐 id / sourceRole / verifyState。
  // 迁移时还没有回读源会话，所以 verifyState 只能是 stale（待重新验证），不能假装 verified。
  const evidence = (item.evidence ?? []).map((e, i) => ({
    id: e.id ?? `ev_${String(e.sessionId ?? 's').slice(0, 8)}_${e.seq ?? i}`,
    sessionId: e.sessionId,
    seq: e.seq,
    sourceRole: e.sourceRole ?? (e.role === 'assistant' ? 'assistant' : e.role === 'tool' ? 'tool' : 'user'),
    quote: e.quote,
    sourceHash: e.sourceHash ?? null,
    quoteHash: e.quoteHash ?? null,
    sourceVersion: e.sourceVersion ?? 'session_v1',
    verifyState: e.verifyState ?? 'stale',
    createdAt: e.createdAt ?? item.createdAt ?? now,
    verifiedAt: e.verifiedAt ?? null,
  }))

  return {
    ...item,
    schemaVersion: SCHEMA_VERSION,
    source,
    authority,
    origin: item.origin ?? 'migration',
    confirmationStatus,
    assertionMode,
    importance: IMPORTANCE.includes(item.importance) ? item.importance : 'medium',
    confidence: isNum(item.confidence) ? item.confidence : 0.8,
    status,
    revision,
    rev: undefined,
    evidence,
    taskId: null,
    taskAssignment: { status: 'unresolved', taskId: null, confidence: 0, reason: 'insufficient-evidence', supportingEvidence: [], candidateTaskIds: [] },
    decision: isDecision
      ? { scope: item.decisionScope === 'temporary' ? 'temporary' : 'permanent', status: 'active', validFrom: item.createdAt ?? now, validUntil: item.decisionScope === 'temporary' ? (item.overrideUntil ?? null) : null }
      : null,
    observedAt: item.observedAt ?? item.createdAt ?? now,
    recordedAt: item.recordedAt ?? item.updatedAt ?? now,
    provenance: { firstSeenAt: item.createdAt ?? now, sourceKinds: [source], mergeCount: 1 },
  }
}

/** 队列项归一化（v1 的 done/failed/cursorSeq → v2 的双游标与六态）。 */
export function coerceQueueItemV2(s, { now = Date.now() } = {}) {
  const legacy = { done: 'completed', failed: 'retry_wait', pending: 'pending', processing: 'processing', skipped: 'skipped' }
  const state = QUEUE_STATES.includes(s?.state) ? s.state : (legacy[s?.state] ?? 'pending')
  const cursor = s?.cursorSeq ?? s?.committedCursorSeq ?? null
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: s?.sessionId,
    state,
    readCursorSeq: s?.readCursorSeq ?? cursor,
    committedCursorSeq: s?.committedCursorSeq ?? cursor,
    currentChunkId: s?.currentChunkId ?? null,
    chunksCompleted: s?.chunksCompleted ?? s?.chunks ?? 0,
    eventsRead: s?.eventsRead ?? 0,
    retryCount: s?.retryCount ?? 0,
    nextRetryAt: s?.nextRetryAt ?? (state === 'retry_wait' ? now + 60_000 : null),
    lastError: s?.lastError ?? s?.note ?? null,
    createdAt: s?.createdAt ?? now,
    updatedAt: s?.updatedAt ?? now,
  }
}
