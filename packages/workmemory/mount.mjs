/**
 * 挂载/卸载 WorkMemory（UTF-8 安全）。
 *   node packages/workmemory/mount.mjs
 *   node packages/workmemory/mount.mjs --remove
 *
 * 注意：改 cordis.patch.yml 会触发热重组合；但**改插件源码不会热更新**
 * （Node ESM 按 URL 缓存，实测带 ?v= 的垫片也无效），需要重启 Desktop。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const patch = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
// 挂载 profile 内的副本（Node 从那里才能解析 @deepseek-ai/*），源码经 sync.mjs 同步过去
const entryFile = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'plugins', 'workmemory', 'lib', 'index.js')
const BEGIN = '# --- WorkMemory ---'
const END = '# --- /WorkMemory ---'
const remove = process.argv.includes('--remove')

if (!remove && !fs.existsSync(entryFile)) {
  console.error(`entry not found: ${entryFile}\n先运行: node packages/workmemory/sync.mjs`)
  process.exit(1)
}

const raw = fs.readFileSync(patch, 'utf8')
const kept = []
let skipping = false
for (const line of raw.split('\n')) {
  if (line.trim() === BEGIN) { skipping = true; continue }
  if (line.trim() === END) { skipping = false; continue }
  if (!skipping) kept.push(line)
}
let body = kept.join('\n').replace(/\s+$/, '')

if (!remove) {
  const spec = entryFile.replaceAll('\\', '/')
  body += `\n\n${BEGIN}\n- insert:\n    - id: workmemory\n      name: '${spec}'\n${END}\n`
} else {
  body += '\n'
}

fs.writeFileSync(patch, body, 'utf8')
console.log(JSON.stringify({ mounted: !remove, entry: entryFile, patch }, null, 2))
