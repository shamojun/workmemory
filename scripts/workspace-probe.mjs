/**
 * 工作区能力探针：在目标目录上验证 WorkMemory 依赖的文件系统原语是否可用。
 *
 *   node scripts/workspace-probe.mjs [目录]
 *
 * 为什么需要：WorkMemory 用"独占创建锁 + 临时文件 rename + fsync"保证安全，
 * 这三件事在 SMB / NFS / 网络盘 / 同步盘（OneDrive、坚果云）上的行为并不一致。
 * 在"在线工作空间"里跑之前，先用这个脚本确认。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const target = path.resolve(process.argv[2] ?? process.cwd())
const dir = path.join(target, '.dsh-memory-probe')
const checks = []
const add = (name, ok, detail, impact) => {
  checks.push({ name, ok, detail, impact })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  ${JSON.stringify(detail)}` : ''}`)
}

fs.rmSync(dir, { recursive: true, force: true })
fs.mkdirSync(dir, { recursive: true })

// 1. 基础读写 + 中文
try {
  const f = path.join(dir, '中文文件名.txt')
  fs.writeFileSync(f, '中文内容 ✅')
  const back = fs.readFileSync(f, 'utf8')
  add('basic:read-write-cjk', back === '中文内容 ✅', { back }, '中文内容或文件名不可用')
} catch (e) {
  add('basic:read-write-cjk', false, { error: e.code }, '中文内容或文件名不可用')
}

// 2. 独占创建（锁）
try {
  const f = path.join(dir, 'lock')
  fs.closeSync(fs.openSync(f, 'wx'))
  let second = 'ok'
  try { fs.closeSync(fs.openSync(f, 'wx')) } catch (e) { second = e.code }
  add('lock:exclusive-create', second === 'EEXIST', { second }, '不支持独占创建 → 多实例可能同时写')
} catch (e) {
  add('lock:exclusive-create', false, { error: e.code }, '不支持独占创建 → 多实例可能同时写')
}

// 3. rename 覆盖已存在文件（原子写）
try {
  const a = path.join(dir, 'a.tmp')
  const b = path.join(dir, 'a.json')
  fs.writeFileSync(a, 'v1')
  fs.renameSync(a, b)
  fs.writeFileSync(a, 'v2')
  fs.renameSync(a, b)
  add('write:rename-overwrite', fs.readFileSync(b, 'utf8') === 'v2', undefined, 'rename 不能覆盖 → 原子写不可用')
} catch (e) {
  add('write:rename-overwrite', false, { error: e.code }, 'rename 不能覆盖 → 原子写不可用')
}

// 4. fsync
try {
  const f = path.join(dir, 'fsync.txt')
  const fd = fs.openSync(f, 'w')
  fs.writeFileSync(fd, 'x')
  fs.fsyncSync(fd)
  fs.closeSync(fd)
  add('write:fsync', true, undefined, '缺少 fsync → 断电容错下降')
} catch (e) {
  add('write:fsync', false, { error: e.code }, '缺少 fsync → 断电容错下降')
}

// 5. 追加写 + 读回（JSONL）
try {
  const f = path.join(dir, 'items.jsonl')
  for (let i = 0; i < 5; i += 1) fs.appendFileSync(f, `${JSON.stringify({ i })}\n`)
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n')
  add('jsonl:append', lines.length === 5, { lines: lines.length }, '追加写异常 → 记忆库不可用')
} catch (e) {
  add('jsonl:append', false, { error: e.code }, '追加写异常 → 记忆库不可用')
}

// 6. 长路径（>260 字符）
try {
  let deep = dir
  while (deep.length < 280) deep = path.join(deep, 'sub-sub-directory')
  fs.mkdirSync(deep, { recursive: true })
  fs.writeFileSync(path.join(deep, 'x.txt'), 'ok')
  add('path:long-260', true, { length: path.join(deep, 'x.txt').length }, '长路径不支持 → 深层工作区会失败')
} catch (e) {
  add('path:long-260', false, { error: e.code }, '长路径不支持 → 深层工作区会失败')
}

// 7. 大小写敏感性
try {
  const lower = path.join(dir, 'case.txt')
  fs.writeFileSync(lower, 'lower')
  const upper = path.join(dir, 'CASE.TXT')
  let same = false
  try { same = fs.readFileSync(upper, 'utf8') === 'lower' } catch { same = false }
  add('path:case-insensitive', same, { same }, '若为不敏感，同一目录两个路径会互相覆盖')
} catch (e) {
  add('path:case-insensitive', false, { error: e.code }, '无法判定大小写')
}

// 8. 时延（200 次小写入）
try {
  const t0 = Date.now()
  const f = path.join(dir, 'latency.log')
  for (let i = 0; i < 200; i += 1) fs.appendFileSync(f, `${i}\n`)
  const ms = Date.now() - t0
  add('perf:200-appends', ms < 3000, { ms }, `写入过慢（${ms}ms/200 次）→ 在线盘可能卡顿`)
} catch (e) {
  add('perf:200-appends', false, { error: e.code }, '写入性能未知')
}

// 9. 并发 rename 一致性（两个临时文件轮流覆盖）
try {
  const final = path.join(dir, 'swap.json')
  let ok = true
  for (let i = 0; i < 20; i += 1) {
    const tmp = path.join(dir, `swap-${i}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify({ i }))
    fs.renameSync(tmp, final)
    if (JSON.parse(fs.readFileSync(final, 'utf8')).i !== i) ok = false
  }
  add('write:20-renames', ok, undefined, 'rename 序列不一致 → 原子写不可信')
} catch (e) {
  add('write:20-renames', false, { error: e.code }, 'rename 序列不一致')
}

fs.rmSync(dir, { recursive: true, force: true })

const fatal = ['basic:read-write-cjk', 'lock:exclusive-create', 'write:rename-overwrite', 'jsonl:append']
const failedFatal = checks.filter((c) => !c.ok && fatal.includes(c.name))
const failedSoft = checks.filter((c) => !c.ok && !fatal.includes(c.name))

const verdict = failedFatal.length === 0 ? 'usable' : 'unsafe'
console.log(`\n目录：${target}`)
console.log(`结论：${verdict === 'usable' ? '✅ 可用于 WorkMemory' : '❌ 不适合直接使用'}`)
if (failedFatal.length) console.log(`致命不可用：${failedFatal.map((c) => c.name).join(', ')}`)
if (failedSoft.length) console.log(`降级项：${failedSoft.map((c) => `${c.name}（${c.impact}）`).join('；')}`)

console.log(JSON.stringify({ target, verdict, checks }, null, 2))
process.exit(verdict === 'usable' ? 0 : 1)
