/**
 * S6a：读时折叠（cluster / brief / search）。
 *   node packages/workmemory/test/s6.test.mjs
 */
import { clusterItems, collapse, sameEvent, conflictingIdentifiers, CLUSTER_THRESHOLD } from '../lib/cluster.js'
import { buildBrief } from '../lib/brief.js'
import { search } from '../lib/retrieval.js'
import { deriveUsagePolicy } from '../lib/schema.js'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  if (!ok) console.error('FAIL', name, JSON.stringify(detail))
}

const now = Date.now()
const mk = (over) => ({
  id: `mem_${Math.random().toString(36).slice(2, 8)}`,
  type: 'gotcha',
  status: 'active',
  source: 'tool',
  authority: 'tool_verified',
  confirmationStatus: 'unconfirmed',
  assertionMode: 'fact_assertion',
  importance: 'high',
  decision: null,
  taskAssignment: { status: 'unresolved', taskId: null, confidence: 0, reason: 'no-candidate' },
  evidence: [{ id: 'e', sessionId: 's', seq: 1, sourceRole: 'tool', quote: 'file has not been read', verifyState: 'verified', verifiedAt: now }],
  revision: 1,
  observedAt: now,
  recordedAt: now,
  createdAt: now,
  updatedAt: now,
  ...over,
})

const a = mk({ text: '修改已存在的文件前必须先读取，否则工具报 file has not been read' })
const b = mk({ text: '修改已存在的文件前必须先读取该文件，否则工具直接拒绝写入' })
const c = mk({ text: 'PowerShell 下单行 node -e 含引号会报 ParserError' })

/* ── 分组 ── */
{
  const cl = clusterItems([a, b, c])
  check('same fact clustered', cl.length === 2, cl.map((x) => x.size))
  check('cluster keeps lead', cl[0].size === 2)
  check('unrelated stays separate', cl[1].lead.id === c.id)
}

/* ── 边界：标识符冲突 & 否定极性 ── */
{
  const p1 = mk({ type: 'state', text: '记忆 S3、S4 已完成，94 项用例全绿' })
  const p2 = mk({ type: 'state', text: 'P0-2 已完成，113 项用例全绿' })
  check('conflicting identifiers detected', conflictingIdentifiers(p1.text, p2.text) === true)
  check('different progress not merged', clusterItems([p1, p2]).length === 2, clusterItems([p1, p2]).map((x) => x.size))

  const n1 = mk({ type: 'decision', text: '近似去重使用 Jaccard 阈值判定重复' })
  const n2 = mk({ type: 'decision', text: '近似去重不使用 Jaccard 阈值判定重复' })
  check('negation polarity blocks merge', clusterItems([n1, n2]).length === 2)

  // 一方有标识符、一方没有 → 不算冲突（同一事实的不同表述）
  const s1 = mk({ type: 'gotcha', text: 'maxTokens 设置过小会截断模型返回的多条目 JSON，导致解析失败' })
  const s2 = mk({ type: 'gotcha', text: 'maxTokens 过小（1200）会截断多条目 JSON，导致解析失败' })
  check('one-sided identifiers still merge', clusterItems([s1, s2]).length === 1, clusterItems([s1, s2]).map((x) => x.size))
}

/* ── 折叠展示 ── */
{
  const collapsed = collapse([a, b, c])
  check('collapse reports duplicate count', collapsed.find((x) => x.duplicates === 1) !== undefined, collapsed.map((x) => x.duplicates))

  const config = { brief: { enabled: true, maxChars: 3600, recentSessions: 5, showUnverified: true, collapse: true } }
  const brief = buildBrief({ ws: { root: '/tmp/ws', dir: '/tmp/ws/.dsh/memory' }, digests: [], items: [a, b, c], config, now })
  check('brief shows duplicate hint', /另 1 条相似/.test(brief), brief)
  const lines = brief.split('\n').filter((l) => l.startsWith('- ') && l.includes('file has not been read'))
  check('brief shows fact once', lines.length === 1, lines)
}

/* ── 检索折叠 ── */
{
  const hits = search([a, b, c], '文件读取报错', { limit: 5, policy: 'fact' })
  const similar = hits.filter((h) => h.item.id === a.id || h.item.id === b.id)
  check('search returns one slot per fact', similar.length === 1, similar.map((h) => h.item.text.slice(0, 20)))
  const raw = search([a, b, c], '文件读取报错', { limit: 5, policy: 'fact', collapse: false })
  check('collapse can be disabled', raw.filter((h) => h.item.id === a.id || h.item.id === b.id).length === 2)
}

/* ── 代表项选择：更可信的当代表 ── */
{
  const weak = mk({ text: '沙箱禁止写入 .dsh/memory 目录', authority: 'assistant', source: 'assistant', status: 'pending' })
  const strong = mk({ text: '沙箱禁止写入 .dsh/memory 目录下任何文件', status: 'active' })
  const cl = clusterItems([weak, strong])
  check('lead prefers stronger authority', cl.length === 1 && cl[0].lead.authority === 'tool_verified', cl[0]?.lead?.authority)
}

const failed = results.filter((r) => !r.ok)
console.log(JSON.stringify({ total: results.length, failed: failed.length, failures: failed.map((f) => f.name) }, null, 2))
process.exit(failed.length ? 1 : 0)
