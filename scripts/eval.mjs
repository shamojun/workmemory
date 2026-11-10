/**
 * 离线评测：对 .dsh/memory 里的真实数据算一遍质量指标。
 *   node scripts/eval.mjs [workspace]
 *
 * 指标对应方案 §15：
 *   - items 状态/类型分布
 *   - evidence 覆盖率（有引用的条目占比，目标 100%）
 *   - pending 率（越低说明授权边界越少打断）
 *   - 近似重复率（同类型包含度 ≥0.6 且共享词 ≥6 的条目对）
 *   - digest 覆盖（有会话摘要的 session 占比）
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? process.cwd())
const dir = path.join(root, '.dsh', 'memory')

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

const manifest = readJson(path.join(dir, 'manifest.json'), {})
const { rows, bad } = readJsonl(path.join(dir, 'items.jsonl'))

const latest = new Map()
for (const r of rows) if (r?.id) latest.set(r.id, r)
const items = [...latest.values()]
const live = items.filter((i) => i.status === 'active' || i.status === 'pending')

const byStatus = {}
const byType = {}
let withEvidence = 0
for (const i of items) {
  byStatus[i.status] = (byStatus[i.status] ?? 0) + 1
  byType[i.type] = (byType[i.type] ?? 0) + 1
  if (i.evidence?.length) withEvidence += 1
}

let dupPairs = 0
for (let i = 0; i < live.length; i += 1) {
  for (let j = i + 1; j < live.length; j += 1) {
    if (live[i].type !== live[j].type) continue
    if (containment(live[i].text, live[j].text) >= 0.6) dupPairs += 1
  }
}

let digests = 0
try { digests = fs.readdirSync(path.join(dir, 'digest')).filter((n) => n.endsWith('.json')).length } catch { /* none */ }

const report = {
  workspace: root,
  items: {
    lines: rows.length,
    unique: items.length,
    byStatus,
    byType,
    evidenceCoverage: items.length ? +((withEvidence / items.length) * 100).toFixed(1) : null,
  },
  pendingRate: live.length ? +(((byStatus.pending ?? 0) / live.length) * 100).toFixed(1) : 0,
  duplicatePairs: dupPairs,
  data: {
    corruptLines: bad,
    digests,
    sessions: manifest.stats?.sessions ?? null,
    rulesVersion: manifest.rulesVersion ?? null,
    route: manifest.route ?? null,
    lastBackfillAt: manifest.lastBackfillAt ? new Date(manifest.lastBackfillAt).toISOString() : null,
  },
}

console.log(JSON.stringify(report, null, 2))
