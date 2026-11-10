/**
 * 规则抽取（B1，零 LLM）。
 *
 * 实测结论（2026-11-05，真实会话 2616 事件）：
 *   规则最先被"粘贴的方案文档 / markdown 列表 / 冒号片段"污染，
 *   因此这里的首要任务不是"多抽"，而是"**不抽错**"。
 *
 * 硬约束：
 *   1. 只从真实用户输入抽（`source.kind === 'user'`），助手陈述留给 B2 的 LLM 蒸馏；
 *   2. 只看短消息（长文本是文档，不是意图）；
 *   3. 拦截列表项、标题、表格行、纯冒号片段；
 *   4. 句子长度 8–200，且必须含 ≥6 个中文字符或 ≥2 个英文词。
 */
import { clip, QUOTE_MAX, topicsOf } from './model.js'
import { splitBecause, inferKind, SCOPE_RE, LESSON_RE, CAUSE_RE } from './knowledge.js'

const MAX_MESSAGE_CHARS = 400
const MIN_SENTENCE = 8
const MAX_SENTENCE = 200

/** 规则版本：变更后启动时自动清空并重抽（见 index.js 的自愈逻辑）。 */
export const RULES_VERSION = 3

const RULES = [
  {
    type: 'constraint',
    importance: 'critical',
    patterns: [/不允许/, /不得/, /禁止/, /不引入/, /不依赖/, /不能用/, /只能/],
  },
  {
    type: 'preference',
    importance: 'high',
    patterns: [/以后都/, /以后用/, /以后统一/, /今后/, /统一用/, /一律/, /永远/, /记住/],
  },
  {
    type: 'decision',
    importance: 'high',
    patterns: [/改成/, /改为/, /改用/, /换成/, /决定用/, /决定采用/, /采用/, /定为/, /放弃/, /否决/, /不用了/, /算了/],
  },
  {
    type: 'open',
    importance: 'medium',
    patterns: [/待确认/, /待定/, /未决/, /需要确认/, /等.{0,6}确认/, /TODO/],
  },
  {
    type: 'gotcha',
    importance: 'medium',
    patterns: [/报错/, /失败/, /踩坑/, /EPERM/],
  },
  // v3：范围/排除（文件里不会写"这次不做"）
  {
    type: 'open',
    importance: 'medium',
    patterns: [/不包含/, /不含/, /不做/, /不涉及/, /范围之外/, /暂不/],
  },
  // v3：因果句（用户亲口给出的"为什么"，最便宜的理由来源）
  {
    type: 'decision',
    importance: 'high',
    patterns: [/因为/, /否则/, /导致/],
  },
]

function sentences(text) {
  return String(text ?? '')
    .split(/[。！？\n；;]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 列表项 / 标题 / 表格 / 有序编号：都不是"用户意图句"。 */
function isFragment(sentence) {
  const s = sentence.trim()
  if (!s) return true
  if (/^([-*+>]|\d+[.)、]|#{1,6}\s)/.test(s)) return true      // 列表/标题/引用
  if (/^\|/.test(s)) return true                               // 表格
  if (/[：:]$/.test(s)) return true                            // 纯引导语，如"下一步："
  if ((s.match(/\|/g) ?? []).length >= 2) return true          // 表格片段
  if (/^\s*[-–—]{2,}/.test(s)) return true
  return false
}

/** 粘贴的文档/代码块/清单：整条消息跳过。 */
function looksLikeDocument(text) {
  const t = String(text ?? '')
  if (t.length > MAX_MESSAGE_CHARS) return true
  if (t.includes('```')) return true
  if (/^#{1,6}\s/m.test(t)) return true
  if (/\n\s*[-*+]\s+/.test(t)) return true
  if (/\n\s*\d+[.)]\s+/.test(t)) return true
  if (/\n\s*\|/.test(t)) return true
  return false
}

function isGoodSentence(s) {
  const t = s.trim()
  if (t.length < MIN_SENTENCE || t.length > MAX_SENTENCE) return false
  if (isFragment(t)) return false
  const cjk = (t.match(/[\u4e00-\u9fa5]/g) ?? []).length
  const latin = (t.match(/[a-zA-Z][a-zA-Z0-9_.+-]{1,}/g) ?? []).length
  return cjk >= 4 || latin >= 1
}

function clauses(sentence) {
  return String(sentence).split(/[，,、]/).map((s) => s.trim()).filter(Boolean)
}

/**
 * 取"命中子句"而不是整句：
 * 真实消息常把多个意图塞在一句里（"…实现插件…不依赖第三方服务…"），
 * 整句入库既长又混。优先返回包含命中的最短子句。
 */
function pickSentence(text, patterns) {
  const all = sentences(text)
  const hits = []
  for (const s of all) {
    if (isFragment(s)) continue
    if (!patterns.some((re) => re.test(s))) continue
    const sub = clauses(s).filter((c) => isGoodSentence(c) && patterns.some((re) => re.test(c)))
    if (sub.length) hits.push(...sub)
    else if (isGoodSentence(s)) hits.push(s)
  }
  if (hits.length === 0) return undefined
  return hits.sort((a, b) => a.length - b.length)[0]
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}

/**
 * @returns 候选数组（未入库）
 */
export function extractCandidates(event, sessionId) {
  const out = []
  if (!event || !sessionId) return out
  if (event.type !== 'user/message') return out          // B1 只抽用户输入
  if (event.data?.source?.kind !== 'user') return out    // 排除运行时快照

  const text = textOfContent(event.data?.content)
  if (!text || looksLikeDocument(text)) return out

  for (const rule of RULES) {
    const sentence = pickSentence(text, rule.patterns)
    if (!sentence) continue

    const candidate = {
      type: rule.type,
      origin: 'rule',
      extractorVersion: RULES_VERSION,
      text: clip(sentence, 160),
      topics: topicsOf(sentence),
      importance: rule.importance,
      confidence: 0.9,
      authority: 'user_explicit',
      status: 'active',
      evidence: [{
        sessionId,
        seq: event.seq,
        role: 'user',
        quote: clip(String(text).replace(/\s+/g, ' ').trim(), QUOTE_MAX),
        assertionType: 'explicit',
      }],
    }
    // P0-3：规则通道也要产出"知识形态"——用户话里的因果/边界是最便宜的理由来源。
    // 因果句要拿"整句"拆：pickSentence 可能只选中"因为…"那个子句
    const causal = sentences(text).find((x) => CAUSE_RE.test(x) && isGoodSentence(x))
    const src = causal ?? sentence
    const { text: core, because } = splitBecause(src)
    if (because) {
      candidate.knowledgeKind = inferKind(src, rule.type) ?? (rule.type === 'constraint' ? 'constraint' : 'rationale')
      candidate.because = clip(because, 160)
      if (core && core.length >= 4) candidate.text = clip(core, 160)
    } else if (SCOPE_RE.test(sentence)) {
      candidate.knowledgeKind = 'scope'
      candidate.excludes = clip(sentence, 160)
    } else if (rule.type === 'gotcha' && LESSON_RE.test(sentence)) {
      candidate.knowledgeKind = 'lesson'
      const sig = sentence.match(/[A-Z]{2,}[A-Z0-9_]{2,}|FS_SANDBOX_DENIED|EPERM|EIO|EACCES|ENOENT/)
      candidate.signal = clip(sig ? sig[0] : sentence, 120)
    }

    // v3.1.1：带"临时/暂时/先"的决策记为 temporary，默认 7 天后失效，且不取代长期决策
    if (rule.type === 'decision' && /(临时|暂时|先按|先这样|先这么)/.test(sentence)) {
      candidate.decisionScope = 'temporary'
      candidate.overrideUntil = Date.now() + 7 * 864e5
    }
    out.push(candidate)
  }
  return out
}
