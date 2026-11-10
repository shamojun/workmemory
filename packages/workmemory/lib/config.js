/**
 * 配置：不依赖 schemastery，手工校验 + 默认值。
 * 这样插件在 profile 内外都能加载（阶段 A 无任何 @deepseek-ai 依赖）。
 */

export const DEFAULTS = {
  storage: {
    dir: '.dsh/memory',        // 相对工作区根
    autoBackup: true,
  },
  workspace: {
    root: '',                  // 显式工作区根；空 = 自动解析
    identityMode: 'auto',      // auto | git | dir-id | explicit
    // 注：v3.0 曾有 isolateWorktrees，但从未实现；Worktree 目前**不共享存储**，
    // 每个实际目录各自一份 .dsh/memory（v3.1 修订方案 P0-4）。
  },
  ingest: {
    historyDays: 30,
    maxSessions: 100,          // 每次"发现"会话的批大小，不是总量上限（S3 改名语义）
    maxEventsPerSession: 5000, // 单会话单次蒸馏的窗口大小，不是历史总量上限（S3）
    excludeSubAgents: true,
  },
  // 回填契约（S3）：预算与边界显式化，全部可配
  backfill: {
    enabled: true,
    priorityWindowDays: 30,    // 优先窗口：窗口内先处理，窗口外排队继续
    discoveryBatchSize: 100,   // 每次扫描会话数
    totalSessionLimit: null,   // null = 不设总量上限
    maxEventsPerPage: 5000,    // 单页事件数（分页读取单位）
    maxSessionsPerRun: 3,      // 每轮最多几个会话
    maxTotalChunksPerRun: 4,   // 每轮最多几段（跨会话累计）
    maxRetries: 3,             // 临时失败重试上限
    retryBackoffMs: 60000,     // 退避基数（第 n 次 = n × base）
  },
  privacy: {
    storeRaw: false,
    storeQuotes: true,
    quoteMaxChars: 200,
  },
  brief: {
    enabled: true,
    maxChars: 20000,           // ≈6K token：质量优先，token 不是瓶颈
    recentSessions: 5,
    showUnverified: true,      // 未确认的助手推断：标注"待验证"后注入（false 则完全不显示）
    unverifiedMax: 10,         // 待验证线索上限（覆盖优先，标注即可）
    limits: {                  // 各小节的质量优先上限（条数 + 字符预算）
      constraint: 10, decision: 10, open: 5, preference: 5,
      stateMax: 5, gotchaMax: 12, gotchaChars: 2000, stateChars: 900, textMax: 180,
    },
    collapse: true,            // S6a 读时折叠：同一件事的多种说法只占一行
  },
  // 任务状态衰减（S4a）：长期无活动的 active 任务自动 paused，避免僵尸任务常驻简报
  task: {
    idleDaysToPaused: 14,
  },
  rules: {
    enabled: true,
    maxItemsPerSession: 30,    // 防爆护栏，不是目标值
  },
  distill: {
    enabled: true,
    debounceMs: 3000,          // turn/end 后等一会儿再蒸馏
    maxEvents: 160,            // 每次喂给模型的最近消息数（也是队列分段大小）
    maxCandidates: 10,         // 每轮最多入库候选
    autoBackfill: true,        // 启动时跑一轮历史队列
    queueMaxSessionsPerRun: 3, // 每轮处理会话数（预算，不是总量上限）
    queueMaxChunksPerRun: 4,   // 每轮最多蒸馏段数（预算）
    schemaV2: false,           // 扩展输出（taskUpdates）：默认关闭，稳定后再开
  },
  diagnostics: {
    fsProbe: true,
    verifyInjection: false,    // M0 遗留验证：pre-step 注入手写消息是否落盘
  },
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 浅层逐组深合并：未知键丢弃，类型不符回退默认值。 */
export function resolveConfig(input) {
  const out = {}
  const raw = isObject(input) ? input : {}
  for (const [group, defaults] of Object.entries(DEFAULTS)) {
    if (!isObject(defaults)) { out[group] = defaults; continue }
    const given = isObject(raw[group]) ? raw[group] : {}
    const merged = {}
    for (const [key, dv] of Object.entries(defaults)) {
      const v = given[key]
      const same = typeof v === typeof dv
      merged[key] = same ? v : dv
    }
    out[group] = merged
  }
  return out
}
