/**
 * 记忆项存储（B1）：追加写 + 按 id 取最新版本 + 指纹去重。
 * 状态变更（superseded 等）也以"追加新版本"表达，加载时 last-write-wins。
 */
import fs from 'node:fs'
import path from 'node:path'
import { buildItem } from './model.js'
import { coerceItemV2, validateItem } from './schema.js'
import { assignTask } from './continuity.js'
import { assertInside, safeJoin } from './safety.js'
import { splitBecause, inferKind, isInjectableKind, CAUSE_RE } from './knowledge.js'

const MAX_BYTES = 16 * 1024 * 1024

export class ItemsStore {
  constructor({ dir, logger, guard }) {
    this.dir = dir
    this.logger = logger
    this.guard = guard            // () => boolean：写前校验锁代次（fencing）
    this.file = path.join(dir, 'items.jsonl')
    this.byId = new Map()
    this.byHash = new Map()
    this.version = 0
    this.load()
  }

  load() {
    this.byId.clear()
    this.byHash.clear()
    let raw = ''
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    // 尾部修复（v3.1）：进程在写一半时被杀，会留下半行 JSON。
    // 若不修复就继续追加，新记录会与残缺行拼成一行，永久损坏两条数据。
    if (raw && !raw.endsWith('\n')) {
      const cut = raw.lastIndexOf('\n')
      const tail = cut >= 0 ? raw.slice(cut + 1) : raw
      let tailOk = false
      try { tailOk = Boolean(JSON.parse(tail)?.id) } catch { tailOk = false }
      const fixed = tailOk ? `${raw}\n` : raw.slice(0, cut >= 0 ? cut + 1 : 0)
      try {
        fs.writeFileSync(this.file, fixed)
        this.logger?.warn?.(`items.jsonl: repaired incomplete tail (${raw.length - fixed.length} bytes dropped)`)
      } catch { /* 修复失败时只读，不阻塞 */ }
      raw = fixed
    }
    let bad = 0
    let normalized = 0
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const item = JSON.parse(line)
        if (!item?.id) continue
        // 自愈（S1b）：把 v1 形状、以及迁移窗口期写进来的"混合形状"归一化到 v2。
        // 只在内存里改，若发现确实需要改，载入后整文件重写一次。
        const fixed = coerceItemV2(item)
        if (JSON.stringify(fixed) !== JSON.stringify(item)) normalized += 1
        this.byId.set(item.id, fixed)              // last-write-wins
        if (fixed.hash) this.byHash.set(fixed.hash, fixed)
      } catch {
        bad += 1
      }
    }
    if (bad) this.logger?.warn?.(`items.jsonl: skipped ${bad} corrupt line(s)`)
    if (normalized > 0) {
      this.logger?.warn?.(`items.jsonl: normalized ${normalized} legacy line(s) to v2`)
      try {
        this.rewrite(new Map(this.byId))
      } catch (e) {
        this.logger?.warn?.('items.jsonl: rewrite after normalize failed', e)
      }
    }
  }

  /** 清理过期的临时决策：active/pending → stale（不再被检索或注入）。 */
  sweepExpired(now = Date.now()) {
    let n = 0
    for (const item of [...this.byId.values()]) {
      if (item.decisionScope !== 'temporary') continue
      if (!item.overrideUntil || item.overrideUntil > now) continue
      if (item.status !== 'active' && item.status !== 'pending') continue
      this.append({ ...item, status: 'stale', updatedAt: now, rev: (item.rev ?? 1) + 1 })
      n += 1
    }
    return n
  }

  get(id) {
    return this.byId.get(id)
  }

  /** 删除满足条件的条目并压实文件；返回删除条数。用于按来源重建（v3.1）。 */
  dropWhere(predicate) {
    const keep = new Map()
    for (const [id, item] of this.byId) if (!predicate(item)) keep.set(id, item)
    const dropped = this.byId.size - keep.size
    if (dropped === 0) return 0
    this.rewrite(keep)
    return dropped
  }

  append(item) {
    if (this.guard && !this.guard()) {
      this.logger?.warn?.('items write fenced: lock epoch changed')
      return undefined
    }
    // S1b：先归一化到 v2，再校验；不通过就拒绝写入（绝不让 v1 形状再落盘）
    const v2 = coerceItemV2(item)
    const check = validateItem(v2)
    if (!check.ok) {
      this.logger?.warn?.(`items write rejected: ${check.errors.slice(0, 2).join('; ')}`)
      return undefined
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const line = `${JSON.stringify(v2)}\n`
      fs.appendFileSync(this.file, line)
      this.byId.set(v2.id, v2)
      if (v2.hash) this.byHash.set(v2.hash, v2)
      this.version += 1
      this.maybeCompact()
      return v2
    } catch (e) {
      this.logger?.warn?.('items append failed', e)
      return undefined
    }
  }

  /** 候选 → 入库；同指纹合并证据，近似表述合并到已有项。 */
  add(candidate, now = Date.now()) {
    const built = buildItem(candidate, now)
    if (!built) return { kind: 'rejected' }

    const existing = this.byHash.get(built.hash)
    if (existing && existing.status !== 'invalid') {
      return { kind: 'merged', item: this.absorb(existing, built, now) }
    }

    // 冲突：同 entity + property、取值不同 → 旧项 superseded（D）
    if (built.decisionScope !== 'temporary' && built.entity && built.property && built.value) {
      const superseded = []
      for (const ex of [...this.byId.values()]) {
        if (ex.type !== built.type) continue
        if (ex.entity !== built.entity || ex.property !== built.property) continue
        if (!ex.value || ex.value === built.value) continue
        if (ex.status !== 'active' && ex.status !== 'pending') continue
        this.append({ ...ex, status: 'superseded', updatedAt: now, rev: (ex.rev ?? 1) + 1, supersededBy: built.id })
        superseded.push(ex.id)
      }
      if (superseded.length) built.supersedes = superseded
    }

    // 近似重复：同一类型、措辞不同但说的是同一件事 → 并入已有项
    if (NEAR_TYPES.has(built.type)) {
      let best
      let bestSim = 0
      for (const ex of this.byId.values()) {
        if (ex.type !== built.type) continue
        if (ex.status !== 'active' && ex.status !== 'pending') continue
        if (hasNegation(ex.text) !== hasNegation(built.text)) continue   // "用 X" vs "不用 X" 绝不合并
        const { sim, shared } = containment(ex.text, built.text)
        if (shared < NEAR_MIN_SHARED) continue                           // 共享词太少，不判近似
        if (sim > bestSim) { bestSim = sim; best = ex }
      }
      if (best && bestSim >= NEAR_THRESHOLD) {
        return { kind: 'merged-near', item: this.absorb(best, built, now) }
      }
    }

    this.append(built)
    return { kind: 'added', item: built }
  }

  /** 把 built 的证据/权威合并进 existing；active 优先于 pending。 */
  absorb(existing, built, now) {
    const promote = built.status === 'active' && existing.status === 'pending'
    const merged = {
      ...existing,
      status: promote ? 'active' : existing.status,
      // 合并永远取更强授权：不能因为"新条目 active"就把已有 tool_verified 降级
      authority: strongerAuthority(existing.authority, built.authority),
      evidence: mergeEvidence(existing.evidence, built.evidence),
      topics: [...new Set([...(existing.topics ?? []), ...(built.topics ?? [])])].slice(0, 8),
      confidence: Math.max(existing.confidence ?? 0, built.confidence),
      importance: higherImportance(existing.importance, built.importance),
      updatedAt: now,
      rev: (existing.rev ?? 1) + 1,
    }
    this.append(merged)
    return merged
  }

  /** 状态迁移：追加新版本。 */
  setStatus(id, status, reason) {
    const cur = this.byId.get(id)
    if (!cur || cur.status === status) return undefined
    const next = { ...cur, status, updatedAt: Date.now(), rev: (cur.rev ?? 1) + 1, statusReason: reason }
    this.append(next)
    return next
  }

  /**
   * 清掉"过程元信息"条目（测试通过数、临时目录、本仓库脚本名…）。
   * 只置 invalid，不物理删除——留审计；返回处理条数。
   */
  purgeMeta(patterns) {
    let n = 0
    for (const it of [...this.byId.values()]) {
      if (it.status !== 'active' && it.status !== 'pending') continue
      if (!patterns.some((re) => re.test(String(it.text ?? '')))) continue
      if (this.setStatus(it.id, 'invalid', 'meta_process_info')) n += 1
    }
    return n
  }

  /**
   * 一次性重算存量条目的任务归属（S2）。
   * 只处理"还没归属"的活跃/待确认条目；每个任务最多关联 maxPerTask 条，
   * 避免一个任务吃掉整个库、让任务过滤失去意义。
   */
  /**
   * 一次性回填知识形态（v3 迁移用）。
   * 存量条目只有 type 没有 kind；这里从文本拆出 because，拆得出才升级为 rationale/constraint/lesson。
   * 拆不出的保持 null（低价值陈述），不做猜测。
   */
  backfillKinds() {
    let n = 0
    for (const item of [...this.byId.values()]) {
      if (item.knowledgeKind) continue
      if (item.status !== 'active' && item.status !== 'pending') continue
      const { text, because } = splitBecause(item.text)
      const inferred = inferKind(item.text, item.type)
      const excludes = inferred === 'scope' ? (item.excludes ?? item.text) : (item.excludes ?? null)
      if (!because && !excludes) continue
      const kind = inferred ?? 'rationale'
      const fields = { because, signal: item.signal ?? null, excludes, observedAt: item.observedAt ?? Date.now() }
      if (!isInjectableKind(kind, fields)) continue
      const next = { ...item, text: text || item.text, because: because ?? null, excludes, knowledgeKind: kind, revision: (item.revision ?? item.rev ?? 1) + 1, updatedAt: Date.now() }
      if (this.append(next)) n += 1
    }
    return n
  }

  reattribute(tasks, { currentTaskId, maxPerTask = 60 } = {}) {
    const counts = new Map()
    for (const it of this.byId.values()) {
      if (it.taskAssignment?.status === 'resolved' && it.taskId) {
        counts.set(it.taskId, (counts.get(it.taskId) ?? 0) + 1)
      }
    }
    let n = 0
    for (const it of [...this.byId.values()]) {
      if (it.status !== 'active' && it.status !== 'pending') continue
      if (it.taskAssignment?.status === 'resolved') continue
      const context = (it.evidence ?? []).map((e) => e.quote).join(' ')
      const ta = assignTask({ text: it.text, context, tasks, currentTaskId })
      if (ta.status !== 'resolved' || !ta.taskId) continue
      const used = counts.get(ta.taskId) ?? 0
      if (used >= maxPerTask) continue
      counts.set(ta.taskId, used + 1)
      this.append({
        ...it,
        taskId: ta.taskId,
        taskAssignment: ta,
        revision: (it.revision ?? it.rev ?? 1) + 1,
        updatedAt: Date.now(),
      })
      n += 1
    }
    return n
  }

  list({ status, type, limit } = {}) {
    let out = [...this.byId.values()]
    if (status) out = out.filter((i) => i.status === status)
    if (type) out = out.filter((i) => i.type === type)
    out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return limit ? out.slice(0, limit) : out
  }

  counts() {
    const c = {}
    for (const i of this.byId.values()) c[i.type] = (c[i.type] ?? 0) + 1
    return c
  }

  /**
   * 淘汰（D）：把"已失效且超过保留期"的条目移入 archive/<YYYY-MM>.jsonl，
   * 并把 items.jsonl 重写为"每个 id 仅最新一版"。
   * 只淘汰 invalid / superseded / archived，active 与 pending 永不自动淘汰。
   */
  compact({ olderThanDays = 90, now = Date.now() } = {}) {
    const cutoff = now - olderThanDays * 864e5
    const keep = new Map()
    const archive = []
    for (const [id, item] of this.byId) {
      const old = (item.updatedAt ?? item.createdAt ?? 0) < cutoff
      if (old && ARCHIVABLE.has(item.status)) archive.push(item)
      else keep.set(id, item)
    }
    if (archive.length === 0) {
      this.rewrite(keep)
      return { archived: 0, kept: keep.size, rewritten: true }
    }

    const byMonth = new Map()
    for (const it of archive) {
      const m = new Date(it.updatedAt ?? it.createdAt ?? now).toISOString().slice(0, 7)
      if (!byMonth.has(m)) byMonth.set(m, [])
      byMonth.get(m).push(it)
    }
    // S5：归档路径同样必须在数据目录内（月份取自时间戳，仍走一遍校验）
    const archiveDir = safeJoin(this.dir, 'archive')
    fs.mkdirSync(archiveDir, { recursive: true })
    for (const [m, list] of byMonth) {
      const file = safeJoin(archiveDir, `items-${m}.jsonl`)
      assertInside(this.dir, file, 'archive file')
      fs.appendFileSync(file, `${list.map((i) => JSON.stringify(i)).join('\n')}\n`)
    }

    this.rewrite(keep)
    return { archived: archive.length, kept: keep.size, rewritten: true }
  }

  rewrite(map) {
    const tmp = `${this.file}.compact`
    fs.writeFileSync(tmp, `${[...map.values()].map((i) => JSON.stringify(i)).join('\n')}\n`)
    fs.renameSync(tmp, this.file)
    this.byId = new Map(map)
    this.byHash = new Map()
    for (const i of this.byId.values()) if (i.hash) this.byHash.set(i.hash, i)
    this.version += 1
  }

  maybeCompact() {
    try {
      if (fs.statSync(this.file).size < MAX_BYTES) return
      const tmp = `${this.file}.compact`
      fs.writeFileSync(tmp, [...this.byId.values()].map((i) => JSON.stringify(i)).join('\n') + '\n')
      fs.renameSync(tmp, this.file)
      this.logger?.info?.('items.jsonl compacted')
    } catch { /* noop */ }
  }
}

function mergeEvidence(a = [], b = []) {
  const key = (e) => `${e.sessionId}:${e.seq}`
  const map = new Map(a.map((e) => [key(e), e]))
  for (const e of b) if (!map.has(key(e))) map.set(key(e), e)
  return [...map.values()].slice(-20)
}

const ORDER = ['low', 'medium', 'high', 'critical']
function higherImportance(a, b) {
  return ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a
}

/* ── 近似判重（C）：字符二元组 Jaccard + 否定守卫 ───────────── */

const NEAR_TYPES = new Set(['constraint', 'decision', 'preference', 'gotcha'])
const NEAR_THRESHOLD = 0.6      // 包含度：共享词占较短文本的比例
const NEAR_MIN_SHARED = 6       // 共享词下限，避免短文本误合并
/** 只有这些状态会被淘汰；active / pending 永不自动归档。 */
const ARCHIVABLE = new Set(['invalid', 'superseded', 'archived'])

function grams(s) {
  const t = String(s ?? '').toLowerCase()
  const set = new Set()
  for (const w of t.match(/[a-z][a-z0-9_+#.\-]{1,}/g) ?? []) set.add(w)
  const cjk = t.replace(/[^\u4e00-\u9fa5]/g, '')
  for (let i = 0; i + 1 < cjk.length; i += 1) set.add(cjk.slice(i, i + 2))
  return set
}

export function jaccard(a, b) {
  const A = grams(a)
  const B = grams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter += 1
  return inter / (A.size + B.size - inter)
}

/** 包含度：共享词 / 较短文本词数；同时返回共享词数。 */
export function containment(a, b) {
  const A = grams(a)
  const B = grams(b)
  if (A.size === 0 || B.size === 0) return { sim: 0, shared: 0 }
  let shared = 0
  for (const x of A) if (B.has(x)) shared += 1
  return { sim: shared / Math.min(A.size, B.size), shared }
}

function hasNegation(s) {
  return /(不|禁止|不得|别|不要)/.test(String(s ?? ''))
}

const AUTH_ORDER = ['assistant', 'user_historical', 'tool_verified', 'user_confirmed', 'user_explicit']
function strongerAuthority(a, b) {
  return AUTH_ORDER.indexOf(b) > AUTH_ORDER.indexOf(a) ? b : a
}
