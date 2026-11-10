/**
 * 知识形态（v3 契约核心）。
 *
 * 见设计文档 §3：条目按"哪种知识"分类，而不是只按"关于什么"。
 * 只有 type 没有 kind 的条目：入库但不注入（低价值陈述）。
 *
 * 六类都满足一条判据：删掉它，模型不能从文件或命令里得到。
 */

export const KINDS = ['rationale', 'lesson', 'constraint', 'scope', 'position', 'environment']

/** 每类必填的支撑字段（缺了就不该被注入）。 */
export const KIND_REQUIRED = {
  rationale: ['because'],
  lesson: ['signal'],
  constraint: ['because'],
  scope: ['excludes'],
  position: [],
  environment: ['observedAt'],
}

/** 因果/边界句式：规则通道与保真判定都用它。 */
export const CAUSE_RE = /(因为|由于|否则|不然|避免|宁可|不能用|不要用|必须|不能|只能|导致|会冲掉|会覆盖)/
export const SCOPE_RE = /(不(?:包含|含|涉及|迁移)|暂不|先不做|排除|范围之外|不含)/
export const LESSON_RE = /(报错|失败|挂了|不兼容|冲突|Failed|ERROR|异常|超时|EPERM|EIO|EACCES|ENOENT|DENIED)/

/**
 * 纯值模式：路径 / IP:端口 / 版本号 / 键值 / 摘要 / 文件清单。
 * 命中这些且没有因果支撑的条目，属于"读一次文件就有"，应丢弃。
 */
export const VALUE_ONLY_PATTERNS = [
  /(?:^|[\s（(])[A-Za-z]:[\\/][^\s，。；]*/,          // Windows 盘路径
  /(?:^|[\s（(])\/[\w.-]+\/[\w./-]+/,                  // 类 Unix 路径
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?\b/,          // IP(:端口)
  /\b[a-z][\w.-]*\.(?:mjs|js|ts|json|ya?ml|xml|md|sh|ps1)\b/i, // 文件名
  /\b\d+\.\d+(?:\.\d+)*\b/,                            // 版本号
  /\b[a-z_]{2,}\s*[:=]\s*\S+/i,                        // key=value / key: value
  /\bsha1:[0-9a-f]{8,}|\bsha256:[0-9a-f]{8,}/i,        // 摘要
]

export function hasCause(text) {
  return CAUSE_RE.test(String(text ?? ''))
}

export function isValueOnly(text) {
  const t = String(text ?? '')
  if (!t) return false
  return VALUE_ONLY_PATTERNS.some((re) => re.test(t))
}

/**
 * 从文本推断知识形态（迁移与规则通道用）。
 * 推断不出返回 null —— 表示"低价值陈述"，入库但不注入。
 */
export function inferKind(text, type) {
  const t = String(text ?? '')
  if (!t) return null
  if (SCOPE_RE.test(t)) return 'scope'
  if (CAUSE_RE.test(t) && LESSON_RE.test(t)) return 'lesson'
  if (CAUSE_RE.test(t)) {
    // 含"不要/不能/禁止"的因果句是约束，不是普通理由
    if (type === 'constraint' || /(不要|不能|禁止|不得|不允许|只能|不引入)/.test(t)) return 'constraint'
    return 'rationale'
  }
  if (LESSON_RE.test(t) && /(信号|现象|表现为|提示|日志|报错信息)/.test(t)) return 'lesson'
  return null
}

/**
 * 从存量文本里拆出"理由"：迁移用。
 * 例："必须锁死 2.387.3，因为新版签名校验变了" → { text: "必须锁死 2.387.3", because: "新版签名校验变了" }
 * 拆不出返回 because=null（保持低价值陈述）。
 */
export function splitBecause(text) {
  const t = String(text ?? '').trim()
  const m = t.match(/^(.*?)[，,；;\s]*(?:因为|由于)\s*(.+)$/)
  if (m && m[1].trim().length >= 4 && m[2].trim().length >= 4) {
    return { text: m[1].trim(), because: m[2].trim() }
  }
  const n = t.match(/^(.*?)[，,；;\s]*否则\s*(.+)$/)
  if (n && n[1].trim().length >= 4 && n[2].trim().length >= 4) {
    return { text: n[1].trim(), because: `否则${n[2].trim()}` }
  }
  // 结果从句：把"导致/会冲掉/会覆盖/会失败"之后作为理由
  const r = t.match(/^(.*?)[，,；;\s]*(导致|会冲掉|会覆盖|会失败|会报错|会挂)\s*(.+)$/)
  if (r && r[1].trim().length >= 4 && r[3].trim().length >= 4) {
    return { text: r[1].trim(), because: `${r[2]}${r[3].trim()}` }
  }
  return { text: t, because: null }
}

/** 该条是否具备被注入的最低条件。 */
export function isInjectableKind(kind, fields = {}) {
  if (!KINDS.includes(kind)) return false
  const need = KIND_REQUIRED[kind] ?? []
  return need.every((f) => fields[f] != null && fields[f] !== '' && !(Array.isArray(fields[f]) && fields[f].length === 0))
}

/** 简报小节顺序与人类可读标签（设计文档 §5.1）。 */
export const KIND_LABELS = {
  position: '位置',
  scope: '范围',
  rationale: '相关理由',
  lesson: '相关教训',
  constraint: '约束',
  environment: '外部状态',
}
