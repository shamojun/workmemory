/**
 * 版本化挂载：把 lib 复制到 lib__v/<stamp>/ 再挂载。
 * 目的：换模块**路径**（不是 URL query）绕开 DSH/Node 的模块缓存，
 * 从而在不重启应用的情况下加载最新源码。
 *   node packages/workmemory/version-mount.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const lib = path.join(here, 'lib')
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const target = path.join(here, 'lib__v', stamp)
fs.mkdirSync(target, { recursive: true })

for (const name of fs.readdirSync(lib).filter((n) => n.endsWith('.js'))) {
  fs.copyFileSync(path.join(lib, name), path.join(target, name))
}

const patch = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
const spec = path.join(target, 'index.js').replaceAll('\\', '/')
const BEGIN = '# --- WorkMemory ---'
const END = '# --- /WorkMemory ---'

const raw = fs.readFileSync(patch, 'utf8')
const kept = []
let skipping = false
for (const line of raw.split('\n')) {
  if (line.trim() === BEGIN) { skipping = true; continue }
  if (line.trim() === END) { skipping = false; continue }
  if (!skipping) kept.push(line)
}
const body = `${kept.join('\n').replace(/\s+$/, '')}\n\n${BEGIN}\n- insert:\n    - id: workmemory\n      name: '${spec}'\n${END}\n`
fs.writeFileSync(patch, body, 'utf8')
console.log(JSON.stringify({ version: stamp, spec, files: fs.readdirSync(target) }, null, 2))
