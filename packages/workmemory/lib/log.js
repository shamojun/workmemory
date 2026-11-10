/** 极简文件日志：任何异常都不得影响宿主。 */
import fs from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024

export function createLogger(dir, name = 'workmemory') {
  let file
  try {
    fs.mkdirSync(dir, { recursive: true })
    file = path.join(dir, `${name}.log`)
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`)
    } catch { /* 首次写入 */ }
  } catch {
    file = undefined
  }

  const write = (level, args) => {
    if (!file) return
    try {
      const text = args
        .map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ')
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`)
    } catch { /* noop */ }
  }

  return {
    file,
    info: (...a) => write('INFO', a),
    warn: (...a) => write('WARN', a),
    error: (...a) => write('ERROR', a),
  }
}
