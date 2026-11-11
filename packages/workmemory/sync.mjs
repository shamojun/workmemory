/**
 * 安装/更新插件到 DSH profile。
 *
 *   node packages/workmemory/sync.mjs                     # 默认 profile
 *   node packages/workmemory/sync.mjs --profile <dir>      # 指定 profile
 *   node packages/workmemory/sync.mjs --dry-run            # 只打印不写入
 *
 * 为什么必须装进 profile：
 *   插件中 tools.js 会 `import('@deepseek-ai/...')`，只有 profile 下的 node_modules
 *   能解析这些包。直接从仓库路径加载也能跑，但会丢掉 4 个模型工具。
 *
 * 安装后需完全退出并重启 DSH —— 宿主插件不支持热更新。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const argOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
}
const dryRun = argv.includes('--dry-run')

// DSH_PROFILE 在宿主进程里是 profile 名（如 desktop），不是路径
const envProfile = process.env.DSH_PROFILE
const envProfilePath = envProfile
  ? (path.isAbsolute(envProfile) ? envProfile : path.join(os.homedir(), '.dsh', 'profiles', envProfile))
  : undefined
const defaultProfile = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const profile = path.resolve(argOf('--profile') ?? envProfilePath ?? defaultProfile)
const target = path.join(profile, 'plugins', 'workmemory')

const listFiles = (rel) => {
  const src = path.join(here, rel)
  if (!fs.existsSync(src)) return []
  return fs.readdirSync(src).filter((f) => fs.statSync(path.join(src, f)).isFile())
}

const plan = [
  { from: path.join(here, 'package.json'), to: path.join(target, 'package.json') },
  { from: path.join(here, 'README.md'), to: path.join(target, 'README.md') },
  ...(fs.existsSync(path.join(here, 'cordis.snippet.yml'))
    ? [{ from: path.join(here, 'cordis.snippet.yml'), to: path.join(target, 'cordis.snippet.yml') }]
    : []),
  ...listFiles('lib').map((f) => ({ from: path.join(here, 'lib', f), to: path.join(target, 'lib', f) })),
  ...listFiles('schema').map((f) => ({ from: path.join(here, 'schema', f), to: path.join(target, 'schema', f) })),
]

/** 目标目录若是本插件旧版本，清空后重装；否则拒绝覆盖。 */
function prepareTarget() {
  if (!fs.existsSync(target)) return true
  const synced = path.join(target, '.synced')
  const pkgFile = path.join(target, 'package.json')
  let ours = fs.existsSync(synced)
  if (!ours && fs.existsSync(pkgFile)) {
    try { ours = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).name === '@shamojun/workmemory' } catch { ours = false }
  }
  if (!ours) {
    console.log(`⚠️  ${target} 已存在且不是本插件的安装目录，已停止以避免覆盖。`)
    console.log('   请手动处理该目录，或用 --profile 指定其他 profile。')
    return false
  }
  fs.rmSync(target, { recursive: true, force: true })
  return true
}

if (!fs.existsSync(profile)) {
  console.log(`⚠️  profile 不存在: ${profile}`)
  console.log('   请确认 DSH 已安装并至少启动过一次，或用 --profile 指定路径。')
} else {
  // 真实探测：profile 下能否解析宿主包（决定 4 个模型工具能否注册）
  const req = createRequire(path.join(profile, 'noop.js'))
  const missing = []
  for (const p of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools']) {
    try { req.resolve(p) } catch { missing.push(p) }
  }
  if (missing.length) {
    console.log(`⚠️  profile 下无法解析宿主包: ${missing.join(', ')}`)
    console.log('   插件核心功能可用，但 4 个模型工具不会注册。')
  } else {
    console.log('✓  宿主包解析正常（模型工具可注册）')
  }
}

if (dryRun) {
  console.log(JSON.stringify({ profile, target, files: plan.length, dryRun: true }, null, 2))
  process.exit(0)
}

if (!prepareTarget()) process.exit(1)

for (const { from, to } of plan) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}

const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'))
fs.writeFileSync(path.join(target, '.synced'), JSON.stringify({ at: Date.now(), version: pkg.version, files: plan.length }), 'utf8')

const entry = path.join(target, 'lib', 'index.js').replace(/\\/g, '/')
console.log(`✅ 已安装 ${plan.length} 个文件（v${pkg.version}）→ ${target}`)
console.log('')
console.log('在 cordis.patch.yml 中加入（已存在则跳过）：')
console.log('')
console.log('- insert:')
console.log('    - id: workmemory')
console.log(`      name: '${entry}'`)
console.log('')
console.log('然后完全退出并重启 DSH。')
