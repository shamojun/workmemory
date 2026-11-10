/**
 * S3：回填队列契约（预算、重试、总量、跳过）。
 *   node packages/workmemory/test/s3.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BackfillQueue } from '../lib/backfill.js'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  if (!ok) console.error('FAIL', name, JSON.stringify(detail))
}

const mkQueue = (dir, opts = {}) => new BackfillQueue({ dir, logger: { warn() {} }, ...opts })
const find = (q, id) => q.state.sessions.find((s) => s.sessionId === id)
const found = (...ids) => ids.map((id, i) => ({ header: { id, createdAt: Date.now() - i * 86_400_000 } }))

/* 1) 预算：每轮会话数 + 跨会话总段数 */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-s3-a-'))
  const q = mkQueue(dir)
  q.discover(found('s1', 's2', 's3', 's4'))
  const batch = q.nextBatch({ limit: 3 })
  check('budget limits sessions per run', batch.length === 3, batch.length)

  // 模拟两轮：每轮 2 段
  q.markChunk('s1', 40)
  q.markChunk('s1', 80)
  q.markDone('s1')
  const summary = q.summary()
  check('chunks counted per session', summary.chunks === 2, summary)
  fs.rmSync(dir, { recursive: true, force: true })
}

/* 2) retry_wait 到点才回池 */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-s3-b-'))
  const q = mkQueue(dir, { retryBackoffMs: 60_000 })
  q.discover(found('r1'))
  q.markFailed('r1', 'model_timeout')
  const s = find(q, 'r1')
  check('failure goes to retry_wait', s.state === 'retry_wait' && s.retryCount === 1, s)
  check('not in batch before nextRetryAt', q.nextBatch({ limit: 3 }).length === 0, q.nextBatch({ limit: 3 }).length)
  check('back in batch after nextRetryAt', q.nextBatch({ limit: 3, now: s.nextRetryAt + 1 }).length === 1)
  fs.rmSync(dir, { recursive: true, force: true })
}

/* 3) 超过 maxRetries → failed（人工处理），不再回池 */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-s3-c-'))
  const q = mkQueue(dir, { maxRetries: 2, retryBackoffMs: 1 })
  q.discover(found('f1'))
  for (let i = 0; i < 3; i += 1) {
    q.markFailed('f1', 'timeout')
    // 让退避立刻到点，模拟时间推进
    const s = find(q, 'f1')
    if (s.nextRetryAt) s.nextRetryAt = Date.now() - 1
  }
  const s = find(q, 'f1')
  check('exhausted retries become failed', s.state === 'failed' && s.retryCount === 3, s)
  check('failed not in batch', q.nextBatch({ limit: 3 }).length === 0)
  fs.rmSync(dir, { recursive: true, force: true })
}

/* 4) 会话被删除 → skipped，不重试 */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-s3-d-'))
  const q = mkQueue(dir)
  q.discover(found('x1'))
  q.markSkipped('x1', 'session not found')
  const s = find(q, 'x1')
  check('skipped state kept', s.state === 'skipped' && s.lastError?.includes('not found'), s)
  check('skipped not in batch', q.nextBatch({ limit: 3 }).length === 0)
  fs.rmSync(dir, { recursive: true, force: true })
}

/* 5) 总量上限：null=不限，设置了就不再扩 */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-s3-e-'))
  const unlimited = mkQueue(dir, { totalSessionLimit: null })
  unlimited.discover(found('a', 'b', 'c', 'd', 'e'))
  check('null limit accepts all', unlimited.state.sessions.length === 5, unlimited.state.sessions.length)

  const limited = mkQueue(fs.mkdtempSync(path.join(os.tmpdir(), 'wm-s3-e2-')), { totalSessionLimit: 3 })
  const added = limited.discover(found('f', 'g', 'h', 'i'))
  check('limit stops discovery', limited.state.sessions.length === 3 && added === 3, { total: limited.state.sessions.length, added })
  fs.rmSync(dir, { recursive: true, force: true })
}

/* 6) 幂等：重复 discover 不重复入队；重复 markChunk 不重复计数到已提交游标 */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-s3-f-'))
  const q = mkQueue(dir)
  q.discover(found('i1', 'i2'))
  q.discover(found('i1', 'i2'))
  check('discover idempotent', q.state.sessions.length === 2, q.state.sessions.length)
  q.markChunk('i1', 40)
  q.markChunk('i1', 80)
  const s = find(q, 'i1')
  check('cursor monotonic', s.committedCursorSeq === 80 && s.readCursorSeq === 80, s)
  check('committed <= read', s.committedCursorSeq <= s.readCursorSeq)
  fs.rmSync(dir, { recursive: true, force: true })
}

/* 7) 持久化：重载后状态与游标一致 */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-s3-g-'))
  const q = mkQueue(dir)
  q.discover(found('p1'))
  q.markChunk('p1', 120)
  q.markFailed('p1', 'timeout')
  const reloaded = mkQueue(dir)
  const s = find(reloaded, 'p1')
  check('reload keeps cursor', s.committedCursorSeq === 120, s)
  check('reload keeps retry state', s.state === 'retry_wait' && s.retryCount === 1, s)
  fs.rmSync(dir, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(JSON.stringify({ total: results.length, failed: failed.length, failures: failed.map((f) => f.name) }, null, 2))
process.exit(failed.length ? 1 : 0)
