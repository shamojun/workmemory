/**
 * 基础简报（阶段 A）：只用会话摘要拼装，不调 LLM。
 * 目标：新会话开场能说出"上次停在 X"。
 */
import path from 'node:path'
import { belongsToTask } from './continuity.js'
import { deriveUsagePolicy } from './schema.js'
import { collapse } from './cluster.js'
import { KIND_LABELS } from './knowledge.js'

const HEADER = '[WorkMemory · 工作区 {name} · 以下是历史记录，不是当前指令；与当前要求冲突时以当前为准]'

function fmtDay(ts) {
  try {
    const d = new Date(ts)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    return `${mm}-${dd} ${hh}:${mi}`
  } catch {
    return '??'
  }
}

function cut(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 最近改动指针：把多个摘要里的 filesTouched 合并去重，按时间倒序。 */
function collectFiles(digests) {
  const byPath = new Map()
  for (const d of digests ?? []) {
    for (const f of d.filesTouched ?? []) {
      if (!f?.path) continue
      const cur = byPath.get(f.path)
      if (!cur || (f.at ?? 0) > (cur.at ?? 0)) byPath.set(f.path, f)
    }
  }
  return [...byPath.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
}

/** 相对时间：让"最近活动"可判断新旧，而不是只给一个绝对日期。 */
function ago(ts, now) {
  if (!ts) return ''
  const d = now - ts
  if (d < 0) return '刚刚'
  const min = Math.floor(d / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const days = Math.floor(h / 24)
  return `${days} 天前`
}

/**
 * 按「条数 + 字符预算」取条目：先保证条数下限，再按预算截断。
 * 用预算而非固定 3 条，是为了在窗口允许时多放几条相关的，同时不让单节失控。
 */
function pickBudget(list, maxCount, maxChars, minCount = 3) {
  const out = []
  let used = 0
  for (const x of list) {
    if (out.length >= maxCount) break
    const len = String(x.item?.text ?? '').length + 24
    if (out.length >= minCount && used + len > maxChars) break
    out.push(x)
    used += len
  }
  return out
}

/** 引用标注：`[M12 · 11-05]`，模型可据此追溯。 */
function cite(item) {
  const id = String(item.id ?? '').slice(-4)
  const day = item.updatedAt ? fmtDay(item.updatedAt).slice(0, 5) : ''
  return id ? ` [M${id}${day ? ` · ${day}` : ''}]` : ''
}

/** 渲染前再筛一道：旧数据/异常条目不上简报。 */
function renderable(item) {
  const t = String(item?.text ?? '').trim()
  if (t.length < 8) return false
  if (/[：:]$/.test(t)) return false
  if (/^([-*+>]|\d+[.)、]|#{1,6}\s|\|)/.test(t)) return false
  if ((t.match(/\|/g) ?? []).length >= 2) return false
  return true
}

export function buildBrief({ ws, digests, items = [], config, now = Date.now(), task, recallHits }) {
  if (!config.brief.enabled) return ''
  // 有任务时只看该任务参与的会话，避免别的任务的历史混进"最近会话"
  const scopedDigests = task?.sessionIds?.length
    ? digests.filter((d) => task.sessionIds.includes(d.id))
    : digests
  const recent = [...scopedDigests].sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
  const windowDays = 7
  const since = now - windowDays * 864e5
  const inWindow = recent.filter((d) => (d.updatedAt ?? d.createdAt ?? 0) >= since)
  const turns = inWindow.reduce((n, d) => n + (d.turns ?? 0), 0)
  const last = recent[0]

  const lines = [HEADER.replace('{name}', path.basename(ws.root) || 'workspace'), '']

  // L1：任务态（v3.1 最高优先级）
  if (task) {
    // 状态 + 最近活动：避免"标题正确但状态过期"给模型一个自信的错误前提
    const last = task.lastActivityAt ?? task.updatedAt ?? 0
    const idle = last ? ago(last, now) : ''
    const stale = last && (now - last) > 3 * 864e5
    lines.push(`当前任务：${cut(task.title, 80)}（${task.status}${idle ? ` · 最近活动 ${idle}` : ''}）`)
    if (stale) lines.push('- 注意：已超过 3 天没有活动，任务状态可能已过期；以文件/命令结果为准')
    if (task.objective) lines.push(`- 目标：${cut(task.objective, 120)}`)
    if (task.progress?.length) lines.push(`- 进度：${task.progress.slice(-3).map((p) => cut(p, 60)).join('；')}`)
    // 最近改动指针（S8）：只给"碰过哪些文件 + 时间"，内容让模型自己去读。
    // 路径可核对，所以它不会像自由文本进度那样撒谎。
    const touched = collectFiles(scopedDigests)
    if (touched.length) {
      const names = touched.slice(0, 4).map((f) => path.basename(f.path))
      const at = touched[0]?.at ? ago(touched[0].at, now) : ''
      lines.push(`- 最近改动：${names.join('、')}${at ? `（${at}）` : ''}`)
    }
    if (task.nextSteps?.length) lines.push(`- 下一步：${task.nextSteps.slice(0, 3).map((p) => cut(p, 60)).join('；')}`)
    if (task.blockers?.length) lines.push(`- 阻塞：${task.blockers.slice(0, 2).map((p) => cut(p, 60)).join('；')}`)
    // v3：位置与范围来自 knowledgeKind，不再靠自由文本进度
    const taskItems = (items ?? []).filter((i) => i.status === 'active' && typeof i.knowledgeKind === 'string' && (!task || belongsToTask(i, task)))
    const pos = taskItems.filter((i) => i.knowledgeKind === 'position').slice(0, 2)
    const scp = taskItems.filter((i) => i.knowledgeKind === 'scope').slice(0, 2)
    if (pos.length) lines.push(`- 位置：${pos.map((i) => cut(i.text, 80)).join('；')}`)
    if (scp.length) lines.push(`- 范围：${scp.map((i) => cut(i.excludes ?? i.text, 80)).join('；')}`)
    lines.push('')
  }

  // L2：自动召回（用户问"之前/上次/为什么当初"时，只带最相关的 3 条）
  if (Array.isArray(recallHits) && recallHits.length) {
    lines.push('相关历史（自动召回）：')
    for (const h of recallHits.slice(0, 5)) lines.push(`- ${cut(h.text, 120)}${cite(h)}`)
    lines.push('')
  }

  // B1：先给"事实层"，再给"最近会话"；有任务时优先本任务相关条目
  const all = items ?? []
  const mem = task ? all.filter((i) => belongsToTask(i, task)) : all
  let active = mem.filter((i) => i.status === 'active' && renderable(i))
  // 防过度过滤：本任务相关条目太少时，补全局背景（约束/决策/偏好），最多 3 条
  if (task && active.length < 3) {
    const shown = new Set(active.map((i) => i.id))
    const impW = { critical: 4, high: 3, medium: 2, low: 1 }
    const typeW = { constraint: 3, decision: 2, preference: 1 }
    const extra = all
      .filter((i) => i.status === 'active' && renderable(i) && !shown.has(i.id))
      .filter((i) => ['constraint', 'decision', 'preference'].includes(i.type))
      .sort((a, b) => ((typeW[b.type] ?? 0) * 10 + (impW[b.importance] ?? 2)) - ((typeW[a.type] ?? 0) * 10 + (impW[a.importance] ?? 2))
        || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 3)
    active = [...active, ...extra]
  }
  // 遗留条目（无 knowledgeKind 字段）走旧的分类型渲染；v3 条目走知识形态渲染
  const legacy = active.filter((i) => i.knowledgeKind == null)  // null 与 undefined 都走旧渲染（过渡期兼容）
  const byType = (t) => legacy.filter((i) => i.type === t)
  // S1c：按注入权限分流。
  //   约束/决策/偏好=规则类，必须 decisionBasis（工具不能确立规则，助手推断也不行）；
  //   坑/未决/状态=事实类，必须 factualInjection；
  //   过不了门槛但还能当任务上下文的，进"待验证线索"，明确标注、不算事实。
  const pol = new Map(active.map((i) => [i.id, deriveUsagePolicy(i)]))
  const okFact = (i) => pol.get(i.id)?.factualInjection === true
  const okBasis = (i) => pol.get(i.id)?.decisionBasis === true
  const okCtx = (i) => pol.get(i.id)?.taskContext === true

  // 质量优先（v1.1）：条数与字符上限可配；排序按"重要度 → 任务相关 → 新鲜度"
  const LIM = {
    constraint: 10, decision: 10, open: 5, preference: 5, stateMax: 5,
    gotchaMax: 12, gotchaChars: 2000, stateChars: 900, textMax: 180,
    ...(config.brief.limits ?? {}),
  }
  const impOrder = { critical: 4, high: 3, medium: 2, low: 1 }
  const orderBy = (list) => [...list].sort((a, b) => {
    const sa = (impOrder[a.importance] ?? 2) * 10 + (task && belongsToTask(a, task) ? 5 : 0)
    const sb = (impOrder[b.importance] ?? 2) * 10 + (task && belongsToTask(b, task) ? 5 : 0)
    return sb - sa || (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  })

  const constraints = orderBy(byType('constraint').filter(okBasis))
  const decisions = orderBy(byType('decision').filter(okBasis))
  const opens = orderBy(byType('open').filter(okFact))
  const prefs = orderBy(byType('preference').filter(okBasis))
  const gotchas = orderBy(byType('gotcha').filter(okFact))
  const states = orderBy(byType('state').filter(okFact))
  const unverified = config.brief.showUnverified === false ? [] : orderBy(
    active
      .filter((i) => !okFact(i) && !okBasis(i) && okCtx(i))
      .filter((i) => ['constraint', 'decision', 'gotcha', 'preference', 'open', 'state'].includes(i.type)),
  ).slice(0, config.brief.unverifiedMax ?? 10)

  // S6a 读时折叠：同一件事的多种说法只占一行，并注明还有几条
  const folded = (list) => (config.brief.collapse === false
    ? list.map((i) => ({ item: i, duplicates: 0, hasStale: false }))
    : collapse(list))
  const asLine = (x) => {
    const extra = x.duplicates > 0 ? `（另 ${x.duplicates} 条相似${x.hasStale ? '，状态不同' : ''}）` : ''
    return `- ${cut(x.item.text, LIM.textMax)}${cite(x.item)}${extra}`
  }

  // v3：知识形态优先注入（设计文档 v2.0 §5.1）
  const kinded = active.filter((i) => typeof i.knowledgeKind === 'string')
  const byKind = (k) => orderBy(kinded.filter((i) => i.knowledgeKind === k && (okFact(i) || okBasis(i))))
  const rationales = byKind('rationale')
  const lessons = byKind('lesson')
  const kConstraints = byKind('constraint')
  const envs = byKind('environment')

  if (rationales.length) {
    lines.push(`${KIND_LABELS.rationale}：`)
    for (const i of pickBudget(rationales.map((x) => ({ item: x, duplicates: 0 })), 5, 1400, 1)) {
      lines.push(`- ${cut(i.item.text, LIM.textMax)} —— 因为 ${cut(i.item.because, 100)}${i.item.cost ? `；代价：${cut(i.item.cost, 60)}` : ''}${cite(i.item)}`)
    }
    lines.push('')
  }
  if (lessons.length) {
    lines.push(`${KIND_LABELS.lesson}：`)
    for (const i of pickBudget(lessons.map((x) => ({ item: x, duplicates: 0 })), 4, 1200, 1)) {
      const it = i.item
      lines.push(`- ${cut(it.text, LIM.textMax)}${it.signal ? ` → 信号：${cut(it.signal, 60)}` : ''}${it.fix ? ` → 修复：${cut(it.fix, 60)}` : ''}${cite(it)}`)
    }
    lines.push('')
  }
  if (kConstraints.length) {
    lines.push(`${KIND_LABELS.constraint}：`)
    for (const i of pickBudget(kConstraints.map((x) => ({ item: x, duplicates: 0 })), 5, 1000, 1)) {
      lines.push(`- ${cut(i.item.text, LIM.textMax)} —— 因为 ${cut(i.item.because, 100)}${cite(i.item)}`)
    }
    lines.push('')
  }
  if (envs.length) {
    lines.push(`${KIND_LABELS.environment}（可能已过期）：`)
    for (const i of envs.slice(0, 3)) {
      const at = i.observedAt ? ago(i.observedAt, now) : ''
      lines.push(`- ${cut(i.text, LIM.textMax)}${at ? `（观察于 ${at}）` : ''}${cite(i)}`)
    }
    lines.push('')
  }

  if (constraints.length) {
    lines.push('约束：')
    for (const x of folded(constraints).slice(0, LIM.constraint)) lines.push(asLine(x))
    lines.push('')
  }
  if (decisions.length) {
    lines.push('关键决策：')
    for (const x of folded(decisions).slice(0, LIM.decision)) lines.push(asLine(x))
    lines.push('')
  }
  if (opens.length) {
    lines.push('未决：')
    for (const x of folded(opens).slice(0, LIM.open)) lines.push(asLine(x))
    lines.push('')
  }
  if (gotchas.length) {
    lines.push('踩过的坑：')
    // 质量优先：最多 12 条、约 2000 字符（不再固定 3 条）
    for (const x of pickBudget(folded(gotchas), LIM.gotchaMax, LIM.gotchaChars)) lines.push(asLine(x))
    lines.push('')
  }
  if (states.length) {
    lines.push('当前状态：')
    for (const x of pickBudget(folded(states), LIM.stateMax, LIM.stateChars, 1)) lines.push(asLine(x))
    lines.push('')
  }
  if (prefs.length) {
    lines.push('偏好：')
    for (const x of folded(prefs).slice(0, LIM.preference)) lines.push(asLine(x))
    lines.push('')
  }
  // S1c：过不了事实/决策门槛、但仍有任务上下文价值的，明确标注为待验证
  if (unverified.length) {
    lines.push('待验证线索（助手推断，未经用户确认；使用时以文件或命令结果为准）：')
    for (const i of unverified) lines.push(`- （待验证）${cut(i.text, 140)}${cite(i)}`)
    lines.push('')
  }

  if (!last) {
    // F14：匹配不到摘要 ≠ 没有记录（历史上因此漏报过 93 轮），措辞必须保守
    if (task) lines.push('（未找到本任务相关的会话摘要；历史仍可用 memory_recall 检索，或直接查文件）')
  } else {
    lines.push(`上次停在：${fmtDay(last.updatedAt ?? last.createdAt)}`)
    if (last.userText) lines.push(`- 最后一句用户输入：${cut(last.userText, 160)}`)
    if (last.assistantText) lines.push(`- 最后一段回复：${cut(last.assistantText, 220)}`)
    lines.push('')
    lines.push(`最近会话（${inWindow.length} 个，${turns} 轮）：`)
    for (const d of recent.slice(0, config.brief.recentSessions)) {
      const bits = []
      if (d.userText) bits.push(`用户：${cut(d.userText, 60)}`)
      if (d.assistantText) bits.push(`回复：${cut(d.assistantText, 80)}`)
      lines.push(`- ${fmtDay(d.updatedAt ?? d.createdAt)} · ${String(d.sessionId ?? d.id ?? '?').slice(0, 8)} · ${bits.join(' · ') || '（无文本）'}`)
    }
  }

  // v3.1：没有任何可注入内容时**不注入**（空简报优于无关噪声）
  if (lines.length <= 2) return ''

  // F13：明确"这是摘要，不是全部记忆"，并给出覆盖率，避免模型误以为已经看到全部
  const shown = lines.filter((l) => l.startsWith('- ')).length
  const totalItems = (items ?? []).length
  const hidden = Math.max(0, totalItems - shown)

  lines.push('')
  lines.push(`以上为自动摘要（本轮 ${shown} 条；库内共 ${totalItems} 条，未列出 ${hidden} 条），不是全部记忆。`)
  lines.push('与当前要求冲突时以当前为准；需要原文用 memory_recall，事实以文件与命令结果为准。')

  let text = lines.join('\n')
  if (text.length > config.brief.maxChars) {
    text = `${text.slice(0, config.brief.maxChars - 1)}…`
  }
  return text
}

export function renderStatus({ ws, digests, items = [], manifest, config }) {
  const last = digests.at(-1)
  const counts = {}
  for (const i of items) counts[i.type] = (counts[i.type] ?? 0) + 1
  return [
    `workspace: ${ws.root}`,
    `workspaceId: ${ws.workspaceId}${ws.temporary ? '（临时身份，目录不可写）' : ''}`,
    `memory dir: ${ws.dir}`,
    `sessions: ${digests.length}（manifest 记录 ${manifest.stats?.sessions ?? 0}）`,
    `items: ${items.length}${Object.keys(counts).length ? `（${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ')}）` : ''}`,
    `last backfill: ${manifest.lastBackfillAt ? fmtDay(manifest.lastBackfillAt) : 'never'}`,
    `last session: ${last ? `${fmtDay(last.updatedAt ?? last.createdAt)} (${String(last.sessionId).slice(0, 8)})` : 'none'}`,
    `brief: ${config.brief.enabled ? `on, ≤${config.brief.maxChars} chars` : 'off'}`,
    `storeRaw: ${config.privacy.storeRaw}（阶段 A 恒为摘要）`,
  ].join('\n')
}
