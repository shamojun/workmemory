/**
 * v3 知识形态（设计文档 v2.0 P0-1）。
 *   node packages/workmemory/test/s8.test.mjs
 */
import { validateItem, coerceItemV2, SCHEMA_VERSION } from '../lib/schema.js'
import { inferKind, isValueOnly, isInjectableKind, KINDS } from '../lib/knowledge.js'
import { distill } from '../lib/distiller.js'
import { buildBrief } from '../lib/brief.js'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  if (!ok) console.error('FAIL', name, JSON.stringify(detail))
}

const now = Date.now()
const base = (over) => ({
  id: 'mem_k1',
  schemaVersion: SCHEMA_VERSION,
  type: 'decision',
  text: 'Jenkins core 锁死 2.387.3',
  source: 'user',
  origin: 'llm',
  authority: 'user_derived',
  confirmationStatus: 'unconfirmed',
  assertionMode: 'decision',
  decision: { scope: 'permanent', status: 'active' },
  confidence: 0.9,
  importance: 'high',
  status: 'active',
  taskId: null,
  taskAssignment: { status: 'unresolved', taskId: null, confidence: 0, reason: 'no-candidate' },
  evidence: [{ id: 'e1', sessionId: 's', seq: 1, sourceRole: 'user', quote: '必须锁死 2.387.3', verifyState: 'verified', verifiedAt: now }],
  revision: 1,
  observedAt: now,
  recordedAt: now,
  ...over,
})

/* ── 契约：kind 与支撑字段 ── */
check('schema version is 3', SCHEMA_VERSION === 3)
check('rationale without because rejected', !validateItem(base({ knowledgeKind: 'rationale' })).ok)
check('rationale with because ok', validateItem(base({ knowledgeKind: 'rationale', because: '新版签名校验变了' })).ok)
check('lesson without signal rejected', !validateItem(base({ knowledgeKind: 'lesson', type: 'gotcha' })).ok)
check('unknown kind rejected', !validateItem(base({ knowledgeKind: 'nonsense' })).ok)
check('null kind allowed (低价值陈述)', validateItem(base({ knowledgeKind: null })).ok)

/* ── 推断与值抑制 ── */
check('infer rationale', inferKind('锁死 2.387.3，因为新版签名校验变了', 'decision') === 'rationale')
check('infer scope', inferKind('迁移不含 Job 与构建历史', 'open') === 'scope')
check('infer lesson', inferKind('整份覆盖会冲掉 LDAP，报错登录 500', 'gotcha') === 'lesson')
check('value-only detected', isValueOnly('脚本在 scripts/acceptance-30d.mjs') === true)
check('value-only not injectable as rationale', isInjectableKind('rationale', { because: null }) === false)

/* ── 蒸馏：纯值丢弃 ── */
{
  const recent = [{ seq: 1, role: 'user', text: '脚本放在 scripts/acceptance-30d.mjs 就行', sessionId: 's' }]
  const mk = (payload) => async function* () {
    yield { type: 'text-delta', text: JSON.stringify({ items: [payload] }) }
    yield { type: 'finish', finish: { kind: 'stop' } }
  }
  const valueOnly = await distill({
    route: { provider: 'p', model: 'm' }, recent,
    stream: () => mk({ type: 'state', text: '脚本在 scripts/acceptance-30d.mjs', evidence: [{ seq: 1, quote: '脚本放在 scripts/acceptance-30d.mjs' }] })(),
  })
  check('value-only candidate dropped', valueOnly.candidates.length === 0 && valueOnly.dropped >= 1, valueOnly)

  const rationale = await distill({
    route: { provider: 'p', model: 'm' }, recent,
    stream: () => mk({
      kind: 'rationale', type: 'decision', text: '验收脚本必须离线',
      because: '部署环境无外网', cost: '不能依赖在线服务',
      evidence: [{ seq: 1, quote: '脚本放在 scripts/acceptance-30d.mjs' }],
    })(),
  })
  const c = rationale.candidates[0]
  check('rationale candidate kept', c?.knowledgeKind === 'rationale' && c?.because?.includes('外网'), c)
}

/* ── 简报：知识形态小节 ── */
{
  const item = (over) => ({
    id: `mem_${Math.random().toString(36).slice(2, 7)}`,
    type: 'gotcha', status: 'active', source: 'tool', authority: 'tool_verified',
    confirmationStatus: 'unconfirmed', assertionMode: 'fact_assertion', importance: 'high',
    decision: null, taskAssignment: { status: 'unresolved', taskId: null, confidence: 0, reason: 'no-candidate' },
    evidence: [{ id: 'e', sessionId: 's', seq: 1, sourceRole: 'tool', quote: 'Failed Loading', verifyState: 'verified', verifiedAt: now }],
    revision: 1, observedAt: now, recordedAt: now, createdAt: now, updatedAt: now,
    ...over,
  })
  const rat = item({ id: 'mem_rat', type: 'decision', knowledgeKind: 'rationale', assertionMode: 'decision', decision: { scope: 'permanent', status: 'active' }, text: 'core 锁死 2.387.3', because: '签名校验变了', cost: '无法用新特性' })
  const les = item({ knowledgeKind: 'lesson', text: '整份覆盖 config.xml 会失败', failedApproach: '整份覆盖', signal: '登录 500', fix: '改白名单合并' })
  const cfg = { brief: { enabled: true, maxChars: 20000, recentSessions: 5, collapse: true, showUnverified: true, unverifiedMax: 10 } }
  const brief = buildBrief({ ws: { root: '/x/w', dir: '/x/.dsh/memory' }, digests: [], items: [rat, les], config: cfg, now })
  check('brief shows rationale with because', /因为 签名校验变了/.test(brief) && brief.includes('代价：无法用新特性'), brief)
  check('brief shows lesson signal+fix', /信号：登录 500/.test(brief) && /修复：改白名单合并/.test(brief), brief)
  check('brief labels rationale section', brief.includes('相关理由：'), brief.slice(0, 200))
  check('brief labels lesson section', brief.includes('相关教训：'), brief.slice(0, 200))
}

/* ── 存量回填：从文本拆理由 ── */
{
  const { splitBecause } = await import('../lib/knowledge.js')
  check('split on 因为', splitBecause('必须锁死 2.387.3，因为新版签名校验变了').because === '新版签名校验变了')
  check('split on 否则', splitBecause('必须声明 inject，否则访问 ctx.tools 会失败').because.startsWith('否则'))
  check('split on 导致', splitBecause('日志调成 debug，导致磁盘一小时写满').because.includes('磁盘'))
  check('no cause keeps null', splitBecause('迁移不含 Job 与构建历史').because === null)

  const { ItemsStore } = await import('../lib/items.js')
  const fs2 = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs2.mkdtempSync(path.join(os.tmpdir(), 'wm-kb-'))
  const st = new ItemsStore({ dir, logger: { warn() {} } })
  const ts = Date.now()
  const base = {
    type: 'decision', status: 'active', source: 'assistant', authority: 'assistant',
    confirmationStatus: 'unconfirmed', assertionMode: 'decision', decision: { scope: 'permanent', status: 'active' },
    importance: 'high', confidence: 0.8,
    taskAssignment: { status: 'unresolved', taskId: null, confidence: 0, reason: 'no-candidate' },
    evidence: [{ id: 'e', sessionId: 's', seq: 1, sourceRole: 'assistant', quote: '必须锁死 2.387.3，因为签名变了', verifyState: 'verified', verifiedAt: ts }],
    revision: 1, observedAt: ts, recordedAt: ts, createdAt: ts, updatedAt: ts,
  }
  st.append({ ...base, id: 'b1', text: '必须锁死 2.387.3，因为签名变了' })
  st.append({ ...base, id: 'b2', text: '迁移不含 Job 与构建历史' })
  const n = st.backfillKinds()
  check('backfill converts causal items', n === 2, n)
  check('backfill sets rationale', st.get('b1')?.knowledgeKind === 'rationale' && st.get('b1')?.because?.includes('签名'), st.get('b1'))
  check('backfill sets scope', st.get('b2')?.knowledgeKind === 'scope' && !!st.get('b2')?.excludes, st.get('b2'))
  check('backfill idempotent', st.backfillKinds() === 0)
  fs2.rmSync(dir, { recursive: true, force: true })
}

/* ── 规则通道（P0-3）：用户话里的因果/边界直接成为知识 ── */
{
  const { extractCandidates } = await import('../lib/rules.js')
  const msg = (t) => ({ type: 'user/message', seq: 7, data: { source: { kind: 'user' }, content: [{ type: 'text', text: t }] } })
  const one = (t) => extractCandidates(msg(t), 's1')[0]

  const c1 = one('不要引入数据库，因为部署环境无运维')
  check('rule: constraint with because', c1?.knowledgeKind === 'constraint' && c1?.because?.includes('无运维'), c1)
  check('rule: keeps conclusion as text', c1?.text === '不要引入数据库', c1?.text)

  const c2 = one('迁移不包含 Job 与构建历史')
  check('rule: scope with excludes', c2?.knowledgeKind === 'scope' && !!c2?.excludes, c2)

  const c3 = one('写文件报 EPERM，要重试')
  check('rule: lesson with signal', c3?.knowledgeKind === 'lesson' && c3?.signal === 'EPERM', c3)

  const c4 = one('这个方案效果不好，因为延迟太高')
  check('rule: rationale with because', c4?.knowledgeKind === 'rationale' && c4?.because?.includes('延迟'), c4)
}

const failed = results.filter((r) => !r.ok)
console.log(JSON.stringify({ total: results.length, failed: failed.length, failures: failed.map((f) => f.name) }, null, 2))
process.exit(failed.length ? 1 : 0)
