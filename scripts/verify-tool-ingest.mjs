/**
 * 离线验证 S1.5：tool 事件 → recent 缓冲 → 蒸馏证据。
 *   node scripts/_verify-tool-ingest.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Ingestor } from '../packages/workmemory/lib/ingest.js'
import { distill } from '../packages/workmemory/lib/distiller.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-tool-'))
const ing = new Ingestor({
  config: {
    ingest: { excludeSubAgents: true },
    distill: { maxEvents: 40, maxCandidates: 6, debounceMs: 1, enabled: true },
    rules: { enabled: false },
  },
  logger: { info() {}, warn: (...a) => console.log('WARN', ...a) },
  getSessionQuery: () => undefined,
  itemsFor: () => undefined,
  getLlm: () => undefined,
  getTasks: () => [],
  applyTaskUpdates: () => 0,
})

const session = { header: { id: 's1', cwd: dir, createdAt: Date.now(), delegationDepth: 0 } }
const ws = { dir }

// 1) 工具调用 + 结果
ing.onEvent(session, { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'pwsh', arguments: { command: 'echo hi' } } }, ws)
ing.onEvent(session, {
  type: 'tool/result', seq: 2,
  data: {
    meta: { callId: 'c1', isError: true },
    message: { content: [{ type: 'text', text: 'FS_SANDBOX_DENIED: cannot write ".dsh/memory/.fs-probe.txt"' }] },
  },
}, ws)
// 2) 用户与助手消息
ing.onEvent(session, { type: 'user/message', seq: 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '为什么写不进 .dsh/memory' }] } }, ws)
ing.onEvent(session, { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: '沙箱禁止写入该路径' }] } } }, ws)

const recent = ing.recent.get('s1') ?? []
console.log('recent roles:', recent.map((r) => `${r.role}${r.tool ? `(${r.tool}|${r.status})` : ''}`))

// 3) 模拟模型引用工具输出
const mk = async function* () {
  yield {
    type: 'text-delta',
    text: JSON.stringify({
      items: [{
        type: 'gotcha',
        text: '沙箱下写 .dsh/memory 会返回 FS_SANDBOX_DENIED',
        evidence: [{ seq: 2, quote: 'FS_SANDBOX_DENIED: cannot write' }],
      }],
    }),
  }
  yield { type: 'finish', finish: { kind: 'stop' } }
}
const res = await distill({ route: { provider: 'p', model: 'm' }, recent, stream: mk })
const c = res.candidates[0]
console.log('candidate:', JSON.stringify({ source: c?.source, authority: c?.authority, status: c?.status, evidenceRole: c?.evidence?.[0]?.role }))

// 4) 走一遍写入归一化
const { coerceItemV2, validateItem, deriveUsagePolicy } = await import('../packages/workmemory/lib/schema.js')
const built = coerceItemV2({ ...c, id: 'mem_tool_1', origin: 'llm', text: c.text })
console.log('valid:', validateItem(built).ok, validateItem(built).errors)
console.log('source/authority:', built.source, built.authority)
console.log('policy:', deriveUsagePolicy(built))

fs.rmSync(dir, { recursive: true, force: true })
