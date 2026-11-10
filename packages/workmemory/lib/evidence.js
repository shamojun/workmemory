/**
 * 证据校验（v3.1 严格化）。
 *
 * v3.0 曾允许"引用前 60% 命中"即通过，目的是容忍跨句拼接，
 * 代价是语义被反转仍能过检（评审 P0-2 的反例）：
 *   原文：…采用 MongoDB 7.0，不再使用 4.4
 *   引用：…采用 MongoDB 7.0，继续使用 4.4   ← 只匹配前半段就会误通过
 *
 * v3.1 起只认**完整子串**；跨消息必须给多条 evidence，不允许拼接引用。
 */

export function normalizeForMatch(s) {
  return String(s ?? '')
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[“”"'`]/g, '')
    .trim()
}

/**
 * @param {string} eventText 事件原文
 * @param {string} quote 模型给出的引用
 * @returns {boolean}
 */
export function quoteMatches(eventText, quote) {
  const q = normalizeForMatch(quote)
  if (q.length < 4) return false          // 太短不足以证明任何事
  const e = normalizeForMatch(eventText)
  if (!e) return false
  return e.includes(q)                    // 严格：完整子串
}

/** 从事件列表里按 seq 找到文本，并校验 quote。 */
export function findVerifiedEvent(events, seq, quote) {
  const hit = events.find((e) => e.seq === seq)
  if (!hit) return undefined
  if (!quoteMatches(hit.text, quote)) return undefined
  return hit
}

/** 严格度自评：'exact' | 'missing' | 'too-short'，供 eval / validate 使用。 */
export function verifyDetail(eventText, quote) {
  const q = normalizeForMatch(quote)
  if (q.length < 4) return 'too-short'
  const e = normalizeForMatch(eventText)
  if (!e) return 'missing'
  return e.includes(q) ? 'exact' : 'missing'
}
