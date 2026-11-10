/**
 * WorkMemory 30 天验收脚本。
 *
 *   node scripts/acceptance-30d.mjs run     [--workspace <dir>]   # 跑一轮，写入历史
 *   node scripts/acceptance-30d.mjs report  [--workspace <dir>]   # 汇总历史
 *
 * 设计原则：
 *   1. 纯离线 —— 只读 `.dsh/memory/`，不启动 DSH、不调模型；
 *   2. 自动判定 known —— 库里存在含某个 expect 关键词的条目，该问题才算"库内已有主题"；
 *      否则问题本身不计入召回率（避免"没采集到"被误判成"检索不准"）；
 *   3. 每天跑一次，结果追加到 `acceptance/history.jsonl`，30 天后用 report 看趋势。
 *
 * 退出码：0 通过；1 有硬失败（数据损坏 / 证据缺失 / 召回低于门槛）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { search } from '../packages/workmemory/lib/retrieval.js'
import { buildBrief } from '../packages/workmemory/lib/brief.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const cmd = args.find((a) => !a.startsWith('--')) ?? 'run'
const wsIndex = args.indexOf('--workspace')
const root = path.resolve(wsIndex >= 0 ? args[wsIndex + 1] : path.join(here, '..'))
const dir = path.join(root, '.dsh', 'memory')
const histFile = path.join(dir, 'acceptance', 'history.jsonl')

/** 门槛（对应 v3.1 §9.2） */
const THRESHOLDS = {
  recallAt5: 85,          // 库内已有主题的召回率
  evidenceWellFormed: 100,
  corruptLines: 0,
  duplicatePairs: 2,      // 允许极少量近似重复
  briefTokens: 1200,
}

function readJson(p, d) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d }
}

function readJsonl(p) {
  let raw = ''
  try { raw = fs.readFileSync(p, 'utf8') } catch { return { rows: [], bad: 0 } }
  const rows = []
  let bad = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { bad += 1 }
  }
  return { rows, bad }
}

function latest(rows) {
  const m = new Map()
  for (const r of rows) if (r?.id) m.set(r.id, r)
  return [...m.values()]
}

function grams(s) {
  const t = String(s ?? '').toLowerCase()
  const set = new Set()
  for (const w of t.match(/[a-z][a-z0-9_+#.\-]{1,}/g) ?? []) set.add(w)
  const cjk = t.replace(/[^\u4e00-\u9fa5]/g, '')
  for (let i = 0; i + 1 < cjk.length; i += 1) set.add(cjk.slice(i, i + 2))
  return set
}

function containment(a, b) {
  const A = grams(a)
  const B = grams(b)
  if (!A.size || !B.size) return 0
  let shared = 0
  for (const x of A) if (B.has(x)) shared += 1
  return shared / Math.min(A.size, B.size)
}

function loadData() {
  const itemsRaw = readJsonl(path.join(dir, 'items.jsonl'))
  const items = latest(itemsRaw.rows)
  const manifest = readJson(path.join(dir, 'manifest.json'), {})
  const entities = latest(readJsonl(path.join(dir, 'entities.jsonl')).rows)
  const digests = []
  try {
    for (const f of fs.readdirSync(path.join(dir, 'digest'))) {
      if (f.endsWith('.json')) {
        const d = readJson(path.join(dir, 'digest', f), null)
        if (d) digests.push(d)
      }
    }
  } catch { /* 无摘要 */ }
  const task = entities.find((e) => e.kind === 'task' && e.id === manifest.activeTaskId)
    ?? entities.find((e) => e.kind === 'task' && ['active', 'paused', 'blocked'].includes(e.status))
  return { items, itemsRaw, manifest, entities, digests, task }
}

function runOne() {
  const { items, itemsRaw, manifest, entities, digests, task } = loadData()
  const live = items.filter((i) => i.status === 'active' || i.status === 'pending')

  const checks = []
  const add = (name, ok, detail, hard = true) => checks.push({ name, ok, detail, hard })

  // ── 1. 数据完整性 ──
  add('data:no-corrupt-lines', itemsRaw.bad <= THRESHOLDS.corruptLines, { corruptLines: itemsRaw.bad })
  const noEvidence = items.filter((i) => !i.evidence?.length)
  add('data:every-item-has-evidence', noEvidence.length === 0, { missing: noEvidence.length })
  const malformed = items.filter((i) => i.evidence?.some((e) => !e.quote || e.quote.length < 4))
  add('evidence:quotes-well-formed', malformed.length === 0, { malformed: malformed.length })

  // ── 2. 去重 ──
  let dupPairs = 0
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      if (live[i].type !== live[j].type) continue
      if (containment(live[i].text, live[j].text) >= 0.6) dupPairs += 1
    }
  }
  add('data:duplicate-pairs', dupPairs <= THRESHOLDS.duplicatePairs, { dupPairs })

  // ── 3. 召回（只对"库内已有主题"计分） ──
  const qs = readJson(path.join(here, 'acceptance', 'questions.json'), { questions: [] }).questions
  const rows = qs.map(({ id, q, expect }) => {
    // known 判定要严一点：至少命中 2 个关键词，才认为"库里确实有这个主题"。
    // 只命中 1 个往往是偶然词（如"重建"出现在无关条目里），会把召回率算低。
    const hitKeywords = new Set()
    for (const item of items) {
      const t = String(item.text).toLowerCase()
      for (const k of expect) if (t.includes(k.toLowerCase())) hitKeywords.add(k.toLowerCase())
    }
    const known = hitKeywords.size >= 2
    const hits = search(items, q, { limit: 5, task })
    const top = hits.map((h) => h.item.text)
    const hit = top.find((t) => expect.some((k) => t.toLowerCase().includes(k.toLowerCase())))
    return { id, q, known, keywordHits: [...hitKeywords], pass: Boolean(hit), matched: hit ?? null, top: top.slice(0, 3) }
  })
  const known = rows.filter((r) => r.known)
  const recall = known.length ? Math.round((known.filter((r) => r.pass).length / known.length) * 100) : 100
  add('recall:known-topics', recall >= THRESHOLDS.recallAt5, { recall, known: known.length, total: rows.length }, true)

  // ── 4. 任务连续性 ──
  add('task:active-exists', Boolean(task), { task: task ? `${task.title}(${task.status})` : null }, false)
  if (task) {
    const bound = (task.sessionIds ?? []).length
    add('task:session-bound', bound > 0, { sessions: bound }, false)
    const hasProgress = (task.progress ?? []).length > 0
    add('task:progress-recorded', hasProgress, { progress: (task.progress ?? []).length }, false)
  }

  // ── 5. 注入成本 ──
  const brief = buildBrief({
    ws: { root },
    digests,
    items,
    config: { brief: { enabled: true, maxChars: 3600, recentSessions: 5 } },
    task,
  })
  const tokens = Math.ceil(brief.length / 1.6)
  add('brief:token-budget', tokens <= THRESHOLDS.briefTokens, { chars: brief.length, tokens })

  const hardFailed = checks.filter((c) => c.hard && !c.ok)
  const record = {
    at: new Date().toISOString(),
    workspace: root,
    items: items.length,
    live: live.length,
    pendingRate: live.length ? Math.round(((live.filter((i) => i.status === 'pending').length) / live.length) * 100) : 0,
    task: task ? { id: task.id, title: task.title, status: task.status, progress: (task.progress ?? []).length } : null,
    recall,
    knownQuestions: known.length,
    totalQuestions: rows.length,
    briefTokens: tokens,
    checks,
    failures: hardFailed.map((c) => c.name),
    questions: rows,
  }

  fs.mkdirSync(path.dirname(histFile), { recursive: true })
  fs.appendFileSync(histFile, `${JSON.stringify(record)}\n`)

  // 控制台输出
  console.log(`\n== WorkMemory 验收（${record.at.slice(0, 10)}）==`)
  console.log(`记忆项 ${record.items}（活跃 ${record.live}，pending ${record.pendingRate}%）`)
  console.log(task ? `任务 ${task.title}（${task.status}，进度 ${record.task.progress} 条）` : '任务 （无）')
  console.log(`召回 ${recall}%（库内已有主题 ${known.length}/${rows.length}）  简报 ≈${tokens} token\n`)
  for (const c of checks) {
    const mark = c.ok ? '✅' : c.hard ? '❌' : '⚠️ '
    console.log(`${mark} ${c.name} ${JSON.stringify(c.detail)}`)
  }
  if (rows.some((r) => !r.pass && r.known)) {
    console.log('\n未命中（库内有该主题但没搜到）：')
    for (const r of rows.filter((x) => x.known && !x.pass)) console.log(` - ${r.q}  top: ${r.top.join(' | ') || '（空）'}`)
  }
  console.log(`\n已写入 ${path.relative(root, histFile)}`)

  return hardFailed.length === 0
}

function report() {
  const { rows, bad } = readJsonl(histFile)
  if (rows.length === 0) {
    console.log('还没有验收记录。先运行：node scripts/acceptance-30d.mjs run')
    return false
  }
  const first = rows[0]
  const last = rows[rows.length - 1]
  const days = new Set(rows.map((r) => r.at.slice(0, 10))).size
  const avg = (k) => Math.round(rows.reduce((n, r) => n + (r[k] ?? 0), 0) / rows.length)
  const recallSeries = rows.map((r) => r.recall)
  const regressions = rows.filter((r) => r.failures?.length).length

  console.log(`\n== 30 天验收汇总 ==`)
  console.log(`覆盖天数 ${days}  运行次数 ${rows.length}${bad ? `  损坏行 ${bad}` : ''}`)
  console.log(`首日 items ${first.items} → 最新 ${last.items}`)
  console.log(`平均召回 ${avg('recall')}%   最近一次 ${last.recall}%`)
  console.log(`平均简报 ${avg('briefTokens')} token   最近一次 ${last.briefTokens}`)
  console.log(`平均 pending 率 ${avg('pendingRate')}%`)
  console.log(`硬失败次数 ${regressions}`)
  console.log(`召回走势 ${recallSeries.map((n) => `${n}%`).join(' → ')}`)

  const failing = {}
  for (const r of rows) for (const f of r.failures ?? []) failing[f] = (failing[f] ?? 0) + 1
  if (Object.keys(failing).length) {
    console.log('\n失败项统计：')
    for (const [name, n] of Object.entries(failing).sort((a, b) => b[1] - a[1])) console.log(` - ${name} ×${n}`)
  }
  const target = days >= 30 && avg('recall') >= THRESHOLDS.recallAt5 && regressions === 0
  console.log(`\n验收结论：${target ? '✅ 满足 30 天门槛' : `⏳ 未达门槛（需 ≥30 天、平均召回 ≥${THRESHOLDS.recallAt5}%、无硬失败）`}`)
  return target
}

const ok = cmd === 'report' ? report() : runOne()
process.exit(ok ? 0 : 1)
