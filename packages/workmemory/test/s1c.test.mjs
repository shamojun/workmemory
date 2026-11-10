/**
 * S1c：注入权限（usagePolicy）接入简报与检索。
 *   node packages/workmemory/test/s1c.test.mjs
 */
import { buildBrief } from '../lib/brief.js'
import { search } from '../lib/retrieval.js'
import { deriveUsagePolicy } from '../lib/schema.js'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  if (!ok) console.error('FAIL', name, JSON.stringify(detail))
}

const now = Date.now()
const config = { brief: { enabled: true, maxChars: 3600, recentSessions: 5, showUnverified: true } }
const ws = { root: '/tmp/ws', dir: '/tmp/ws/.dsh/memory' }

const item = (over) => ({
  id: `mem_${Math.random().toString(36).slice(2, 8)}`,
  type: 'gotcha',
  text: '沙箱下写 .dsh/memory 返回 FS_SANDBOX_DENIED',
  status: 'active',
  source: 'tool',
  authority: 'tool_verified',
  confirmationStatus: 'unconfirmed',
  assertionMode: 'fact_assertion',
  importance: 'high',
  evidence: [{ sessionId: 's', seq: 1, sourceRole: 'tool', quote: 'FS_SANDBOX_DENIED', verifyState: 'verified', verifiedAt: now }],
  updatedAt: now,
  ...over,
})

const userConstraint = item({
  type: 'constraint', source: 'user', authority: 'user_explicit',
  text: '所有实现不依赖单独第三方服务',
  evidence: [{ sessionId: 's', seq: 2, sourceRole: 'user', quote: '所有实现不依赖单独第三方服务', verifyState: 'verified', verifiedAt: now }],
})
const assistantDecision = item({
  type: 'decision', source: 'assistant', authority: 'assistant', assertionMode: 'decision',
  status: 'active', text: '插件包名定为 shamojun@dsh-memory-long',
  decision: { scope: 'permanent', status: 'active' },
  evidence: [{ sessionId: 's', seq: 3, sourceRole: 'assistant', quote: '包名定为 shamojun@dsh-memory-long', verifyState: 'verified', verifiedAt: now }],
})
const toolGotcha = item({ text: 'ctx.fs 在 workspace-write 下写入被拒绝' })

const digests = [{ id: 's', cwd: '/tmp/ws', createdAt: now, updatedAt: now, turns: 1, userText: '继续', assistantText: '好的' }]

/* ── 简报分流 ── */
{
  const brief = buildBrief({ ws, digests, items: [userConstraint, assistantDecision, toolGotcha], config, now })
  check('user constraint injected', brief.includes('所有实现不依赖单独第三方服务'), brief)
  check('tool gotcha injected', brief.includes('ctx.fs 在 workspace-write 下写入被拒绝'), brief)
  check('assistant decision not a fact', !/关键决策：[\s\S]*包名定为 shamojun/.test(brief), brief)
  check('assistant decision shown as unverified', /待验证线索[\s\S]*包名定为 shamojun/.test(brief), brief)
}

/* ── showUnverified=false 时完全不显示 ── */
{
  const brief = buildBrief({
    ws, digests, items: [assistantDecision],
    config: { brief: { ...config.brief, showUnverified: false } }, now,
  })
  check('unverified hidden when disabled', !brief.includes('包名定为 shamojun'), brief)
}

/* ── 检索策略 ── */
{
  const items = [assistantDecision, toolGotcha, userConstraint]
  const fact = search(items, '沙箱 写入', { policy: 'fact' })
  check('fact search excludes assistant decision', !fact.some((h) => h.item.id === assistantDecision.id), fact.map((h) => h.item.type))
  check('fact search keeps tool gotcha', fact.some((h) => h.item.id === toolGotcha.id), fact.map((h) => h.item.type))
  const any = search(items, '包名', { policy: 'any' })
  check('any search keeps assistant decision', any.some((h) => h.item.id === assistantDecision.id), any.map((h) => h.item.type))
}

/* ── 权限派生自洽 ── */
{
  const pTool = deriveUsagePolicy(toolGotcha)
  const pAsst = deriveUsagePolicy(assistantDecision)
  const pUser = deriveUsagePolicy(userConstraint)
  check('tool: fact yes / basis no', pTool.factualInjection === true && pTool.decisionBasis === false, pTool)
  check('assistant: fact no / basis no', pAsst.factualInjection === false && pAsst.decisionBasis === false, pAsst)
  check('user explicit rule: both yes', pUser.factualInjection === true && pUser.decisionBasis === true, pUser)
}

/* ── 历史工具证据（S1.5-历史） ─────────────────────────── */
{
  const { historyToRecent } = await import('../lib/ingest.js')
  const { distill } = await import('../lib/distiller.js')

  const events = [
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '跑一下构建' }] } },
    { seq: 2, type: 'tool/call', data: { callId: 'c9', name: 'pwsh', arguments: { command: 'pnpm build' } } },
    { seq: 3, type: 'tool/result', data: { meta: { callId: 'c9', isError: true }, message: { content: [{ type: 'text', text: 'ERR_PNPM_NO_SCRIPT: Missing script "build"' }] } } },
    { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '仓库里没有 build 脚本' }] } } },
    { seq: 5, type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '当前时间 2026-11-06' }] } },
  ]
  const recent = historyToRecent(events, 'sess1')
  check('history keeps tool result', recent.some((r) => r.role === 'tool' && r.tool === 'pwsh' && r.status === 'error'), recent.map((r) => r.role))
  check('history drops runtime context', !recent.some((r) => String(r.text).includes('当前时间')), recent.map((r) => r.text.slice(0, 10)))
  check('history keeps order', recent.map((r) => r.seq).join(',') === '1,3,4', recent.map((r) => r.seq))

  // 蒸馏引用历史工具输出 → tool_verified
  const mk = async function* () {
    yield {
      type: 'text-delta',
      text: JSON.stringify({
        items: [{ type: 'gotcha', text: '仓库没有 build 脚本，执行会报 ERR_PNPM_NO_SCRIPT', evidence: [{ seq: 3, quote: 'ERR_PNPM_NO_SCRIPT' }] }],
      }),
    }
    yield { type: 'finish', finish: { kind: 'stop' } }
  }
  const res = await distill({ route: { provider: 'p', model: 'm' }, recent, stream: mk })
  const c = res.candidates[0]
  check('history tool evidence yields tool_verified', c?.source === 'tool' && c?.authority === 'tool_verified', { source: c?.source, authority: c?.authority })
  check('history tool item is factual', deriveUsagePolicy({ ...c, status: 'active', confirmationStatus: 'unconfirmed' }).factualInjection === true)
}

/* ── 过程元信息过滤 ─────────────────────────────────────── */
{
  const { distill, META_PATTERNS } = await import('../lib/distiller.js')
  check('meta patterns defined', META_PATTERNS.length >= 3)
  const ev = [{ seq: 1, role: 'user', sessionId: 's', text: '继续做 S2 归属校验' }]
  const mk = (text) => async function* () {
    yield { type: 'text-delta', text: JSON.stringify({ items: [{ type: 'state', text, evidence: [{ seq: 1, quote: '继续做 S2 归属校验' }] }] }) }
    yield { type: 'finish', finish: { kind: 'stop' } }
  }
  const noisy = await distill({ route: { provider: 'p', model: 'm' }, recent: ev, stream: () => mk('本次会话 226 项测试全部通过')() })
  check('drops process meta', noisy.candidates.length === 0 && noisy.dropped >= 1, noisy)
  const ok = await distill({ route: { provider: 'p', model: 'm' }, recent: ev, stream: () => mk('沙箱下写 .dsh/memory 会返回 FS_SANDBOX_DENIED')() })
  check('keeps real technical fact', ok.candidates.length === 1, ok.candidates.map((c) => c.text))
}

/* ── 一次性清理：过程元信息置 invalid ───────────────────── */
{
  const { ItemsStore } = await import('../lib/items.js')
  const { META_PATTERNS } = await import('../lib/distiller.js')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-purge-'))
  const st = new ItemsStore({ dir, logger: { warn() {} } })
  const base = {
    type: 'gotcha', status: 'active', authority: 'tool_verified', source: 'tool', confirmationStatus: 'unconfirmed',
    assertionMode: 'fact_assertion', importance: 'high', decision: null,
    taskAssignment: { status: 'unresolved', taskId: null, confidence: 0, reason: 'no-candidate' },
    evidence: [{ id: 'e1', sessionId: 's', seq: 1, sourceRole: 'tool', quote: 'FS_SANDBOX_DENIED', verifyState: 'verified', verifiedAt: now }],
    revision: 1, observedAt: now, recordedAt: now, createdAt: now, updatedAt: now,
  }
  st.append({ ...base, id: 'mem_meta_1', text: '本次会话 226 项测试全部通过' })
  st.append({ ...base, id: 'mem_meta_2', text: '验证脚本名为 scripts/_verify-tool-ingest.mjs' })
  st.append({ ...base, id: 'mem_real_1', text: '沙箱下写 .dsh/memory 会返回 FS_SANDBOX_DENIED' })
  const purged = st.purgeMeta(META_PATTERNS)
  check('purge removes meta items', purged === 2, purged)
  check('purge keeps technical fact', st.get('mem_real_1')?.status === 'active')
  check('purge marks invalid not deletes', st.get('mem_meta_1')?.status === 'invalid')
  fs.rmSync(dir, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(JSON.stringify({ total: results.length, failed: failed.length, failures: failed.map((f) => f.name) }, null, 2))
process.exit(failed.length ? 1 : 0)
