/**
 * F13 / F14：简报诚实性。
 *   node packages/workmemory/test/s9.test.mjs
 */
import { buildBrief } from '../lib/brief.js'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  if (!ok) console.error('FAIL', name, JSON.stringify(detail))
}

const now = Date.now()
const cfg = { brief: { enabled: true, maxChars: 20000, recentSessions: 5, showUnverified: true, unverifiedMax: 10, collapse: true } }
const ws = { root: '/x/w', dir: '/x/.dsh/memory' }

const item = (id, text) => ({
  id, schemaVersion: 3, type: 'gotcha', knowledgeKind: 'lesson', text,
  failedApproach: '直接拆子句', signal: '因为: -', fix: '整句层先找因果',
  status: 'active', source: 'tool', authority: 'tool_verified',
  confirmationStatus: 'unconfirmed', assertionMode: 'fact_assertion', importance: 'high',
  decision: null, taskAssignment: { status: 'unresolved', taskId: null, confidence: 0, reason: 'no-candidate' },
  evidence: [{ id: 'e', sessionId: 's', seq: 1, sourceRole: 'tool', quote: '因为: -', verifyState: 'verified', verifiedAt: now }],
  revision: 1, observedAt: now, recordedAt: now, createdAt: now, updatedAt: now,
})

/* F13：结尾必须声明"不是全部记忆"并给出覆盖率 */
{
  const items = [item('m1', '因果句要整句拆'), item('m2', '未读文件不能编辑')]
  const brief = buildBrief({ ws, digests: [], items, config: cfg, now })
  check('footer says summary not all', brief.includes('不是全部记忆'), brief.split('\n').slice(-3).join('\n'))
  check('footer shows injected count', /本轮 \d+ 条/.test(brief), brief.split('\n').slice(-3))
  check('footer shows hidden count', /未列出 \d+ 条/.test(brief), brief.split('\n').slice(-3))
  check('footer keeps conflict rule', brief.includes('以当前为准'), brief.split('\n').slice(-2))
  check('footer points to recall', brief.includes('memory_recall'))
}

/* F13：计数与条目数一致 */
{
  const items = [item('a', '甲'), item('b', '乙'), item('c', '丙')]
  const brief = buildBrief({ ws, digests: [], items, config: cfg, now, task: { id: 't', title: 'T', status: 'active', lastActivityAt: now } })
  const m = brief.match(/本轮 (\d+) 条；库内共 (\d+) 条，未列出 (\d+) 条/)
  check('counts are consistent', m && Number(m[2]) === items.length && Number(m[1]) + Number(m[3]) === Number(m[2]), m)
}

/* F14：匹配不到摘要时不得断言"没有记录" */
{
  const brief = buildBrief({ ws, digests: [], items: [], config: cfg, now, task: { id: 't', title: 'T', status: 'active', lastActivityAt: now } })
  check('no-digest wording is conservative', brief.includes('未找到本任务相关的会话摘要'), brief)
  check('never claims no records', !brief.includes('暂无会话记录'), brief)
  check('points to recall in fallback', brief.includes('memory_recall'), brief)
}

const failed = results.filter((r) => !r.ok)
console.log(JSON.stringify({ total: results.length, failed: failed.length, failures: failed.map((f) => f.name) }, null, 2))
process.exit(failed.length ? 1 : 0)
