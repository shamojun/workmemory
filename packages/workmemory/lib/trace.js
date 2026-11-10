/**
 * 独立诊断轨迹：写 %TEMP%/workmemory-trace.jsonl（不依赖工作区目录权限、不依赖 DSH 服务）。
 * 任何一步失败都能看到最后停在哪。
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE = path.join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'workmemory-trace.jsonl')
const MAX_BYTES = 1024 * 1024

function rotate() {
  try {
    if (fs.statSync(FILE).size > MAX_BYTES) fs.renameSync(FILE, `${FILE}.1`)
  } catch { /* 文件不存在 */ }
}

export function trace(step, data) {
  try {
    rotate()
    fs.appendFileSync(FILE, `${JSON.stringify({ t: Date.now(), pid: process.pid, step, ...data })}\n`)
  } catch { /* 诊断绝不抛错 */ }
}

export function tracePath() {
  return FILE
}
