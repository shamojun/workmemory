/**
 * 回放评测：用"历史问题"检验记忆库能否找回正确条目。
 *   node scripts/replay.mjs [workspace]
 *
 * 语义：模拟"新会话里问旧问题"，只测检索层（不调模型），所以可重复、零成本。
 * 判定：top-K 结果里是否有一条命中该问题的期望关键词。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { search } from '../packages/workmemory/lib/retrieval.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const wsArg = args.find((a) => !a.startsWith('--'))
const root = path.resolve(wsArg ?? path.join(here, '..'))
const dir = path.join(root, '.dsh', 'memory')

const QUESTIONS = [
  { q: '我们之前定了什么约束？', expect: ['不依赖', '第三方'], known: true },
  { q: '插件包名最后怎么定的？', expect: ['workmemory', 'npm'], known: true },
  { q: 'inject 漏了会怎么样？', expect: ['inject', 'tools'], known: true },
  // 以下三个主题当前记忆库里**没有**对应条目（对话里说过，但规则未捕获）
  { q: '为什么不能用 ctx.fs 写文件？', expect: ['沙箱', 'fs', '拒绝'], known: false },
  { q: '锁被占用会怎样？', expect: ['锁', '只读'], known: false },
  { q: '记忆存在哪里？', expect: ['jsonl', '.dsh', 'memory'], known: false },
]

function readItems() {
  try {
    const raw = fs.readFileSync(path.join(dir, 'items.jsonl'), 'utf8')
    const m = new Map()
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try { const i = JSON.parse(line); if (i?.id) m.set(i.id, i) } catch { /* skip */ }
    }
    return [...m.values()]
  } catch {
    return []
  }
}

const items = readItems()
const K = 5
const rows = QUESTIONS.map(({ q, expect, known }) => {
  const hits = search(items, q, { limit: K })
  const texts = hits.map((h) => h.item.text)
  const hit = texts.find((t) => expect.some((e) => t.toLowerCase().includes(e.toLowerCase())))
  return { q, expect, known, top: texts, pass: Boolean(hit), matched: hit ?? null }
})

const passed = rows.filter((r) => r.pass).length
const knownRows = rows.filter((r) => r.known)
const knownPassed = knownRows.filter((r) => r.pass).length
const report = {
  workspace: root,
  items: items.length,
  k: K,
  recall: `${passed}/${rows.length}`,
  rate: rows.length ? +((passed / rows.length) * 100).toFixed(0) : 0,
  recallKnown: `${knownPassed}/${knownRows.length}`,
  rateKnown: knownRows.length ? +((knownPassed / knownRows.length) * 100).toFixed(0) : 0,
  rows,
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`回放：${report.recall}（${report.rate}%）｜库内已有主题 ${report.recallKnown}（${report.rateKnown}%）｜记忆库 ${items.length} 条\n`)
  for (const r of rows) {
    console.log(`${r.pass ? '✅' : '❌'}${r.known ? '' : '（未入库主题）'} ${r.q}`)
    if (r.pass) console.log(`   命中：${r.matched}`)
    else console.log(`   top${K}：${r.top.join(' | ') || '（空）'}`)
  }
}

process.exit(report.rateKnown >= 80 ? 0 : 1)
