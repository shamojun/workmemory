/**
 * S2：事实归属任务（三态 + 判定顺序）。
 *   node packages/workmemory/test/s2.test.mjs
 */
import { assignTask, keywordSimilarity, taskKeywords, AMBIGUITY_THRESHOLD } from '../lib/continuity.js'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  if (!ok) console.error('FAIL', name, JSON.stringify(detail))
}

const tasks = [
  { id: 'task_sync', title: 'MongoDB 数据同步', status: 'active', keywords: ['mongodb', 'mongoshake', '增量同步'] },
  { id: 'task_deploy', title: 'MongoDB 集群部署', status: 'active', keywords: ['mongodb', '集群', '副本集'] },
  { id: 'task_jenkins', title: 'Jenkins 构建排查', status: 'active', keywords: ['jenkins', 'maven', '流水线'] },
]

/* 1) 歧义阈值针对"近乎同名的任务"；同领域但不同的任务靠"多候选命中"判定 */
{
  const nearDup = { id: 'task_sync2', title: 'MongoDB 数据同步优化', status: 'active', keywords: ['mongodb', 'mongoshake', '延迟'] }
  const sim = keywordSimilarity(taskKeywords(tasks[0]), taskKeywords(nearDup))
  check('near-duplicate tasks cross threshold', sim >= AMBIGUITY_THRESHOLD, { sim, threshold: AMBIGUITY_THRESHOLD })
  const distinct = keywordSimilarity(taskKeywords(tasks[0]), taskKeywords(tasks[1]))
  check('distinct same-domain tasks stay below threshold', distinct < AMBIGUITY_THRESHOLD, distinct)
  const jsim = keywordSimilarity(taskKeywords(tasks[0]), taskKeywords(tasks[2]))
  check('sync vs jenkins dissimilar', jsim < AMBIGUITY_THRESHOLD, jsim)
}

/* 2) 显式标题 */
{
  const r1 = assignTask({ text: 'MongoDB 数据同步 这块的增量延迟要降到 1 秒内', tasks })
  check('explicit title wins', r1.status === 'resolved' && r1.taskId === 'task_sync' && r1.reason === 'explicit-title', r1)
}

/* 3) 唯一关键词 */
{
  const r = assignTask({ text: 'mongoshake 的 checkpoints 表要不要清理', tasks })
  check('unique keyword resolves', r.status === 'resolved' && r.taskId === 'task_sync' && r.reason === 'unique-keyword', r)
}

/* 4) 歧义：两个同领域任务都被命中 */
{
  const r = assignTask({ text: 'mongodb 这边集群和增量同步都要看', tasks })
  check('same-domain ambiguity unresolved', r.status === 'unresolved' && r.taskId === null && r.reason === 'ambiguous', r)
}

/* 5) 无支持 → 不猜 */
{
  const r = assignTask({ text: 'Kafka 的 topic 分区数怎么定', tasks })
  check('no support stays unresolved', r.status === 'unresolved' && r.taskId === null, r)
}

/* 6) 模型 id 合法 + 有文本支持 */
{
  const r = assignTask({ text: 'jenkins 流水线又挂了', tasks, modelTaskId: 'task_jenkins' })
  check('model id backed by support', r.status === 'resolved' && r.taskId === 'task_jenkins', r)
}

/* 7) 模型 id 非法 → rejected（不是 unresolved） */
{
  const r = assignTask({ text: 'jenkins 流水线又挂了', tasks, modelTaskId: 'task_ghost' })
  check('invalid model id rejected', r.status === 'rejected' && r.reason === 'invalid-id', r)
}

/* 8) 当前会话绑定：唯一支持时信任 */
{
  const r = assignTask({ text: '这个增量同步的 checkpoint 存在哪', tasks, currentTaskId: 'task_sync' })
  check('bound task trusted when unique', r.status === 'resolved' && r.taskId === 'task_sync' && r.reason === 'active-task-and-topic', r)
}

/* 9) 绑定任务存在，但用户点名了别的任务标题 → 以点名为准 */
{
  const r = assignTask({ text: 'Jenkins 构建排查 那边先停一下', tasks, currentTaskId: 'task_sync' })
  check('explicit other title beats binding', r.status === 'resolved' && r.taskId === 'task_jenkins' && r.reason === 'explicit-title', r)
}

/* 10) 已结束/放弃的任务不参与归属 */
{
  const closed = [
    { id: 'task_old', title: 'MongoDB 数据同步', status: 'done', keywords: ['mongodb', 'mongoshake'] },
    { id: 'task_jenkins', title: 'Jenkins 构建排查', status: 'active', keywords: ['jenkins'] },
  ]
  const r = assignTask({ text: 'mongoshake 的同步延迟', tasks: closed })
  check('closed task excluded', r.status === 'unresolved' && r.taskId === null, r)
}

/* 11) 关键词在证据原文里也算（条目正文只有结论） */
{
  const r = assignTask({ text: '流水线挂了', context: 'jenkins 流水线挂了 InvalidAgentException', tasks })
  check('evidence context counts', r.status === 'resolved' && r.taskId === 'task_jenkins', r)
}

/* 12) todo 任务可被点名激活归属 */
{
  const withTodo = [
    ...tasks,
    { id: 'task_todo', title: 'Kafka 部署', status: 'todo', keywords: ['kafka', 'zookeeper'] },
  ]
  const r = assignTask({ text: 'kafka 的 zookeeper 用几副本', tasks: withTodo })
  check('todo task can be attributed', r.status === 'resolved' && r.taskId === 'task_todo', r)
}

/* 13) 存量重算：有上限，避免一个任务吃掉整库 */
{
  const { ItemsStore } = await import('../lib/items.js')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-reattr-'))
  const st = new ItemsStore({ dir, logger: { warn() {} } })
  const now = Date.now()
  const base = {
    type: 'gotcha', status: 'active', source: 'tool', authority: 'tool_verified',
    confirmationStatus: 'unconfirmed', assertionMode: 'fact_assertion', importance: 'high', decision: null,
    taskAssignment: { status: 'unresolved', taskId: null, confidence: 0, reason: 'no-candidate' },
    revision: 1, observedAt: now, recordedAt: now, createdAt: now, updatedAt: now,
  }
  const ev = (q) => ({ id: 'e1', sessionId: 's', seq: 1, sourceRole: 'tool', quote: q, verifyState: 'verified', verifiedAt: now })
  st.append({ ...base, id: 'm1', text: 'jenkins 流水线挂了', evidence: [ev('jenkins 流水线挂了 InvalidAgent')] })
  st.append({ ...base, id: 'm2', text: 'mongoshake 增量延迟高', evidence: [ev('mongoshake 增量延迟')] })
  st.append({ ...base, id: 'm3', text: 'kafka 分区数怎么定', evidence: [ev('kafka 分区')] })
  const n = st.reattribute(
    [{ id: 't_j', title: 'Jenkins 构建排查', status: 'active', keywords: ['jenkins'] },
      { id: 't_s', title: 'MongoDB 数据同步', status: 'active', keywords: ['mongodb', 'mongoshake'] }],
    { maxPerTask: 1 },
  )
  check('reattribute fills unresolved', n === 2, n)
  check('reattribute keeps unrelated global', st.get('m3')?.taskId === null, st.get('m3')?.taskAssignment)
  check('reattribute respects cap', st.get('m1')?.taskId === 't_j' && st.get('m2')?.taskId === 't_s')
  fs.rmSync(dir, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(JSON.stringify({ total: results.length, failed: failed.length, failures: failed.map((f) => f.name) }, null, 2))
process.exit(failed.length ? 1 : 0)
