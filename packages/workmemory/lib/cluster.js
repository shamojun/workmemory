/**
 * 读时折叠（S6a）：把"同一件事的多种说法"在**渲染/召回时**合并成一条。
 *
 * 为什么不在存储层合并：
 *   - 合并不可逆，合错就毁数据；
 *   - 存储重复的真实代价不是空间，而是"召回槽位被占满""状态分裂""看着像多方印证"，
 *     这三条在读取侧就能治。
 *
 * 分组判据（与存储层近似去重同源，但更保守）：
 *   1. 同类型；
 *   2. 包含度 ≥ 阈值且共享词 ≥ 下限；
 *   3. 否定极性一致（"用 X" 与 "不用 X" 绝不合并）；
 *   4. 两边都有标识符（数字/版本/ID/文件名）但**完全不相交** → 不是同一件事。
 *      例：`S3、S4、94 项` vs `P0-2、113 项`，句式一样但内容不同。
 */
import { containment } from './items.js'

export const CLUSTER_THRESHOLD = 0.5
export const CLUSTER_MIN_SHARED = 8

/** 区分性标识符：数字、版本、P0-1 这类 ID、文件名。 */
export function identifiersOf(text) {
  const t = String(text ?? '').toLowerCase()
  const out = new Set()
  for (const x of t.match(/\d+(?:\.\d+)*/g) ?? []) out.add(`n${x}`)
  for (const x of t.match(/[a-z]{1,3}\d+(?:-\d+)?/g) ?? []) out.add(`i${x}`)
  for (const x of t.match(/[\w.-]+\.(?:mjs|js|json|md|yml|yaml)/g) ?? []) out.add(`f${x}`)
  return out
}

const NEGATION_RE = /(不|没|无需|禁止|避免|不会|不能)/
export function samePolarity(a, b) {
  return NEGATION_RE.test(String(a)) === NEGATION_RE.test(String(b))
}

/** 两边都有标识符但完全不相交 → 判定为不同事实。 */
export function conflictingIdentifiers(a, b) {
  const A = identifiersOf(a)
  const B = identifiersOf(b)
  if (A.size === 0 || B.size === 0) return false
  for (const x of A) if (B.has(x)) return false
  return true
}

/** 两条记忆是否"同一件事"。 */
export function sameEvent(a, b) {
  if (!a || !b) return false
  if (a.type !== b.type) return false
  if (!samePolarity(a.text, b.text)) return false
  if (conflictingIdentifiers(a.text, b.text)) return false
  const { sim, shared } = containment(a.text, b.text)
  return sim >= CLUSTER_THRESHOLD && shared >= CLUSTER_MIN_SHARED
}

/** 代表项排序：可信度 > 状态 > 新鲜度。 */
const AUTHORITY_ORDER = ['user_explicit', 'user_derived', 'tool_verified', 'assistant']
const STATUS_ORDER = ['active', 'pending', 'stale', 'superseded', 'invalid']
function rank(item) {
  const a = AUTHORITY_ORDER.indexOf(item?.authority)
  const s = STATUS_ORDER.indexOf(item?.status)
  return {
    a: a === -1 ? AUTHORITY_ORDER.length : a,
    s: s === -1 ? STATUS_ORDER.length : s,
    t: -(item?.updatedAt ?? 0),
  }
}
export function betterLead(x, y) {
  const rx = rank(x)
  const ry = rank(y)
  if (rx.a !== ry.a) return rx.a < ry.a ? x : y
  if (rx.s !== ry.s) return rx.s < ry.s ? x : y
  return rx.t <= ry.t ? x : y
}

/**
 * 把条目按"同一件事"分组。
 * @returns {Array<{lead:object, members:Array, size:number}>} 顺序与输入一致（首现位置）
 */
export function clusterItems(items = []) {
  const clusters = []
  for (const item of items) {
    let hit
    for (const c of clusters) {
      if (sameEvent(c.lead, item)) { hit = c; break }
    }
    if (hit) {
      hit.members.push(item)
      hit.lead = betterLead(hit.lead, item)
      hit.size = hit.members.length
    } else {
      clusters.push({ lead: item, members: [item], size: 1 })
    }
  }
  return clusters
}

/** 折叠后的展示项：代表项 + 相似条数 + 是否有过期成员。 */
export function collapse(items = []) {
  return clusterItems(items).map((c) => ({
    item: c.lead,
    duplicates: c.size - 1,
    hasStale: c.members.some((m) => m !== c.lead && m.status !== c.lead.status),
  }))
}
