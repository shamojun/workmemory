/**
 * 路径安全（S5）。
 *
 * 背景：插件用 `node:fs` 直接读写，绕过了 DSH 的 `ctx.fs` 沙箱。
 * 因此必须自建边界：所有写入路径都必须落在 `<workspace>/.dsh/memory` 之内。
 *
 * 设计：一切以 realpath 后的真实路径比较（Windows 大小写不敏感、8.3 短名、
 * 符号链接都要先归一），任何越界抛 `PATH_ESCAPE`，由调用方决定降级。
 */
import fs from 'node:fs'
import path from 'node:path'

/** realpath 归一；路径不存在时退回 resolve（创建前的校验需要）。 */
export function canonical(p) {
  try {
    return fs.realpathSync.native(p)
  } catch {
    try {
      return path.resolve(p)
    } catch {
      return String(p)
    }
  }
}

/** target 是否在 base 之内（含 base 本身）。Windows 下大小写不敏感。 */
export function isInside(base, target) {
  const b = canonical(base)
  const t = canonical(target)
  if (!b || !t) return false
  if (process.platform === 'win32') {
    const bb = b.toLowerCase()
    const tt = t.toLowerCase()
    return tt === bb || tt.startsWith(bb.endsWith('\\') ? bb : `${bb}\\`)
  }
  return t === b || t.startsWith(`${b}${path.sep}`)
}

export function pathEscape(what, target, base) {
  const e = new Error(`${what} escapes base: ${target} not inside ${base}`)
  e.code = 'PATH_ESCAPE'
  return e
}

export function assertInside(base, target, what = 'path') {
  if (!isInside(base, target)) throw pathEscape(what, target, base)
  return target
}

/** 单个路径段：拒绝绝对路径、`..`、Windows 保留字符。 */
export function safeSegment(seg, what = 'segment') {
  const s = String(seg ?? '')
  if (!s) throw pathEscape(`${what} (empty)`, s, '')
  if (path.isAbsolute(s)) throw pathEscape(`${what} (absolute)`, s, '')
  if (s === '..' || s.includes('..') || s.includes('/') || s.includes('\\')) {
    throw pathEscape(`${what} (dotdot/slash)`, s, '')
  }
  if (/[<>:"|?*\u0000-\u001f]/.test(s)) throw pathEscape(`${what} (reserved char)`, s, '')
  return s
}

/** 在 base 下安全拼路径：每段校验 + 结果必须仍在 base 内。 */
export function safeJoin(base, ...segs) {
  const safe = segs.filter((s) => s != null && s !== '').map((s) => safeSegment(s))
  return assertInside(base, path.join(base, ...safe), 'safeJoin')
}
