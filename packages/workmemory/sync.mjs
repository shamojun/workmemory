/**
 * 把插件同步到 profile 的插件目录（Node 从那里能解析 @deepseek-ai/*）。
 *   node packages/workmemory/sync.mjs
 *
 * 同步后需要重启应用（宿主插件源码不热更新）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'plugins', 'workmemory')

fs.rmSync(target, { recursive: true, force: true })
fs.mkdirSync(path.join(target, 'lib'), { recursive: true })

fs.copyFileSync(path.join(here, 'package.json'), path.join(target, 'package.json'))

const libSrc = path.join(here, 'lib')
const files = fs.readdirSync(libSrc).filter((f) => f.endsWith('.js'))
for (const f of files) fs.copyFileSync(path.join(libSrc, f), path.join(target, 'lib', f))

fs.writeFileSync(path.join(target, '.synced'), JSON.stringify({ at: Date.now(), files }), 'utf8')

console.log(JSON.stringify({ target, files, entry: path.join(target, 'lib', 'index.js') }, null, 2))
