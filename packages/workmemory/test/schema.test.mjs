/**
 * 数据契约校验器用例（v3.1.2.1-final）。
 *
 *   node packages/workmemory/test/schema.test.mjs
 *
 * 覆盖：字段级约束、跨字段不变式（C3/C4/C6）、派生函数、v1→v2 迁移。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateItem, validateTask, validateQueueItem, validateEvidence,
  deriveImportanceScore, deriveUsagePolicy, mergePrecedence,
  SCHEMA_VERSION,
} from '../lib/schema.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  if (!ok) console.error('FAIL', name, JSON.stringify(detail))
}

const now = Date.now()

function baseItem(over = {}) {
  return {
    id: 'mem_test_1',
    schemaVersion: SCHEMA_VERSION,
    type: 'gotcha',
    text: '沙箱下写文件会被拒绝',
    source: 'user',
    origin: 'rule',
    authority: 'user_explicit',
    confirmationStatus: 'unconfirmed',
    assertionMode: 'fact_assertion',
    confidence: 0.9,
    importance: 'high',
    status: 'active',
    taskId: null,
    taskAssignment: { status: 'unresolved', taskId: null, confidence: 0, reason: 'no-candidate', supportingEvidence: [], candidateTaskIds: [] },
    decision: null,
    evidence: [{ id: 'ev1', sessionId: 's1', seq: 5, sourceRole: 'user', quote: '写文件被拒绝', verifyState: 'verified', verifiedAt: now }],
    topics: ['沙箱'],
    revision: 1,
    observedAt: now - 1000,
    recordedAt: now,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

/* ── 字段级 ── */
check('valid item passes', validateItem(baseItem()).ok, validateItem(baseItem()).errors)
check('text too short rejected', !validateItem(baseItem({ text: '短' })).ok)
check('bad enum rejected', !validateItem(baseItem({ type: 'nope' })).ok)
check('schemaVersion mismatch rejected', !validateItem(baseItem({ schemaVersion: 1 })).ok)

/* ── S1.5：tool 已解除 reserved ── */
const toolItem = (over = {}) => baseItem({
  source: 'tool',
  authority: 'tool_verified',
  evidence: [{ id: 'ev_t', sessionId: 's1', seq: 9, sourceRole: 'tool', quote: 'FS_SANDBOX_DENIED', verifyState: 'verified', verifiedAt: now }],
  ...over,
})
check('tool item valid', validateItem(toolItem()).ok, validateItem(toolItem()).errors)
check('source=tool requires tool_verified', !validateItem(toolItem({ authority: 'assistant' })).ok)
check('tool_verified requires source=tool', !validateItem(toolItem({ source: 'assistant' })).ok)
const toolPolicy = deriveUsagePolicy(toolItem())
check('tool evidence is injectable fact', toolPolicy.factualInjection === true && toolPolicy.decisionBasis === false, toolPolicy)

/* ── 来源一致性 ── */
check('assistant with user_explicit rejected', !validateItem(baseItem({ source: 'assistant', authority: 'user_explicit' })).ok)
check('user_explicit with assistant source rejected', !validateItem(baseItem({ source: 'assistant', authority: 'user_explicit' })).ok)
check('assistant ok', validateItem(baseItem({ source: 'assistant', authority: 'assistant', assertionMode: 'fact_assertion' })).ok)

/* ── C3 归属镜像 ── */
check('resolved mirrors taskId', validateItem(baseItem({
  taskId: 'task_a',
  taskAssignment: { status: 'resolved', taskId: 'task_a', confidence: 0.9, reason: 'unique-keyword', supportingEvidence: ['kw'], candidateTaskIds: ['task_a'] },
})).ok)
check('resolved but taskId mismatch rejected', !validateItem(baseItem({
  taskId: 'task_b',
  taskAssignment: { status: 'resolved', taskId: 'task_a', confidence: 0.9, reason: 'unique-keyword' },
})).ok)
check('unresolved requires null taskId', !validateItem(baseItem({
  taskId: 'task_a',
  taskAssignment: { status: 'unresolved', taskId: null, confidence: 0.1, reason: 'ambiguous' },
})).ok)

/* ── C4 decision 互斥 ── */
const decisionBase = {
  type: 'decision',
  assertionMode: 'decision',
  decision: { scope: 'permanent', status: 'active', validFrom: now },
}
check('decision with decision object ok', validateItem(baseItem(decisionBase)).ok, validateItem(baseItem(decisionBase)).errors)
check('decision type without object rejected', !validateItem(baseItem({ type: 'decision', assertionMode: 'fact_assertion' })).ok)
check('non-decision with object rejected', !validateItem(baseItem({ decision: { scope: 'permanent', status: 'active' } })).ok)
check('temporary requires validUntil', !validateItem(baseItem({ ...decisionBase, decision: { scope: 'temporary', status: 'active' } })).ok)
check('permanent forbids validUntil', !validateItem(baseItem({ ...decisionBase, decision: { scope: 'permanent', status: 'active', validUntil: now } })).ok)
check('temporary_intent on decision rejected', !validateItem(baseItem({ ...decisionBase, assertionMode: 'temporary_intent' })).ok)

/* ── 时间语义（M1） ── */
check('observedAt > recordedAt rejected', !validateItem(baseItem({ observedAt: now + 10 })).ok)

/* ── 证据 ── */
check('empty evidence rejected', !validateItem(baseItem({ evidence: [] })).ok)
check('short quote rejected', !validateEvidence({ id: 'e', sessionId: 's', seq: 1, sourceRole: 'user', quote: '短', verifyState: 'verified', verifiedAt: now }).ok)
check('sha256 format enforced', !validateEvidence({ id: 'e', sessionId: 's', seq: 1, sourceRole: 'user', quote: '足够长的引用', verifyState: 'unverified'.replace('unverified', 'unverifiable'), sourceHash: 'sha1:abc' }).ok)

/* ── 派生 ── */
check('importance score mapping', deriveImportanceScore('critical') === 1 && deriveImportanceScore('low') === 0.25)
const p1 = deriveUsagePolicy(baseItem({ confirmationStatus: 'unconfirmed', authority: 'user_derived' }))
check('derived item not factual', p1.taskContext === true && p1.factualInjection === false && p1.decisionBasis === false, p1)
const p2 = deriveUsagePolicy(baseItem({ authority: 'user_explicit', assertionMode: 'explicit_rule' }))
check('explicit rule is decision basis', p2.factualInjection === true && p2.decisionBasis === true, p2)
const p3 = deriveUsagePolicy(baseItem({ status: 'superseded' }))
check('superseded denied', p3.factualInjection === false && p3.taskContext === false, p3)
const p4 = deriveUsagePolicy(baseItem({ assertionMode: 'hypothesis' }))
check('hypothesis not factual', p4.factualInjection === false, p4)
const p5 = deriveUsagePolicy(baseItem({ status: 'invalid' }))
check('invalid denied', p5.taskContext === false && p5.factualInjection === false, p5)

/* ── 合并取强（M2） ── */
const merged = mergePrecedence(
  { authority: 'assistant', confirmationStatus: 'unconfirmed', status: 'pending' },
  { authority: 'user_explicit', confirmationStatus: 'unconfirmed', status: 'active' },
)
check('merge takes stronger authority', merged.authority === 'user_explicit' && merged.status === 'active', merged)
const merged2 = mergePrecedence(
  { authority: 'user_derived', confirmationStatus: 'confirmed', status: 'active' },
  { authority: 'assistant', confirmationStatus: 'unconfirmed', status: 'active' },
)
check('merge keeps confirmed', merged2.confirmationStatus === 'confirmed', merged2)

/* ── Task ── */
function baseTask(over = {}) {
  return {
    id: 'task_t', title: '排查 Jenkins', status: 'active', revision: 1,
    sessionIds: ['s1'], activeSessionId: 's1', progress: [], nextSteps: [], blockers: [],
    completedAt: null, completedBy: null, ...over,
  }
}
check('valid task passes', validateTask(baseTask()).ok, validateTask(baseTask()).errors)
check('done without completedAt rejected', !validateTask(baseTask({ status: 'done' })).ok)
check('done with user ok', validateTask(baseTask({ status: 'done', completedAt: now, completedBy: 'user', completionEvidence: [{ id: 'c1', type: 'user_confirmation', status: 'verified' }] })).ok)
check('done by tool without verified evidence rejected', !validateTask(baseTask({ status: 'done', completedAt: now, completedBy: 'tool', completionEvidence: [] })).ok)
check('done by tool with verified evidence ok', validateTask(baseTask({ status: 'done', completedAt: now, completedBy: 'tool', completionEvidence: [{ id: 'c1', type: 'tool_result', status: 'verified' }] })).ok)
check('not done but completedAt set rejected', !validateTask(baseTask({ completedAt: now })).ok)
check('activeSessionId must be in sessionIds', !validateTask(baseTask({ activeSessionId: 's9' })).ok)

/* ── Queue ── */
function baseQueue(over = {}) {
  return { schemaVersion: SCHEMA_VERSION, sessionId: 's1', state: 'pending', readCursorSeq: null, committedCursorSeq: null, currentChunkId: null, chunksCompleted: 0, eventsRead: 0, retryCount: 0, nextRetryAt: null, lastError: null, ...over }
}
check('valid queue passes', validateQueueItem(baseQueue()).ok, validateQueueItem(baseQueue()).errors)
check('committed > read rejected', !validateQueueItem(baseQueue({ readCursorSeq: 10, committedCursorSeq: 20 })).ok)
check('retry_wait requires nextRetryAt', !validateQueueItem(baseQueue({ state: 'retry_wait' })).ok)
check('completed forbids nextRetryAt', !validateQueueItem(baseQueue({ state: 'completed', nextRetryAt: now })).ok)
check('completed forbids currentChunkId', !validateQueueItem(baseQueue({ state: 'completed', currentChunkId: 'c1' })).ok)

/* ── S1b：加载时自愈混合形状 ─────────────────────────────── */
{
  const { ItemsStore } = await import('../lib/items.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-heal-'))
  const base = {
    id: 'mem_h1', type: 'preference', text: '以后统一用 pnpm 管理依赖', status: 'active',
    authority: 'user_confirmed', confidence: 0.9, importance: 'high',
    evidence: [{ sessionId: 's', seq: 1, sourceRole: 'user', quote: '以后统一用 pnpm 管理依赖' }],
    createdAt: Date.now(), updatedAt: Date.now(), rev: 2,
  }
  const hybrid = {
    ...base, id: 'mem_h2', schemaVersion: 2, source: 'user', authority: 'assistant',
    taskAssignment: { status: 'unresolved', taskId: null, confidence: 0, reason: 'no-candidate' },
    decision: null, revision: 1,
  }
  fs.writeFileSync(path.join(dir, 'items.jsonl'), `${[base, hybrid].map((x) => JSON.stringify(x)).join('\n')}\n`)
  const st = new ItemsStore({ dir, logger: { warn() {} } })
  const all = st.list()
  check('load normalizes legacy + hybrid', all.length === 2 && all.every((i) => validateItem(i).ok), all.map((i) => validateItem(i).errors))
  const onDisk = fs.readFileSync(path.join(dir, 'items.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  check('rewrites file to current schema', onDisk.every((i) => i.schemaVersion === SCHEMA_VERSION), onDisk.map((i) => i.schemaVersion))
  check('hybrid source reconciled', all.find((i) => i.id === 'mem_h2')?.source === 'assistant', all.find((i) => i.id === 'mem_h2')?.source)
  fs.rmSync(dir, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(JSON.stringify({ total: results.length, failed: failed.length, failures: failed.map((f) => f.name) }, null, 2))
process.exit(failed.length ? 1 : 0)
