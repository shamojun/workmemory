/**
 * 导出某个工作区的记忆为单个 JSON（设计文档 §5.8）。
 *
 *   node scripts/export-memory.mjs                       # 导出当前目录的数据
 *   node scripts/export-memory.mjs <workspace> [--out f] # 指定工作区与输出
 *
 * 只读：不修改、不删除库内任何数据。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const args = process.argv.slice(2)
const ws = path.resolve(args[0] && !args[0].startsWith('--') ? args[0] : process.cwd())
const outIdx = args.indexOf('--out')
const out = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : undefined

const dir = path.join(ws, '.dsh', 'memory')
const home = process.env.USERPROFILE ?? process.env.HOME
const dsh = process.env.DSH_HOME ?? path.join(home, '.dsh')

const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return fallback }
}
const readJsonl = (f) => {
  try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}

if (!fs.existsSync(dir)) {
  console.error(`没有找到 ${dir}`)
  process.exit(1)
}

const identity = readJson(path.join(dir, 'workspace.json'), {})
const manifest = readJson(path.join(dir, 'manifest.json'), {})
const items = readJsonl(path.join(dir, 'items.jsonl'))
const entities = readJsonl(path.join(dir, 'entities.jsonl'))

const digestDir = path.join(dir, 'digest')
const digests = fs.existsSync(digestDir)
  ? fs.readdirSync(digestDir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(digestDir, f), null)).filter(Boolean)
  : []

const stamp = new Date().toISOString().slice(0, 10)
const file = out ?? path.join(dsh, 'exports', `workmemory-${(identity.workspaceId ?? 'ws').slice(0, 12)}-${stamp}.json`)

const payload = {
  format: 'workmemory-export',
  version: 1,
  exportedAt: Date.now(),
  workspace: {
    key: identity.workspaceId ?? null,
    root: identity.root ?? ws,
    title: path.basename(ws),
    workspaceId: identity.workspaceId ?? null,
  },
  schemaVersion: manifest.schemaVersion ?? null,
  items,
  entities,
  digests,
  manifest,
  checksum: { items: items.length, entities: entities.length, digests: digests.length },
}

fs.mkdirSync(path.dirname(file), { recursive: true })
const tmp = `${file}.tmp-${process.pid}`
fs.writeFileSync(tmp, JSON.stringify(payload, null, 2))
fs.renameSync(tmp, file)

console.log(JSON.stringify({ file, checksum: payload.checksum, location: dir }, null, 2))
