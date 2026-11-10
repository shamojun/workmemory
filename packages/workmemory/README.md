# @shamojun/workmemory（v3.1）

DSH 工作区隐式长期记忆插件：不是让用户管理记忆，而是让 Agent 具备跨会话延续工作的能力。

> **权威文档**：[`WorkMemory-v3.1-任务需求方案与实现.md`](../../WorkMemory-v3.1-任务需求方案与实现.md)
> （任务定义 / 需求 / 方案设计 / 实现，含实测数据与已知限制）
> 本 README 只做速查。

## 已实现

| 能力 | 说明 |
|---|---|
| 工作区解析 | `workspace.json` 身份随目录走；显式配置 > 向上查找既有身份 > Git 根 > 规范化 cwd |
| 历史回填 | `sessionQuery.filterSessions({kind:'cwd'})` + `readSession`（`listEvents` 没有 `data`，M0 实测） |
| 实时增量 | `session/event` 只取 `user/message`、`assistant/message`、`turn/end`；**只认 `source.kind==='user'`** |
| 幂等与游标 | 每 session 一个 cursor；先写 digest 再推 cursor；字段级合并防增量覆盖回填 |
| 摘要存储 | `.dsh/memory/digest/<sessionId>.json`，只存最后一句用户话与最后一段回复（截断），不落原文 |
| 基础简报 | 经 `systemPrompt.context` 注入，≤3600 字符，纯本地拼装 |
| 单写锁 | 租约 + 崩溃抢占；抢不到则只读降级 |
| 诊断 | `%TEMP%\workmemory-trace.jsonl` 轨迹 + `manifest.stats.fsProbe` |
| 命令 | `/workmemory status \| brief \| backfill` |

## 存储实现说明

存储层用 **`node:fs`**，不用 `ctx.fs`：实测 `ctx.fs.writeText` 在工作区内也返回 `FS_SANDBOX_DENIED`
（`ctx.fs` 面向模型工具，受会话沙箱约束；插件是宿主进程代码，不受该围栏限制）。
原子写自实现：tmp → fsync → rename。

## 阶段 B1（已实现，待实机复验）

| 能力 | 说明 |
|---|---|
| 记忆项模型 | `lib/model.js`：7 类（state/decision/open/gotcha/preference/constraint/timeline）、状态枚举、`itemHash`、主题词、`buildItem` 校验（**无 evidence 不入库**） |
| 规则抽取 | `lib/rules.js`：只从"明确表达"提取；**只认 `source.kind==='user'` 且只抽短消息**；拦截列表/标题/表格/冒号片段与粘贴文档 |
| 条目存储 | `lib/items.js`：`items.jsonl` 追加写，按 id last-write-wins，指纹去重合并证据，超 16MB 自动压实 |
| 独立 item 游标 | `manifest.itemCursors`，与 digest 游标分离——后装插件也能从历史提记忆 |
| 规则版本自愈 | `RULES_VERSION` 变化 → 启动时清空 `items.jsonl` 并按新规则重抽（digest 不受影响） |
| 简报 | 新增「约束 / 关键决策 / 未决 / 踩过的坑 / 偏好」分节，带 `[Mxxxx]` 引用；渲染前再过一道 `renderable()` 过滤 |
| 命令 | `/workmemory items [type]`、`/workmemory rebuild-items` |

## 阶段 B2（已实现，待实机验证）

| 能力 | 说明 |
|---|---|
| 证据逐字校验 | `lib/evidence.js`：`quote` 归一化后必须出现在对应 seq 的原文里（允许 60% 前缀匹配），否则整条候选丢弃 |
| LLM 蒸馏 | `lib/distiller.js`：`turn/end` 后防抖触发，喂最近 40 条消息，要求严格 JSON；解析失败/超时/无路由一律降级为空 |
| 授权边界 | LLM 产出一律 `status=pending`、`confidence=0.8`；只有用户显式表达的规则项才是 `active` |
| 路由复用 | 从 `request/context` 事件记录当前 `provider/model`，蒸馏用同一路由，避免猜模型 |
| 上限 | 每轮最多 6 条候选，单次蒸馏超时 60s |

> 实机验证点：`trace` 里出现 `distill:done`；`items.jsonl` 里出现 `status=pending` 且 `confidence=0.8` 的条目；
> 编造引用的条目应被 `dropped` 计数而不入库。

### B1 第一次实机暴露的问题（已修）

历史回填抽出 19 条，可用约 4 条。噪声来源与对策：

| 噪声 | 例子 | 对策 |
|---|---|---|
| 粘贴文档被整段当句子 | 用户粘贴的方案正文 | 消息 >400 字符 / 含 ``` / 含 markdown 列表或表格 → 整条跳过 |
| 列表与标题片段 | `- 不能违反哪些约束`、`## 下一步` | 句首 `- * > # 数字.` 或句尾 `：` → 丢弃 |
| 冒号引导语 | `方案采用：`、`下一步：` | 同上 |
| 助手陈述混入 | "建议改用 Redis" | B1 **不抽助手**，留给 B2 的 LLM 蒸馏（会进 `pending`） |
| 整条消息入库 | `@tldr…根据该文档方案…不依赖…` | 按 `，,、` 切子句，取命中关键词的**最短子句**（`RULES_VERSION 3`） |

### 实机踩坑：陈旧锁把插件锁成只读（致命）

**症状**：重启后 items 不更新、不回填、不蒸馏，trace 只有 `ensure:lock readOnly:true`。

**原因**：上一进程崩溃留下的 `lock` 文件租约 10 分钟；旧逻辑只在"租约过期"时抢占，不判断持有进程是否还活着。

**修复**：
- 同机上 `pid` 不存在 → 立即抢占（`EPERM` 视为存活，避免误抢）；
- 租约 10 分钟 → **2 分钟**；
- 只读时 trace 输出 `holderPid / holderLease`。

**教训**：任何"进程已死但资源未释放"的场景都不能只靠超时，必须先探活。

## 阶段 D（已实现，待实机复验）

| 能力 | 说明 |
|---|---|
| `entity/property` supersede | 蒸馏输出 `entity/property/value`；同实体同属性不同取值 → 旧项 `superseded`，新项记 `supersedes`；不同属性不冲突 |
| 空响应静默 | 模型返回空文本 → `distill:empty`，不重试、不刷 trace |
| 低风险自动生效 | `state/gotcha/timeline` 由 LLM 产出即 `active`；`decision/constraint/preference/open` 仍进 `pending` |
| `memory_timeline` 工具 | 按天回看 digest（天数、轮数、最后用户话/回复） |
| `/workmemory stats` | 条目状态分布、类型分布、digest 数、rulesVersion、route、上次回填时间 |
| `/workmemory verify` | 行数 / 损坏行 / 重复 id / 无证据条目 / cursor 数 |
| `/workmemory backup` | 把 `items.jsonl`、`manifest.json`、`workspace.json` 复制到 `backup/<ts>/` |
| `/workmemory compact [days]` | 过期且 `invalid/superseded` 的条目移入 `archive/<YYYY-MM>.jsonl` 并压实 `items.jsonl`；**active/pending 永不自动淘汰** |
| `/workmemory distill-backfill [n]` | 对最近 n 个历史会话分段蒸馏（每段 40 条、每会话 2 段），补捞助手说过的技术结论 |
| 采集口径 | 蒸馏**同时接受 user / assistant 消息**；助手结论标 `authority=assistant`，低风险类型直接 active |
| 自动历史蒸馏 | 每个工作区首次启动、回填完成后自动跑一次（默认 1 会话 × 1 段 = 1 次调用），完成写 `manifest.distillBackfill` |
| 评测脚本 | `scripts/eval.mjs`：状态/类型分布、证据覆盖率、pending 率、近似重复对数 |
| 回放脚本 | `scripts/replay.mjs`：6 个历史问题测 `recall@5`，区分"库内已有主题"与"未入库主题" |

## 阶段 v3.1（进行中）

定位从"记忆管理工具"转向"Agent 隐式记忆能力"，补上 **Task 一等对象**。

| 能力 | 说明 |
|---|---|
| 实体层 | `lib/entities.js`：`entities.jsonl`，project/goal/task/constraint；Task 有状态机（active/paused/blocked/done/abandoned） |
| 任务连续性 | `lib/continuity.js`：**规则优先**（延续词 / 关键词重合 / 72h 窗口）→ 不确定时才用 LLM 兜底（10 分钟最多 1 次） |
| 显式进度 | 只对"已完成/卡住/下一步"这类句子改任务内容，**不做逐轮 LLM 更新** |
| 快照 | 每轮 `turn/end` 写本地 `task.json`（零 token），重启后据此恢复 |
| 任务态注入 | 简报首节变「当前任务：标题（状态）/目标/进度/下一步/阻塞」，事实层只保留与本任务相关的条目 |
| 命令 | `/workmemory task`、`task new <标题>`、`task done|pause|abandon` |
| 数据安全 | 证据严格子串匹配、规则重建只重抽 `origin=rule`、JSONL 尾行修复 |
| 召回 | 打分加入**任务亲和度**（同任务 1.0 / 关键词重合 0.4+ / 他任务 ≤0.1）；`memory_recall` 自动带上当前任务 |
| 无内容不注入 | 无任务且无相关事实时返回**空简报**，不再塞"最近会话"占位 |
| 接口 | `/memory` 与 `/workmemory` 同义；新增 `memory_task` 工具（共 4 个） |
| 召回修正 | 类型提示查询（"什么约束"）不再漏召回；任务态过滤过狠时自动补全局背景（最多 3 条约束/决策/偏好） |
| 30 天验收 | `scripts/acceptance-30d.mjs run|report`，每日跑一次，写 `acceptance/history.jsonl` |
| **历史回填队列** | `lib/backfill.js`：发现全部会话 → 排队 → 每轮按预算推进（默认 3 会话 × 4 段），游标持久化、断点续跑；`/memory queue [run\|retry]` |
| **任务会话指针** | Task 新增 `activeSessionId` / `lastSessionId` / `lastActivityAt` / `nextAction`；新增 `todo` 状态（只在被点名时激活） |
| **任务归属** | 蒸馏输出 `items[].taskId`（只认候选列表里的 id），事实可精确归属任务 |
| **快照分文件** | `snapshots/<taskId>.json` + 指针；内容哈希不变不写盘 |
| **锁 fencing** | 每次抢锁 `lockEpoch+1`，写前校验代次，过期进程无法继续写 |
| **连续性评测** | `scripts/continuity-eval.mjs`：12 步场景，当前 12/12 |
| **动态召回** | 用户问"之前/上次/当初"时自动检索 top-3 注入「相关历史」，其余轮次不注入 |
| **临时决策** | `decisionScope`/`overrideUntil`；临时决策不取代长期决策，过期自动 `stale` |

用例：**138 项**。


## 历史阶段（C）

| 能力 | 说明 |
|---|---|
| 检索内核 | `lib/retrieval.js`：中文二元组 + 英文词、BM25 近似打分（含类型/重要度/时间衰减），排除 `superseded/invalid` |
| `memory_recall` 工具 | `lib/tools.js`：`defineTool` 注册，返回带 `[Mxxxx]` 引用的结果；动态 import，确保 workspace 下加载不炸 |
| `memory_status` 工具 | 条目总数、active/pending、按类型分布 |
| 近似去重 | 包含度（共享词/较短文本）+ 共享词下限 6 + **否定守卫**；pending 与 active 撞车时并入 active |
| `/workmemory review` | 列出 pending；`confirm <id>` 升级为 `active/user_confirmed`，`reject <id>` 置 `invalid` |
| 插件打包 | 迁到 `~/.dsh/profiles/desktop/plugins/workmemory`，`sync.mjs` 同步 |

## 未实现（C+）

## 目录

```
lib/
├── index.js      # 装配：钩子、简报 provider、命令、fs 自检
├── config.js     # 手工校验 + 默认值（零依赖）
├── workspace.js  # 工作区解析与身份
├── store.js      # 原子写、锁、manifest、digest
├── ingest.js     # 回填 + 增量 + 字段级合并 + 双游标
├── model.js      # 记忆项模型与校验（B1）
├── rules.js      # 规则抽取（B1）
├── items.js      # 记忆项存储（B1）
├── trace.js      # %TEMP% 诊断轨迹
├── brief.js      # 简报渲染 + 状态文本
└── log.js        # 文件日志（≤2MB 轮转）
```

## 运行

```bash
node packages/workmemory/test/offline.test.mjs      # 50 项离线用例
node packages/workmemory/sync.mjs                   # 同步到 ~/.dsh/profiles/desktop/plugins/workmemory
node packages/workmemory/mount.mjs                  # 挂载 profile 副本
node packages/workmemory/mount.mjs --remove         # 卸载
```

**为什么要 sync**：插件现在会 `import { defineTool } from '@deepseek-ai/dsh-tools'`，
只有位于 `~/.dsh/profiles/` 之下才能解析这些包。工作区里保留源码，`sync.mjs` 复制到 profile 插件目录，
`mount.mjs` 挂载的是 profile 副本。

改源码后的固定流程：`sync.mjs` → 托盘退出应用 → 重开。

数据目录：`<workspace>/.dsh/memory/`

## 已知限制

- **改源码不会热更新**（Node ESM 按 URL 缓存）：改完需要重启 Desktop；
  改 `cordis.patch.yml` 才会触发热重组合。
- 阶段 A 的简报不含语义结论，只有"上次停在 X、最近几个会话"。
- 回填窗口默认 30 天 / 100 会话 / 每会话 5000 事件。
- 与压缩无关：简报每个组装周期都会参与请求，成本按 token × 步数计。
