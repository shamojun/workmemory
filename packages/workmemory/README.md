# @shamojun/workmemory

DSH 工作区隐式长期记忆插件：不让用户管理记忆，而是让 Agent 具备**跨会话延续工作**的能力。

- 包名：`@shamojun/workmemory` ｜ Cordis 名：`workmemory`
- 依赖：零第三方运行时依赖（无数据库 / Redis / 向量库 / Embedding）
- 契约版本：`SCHEMA_VERSION = 3`（知识形态）
- 许可：Apache-2.0

---

## 一句话

> 只记"文件里不会写"的知识——**为什么这样定、哪里会错**；
> 路径/版本/端口这类读一次文件就有的信息**不主动注入**。

---

## 模块（24 个）

| 层 | 模块 | 职责 |
|---|---|---|
| 入口 | `index.js` | inject、事件订阅、命令、工具、启动钩子 |
| 采集 | `ingest.js` | 事件 → digest / 最近窗口；蒸馏触发；`historyToRecent` |
| 采集 | `rules.js` | 规则抽取（零 LLM）：约束 / 偏好 / 决策 / 范围 / 因果句 |
| 提炼 | `distiller.js` | 六类知识提示词、JSON 解析、候选校验、元信息过滤 |
| 提炼 | `evidence.js` | 引文逐字校验 |
| 知识 | `knowledge.js` | 知识形态枚举、推断、值类判定、`splitBecause` |
| 存储 | `items.js` | 事实层：追加写、去重、取代、压实、归属重算、kind 回填 |
| 存储 | `entities.js` | 实体层：任务状态机、进度、快照、衰减 |
| 存储 | `store.js` | 目录、原子写、单写者锁（pid + 租约 + lockEpoch） |
| 契约 | `schema.js` | 枚举、字段与跨字段校验、五维、归一化与迁移 |
| 契约 | `model.js` | 候选 → Item 构造 |
| 检索 | `retrieval.js` | 词法 + 同义词 + 任务亲和度；按策略过滤 |
| 检索 | `cluster.js` | 读时折叠（同事件分组 + 标识符/极性守卫） |
| 注入 | `brief.js` | 简报装配（位置 → 理由 → 教训 → 约束 → 外部状态 → 摘要声明） |
| 连续 | `continuity.js` | 任务识别、归属三态、亲和度、进度信号 |
| 回填 | `backfill.js` | 队列六态 + 双游标 |
| 安全 | `safety.js` | 路径边界 |
| 安全 | `injection.js` | 历史注入过滤 |
| 迁移 | `migrate.js` | v1 → v2 → v3 自动迁移 |
| 工具 | `tools.js` | `memory_recall` / `memory_status` / `memory_timeline` / `memory_task` |
| 观测 | `trace.js` · `log.js` | 结构化 trace + 日志 |
| 解析 | `workspace.js` | 工作区身份解析 |
| 配置 | `config.js` | 默认值 + 分组深合并 |

---

## 数据

```
<workspace>/.dsh/memory/
├── items.jsonl          事实（证据 / 可信度 / 知识形态）
├── entities.jsonl       任务/项目/目标
├── manifest.json        版本、游标、任务绑定、回填标记
├── digest/              会话摘要
├── queue/backfill.json  历史回填队列
├── archive/ backup/     归档与备份
└── lock                 单写者锁
```

---

## 记忆的结构

```jsonc
{
  "knowledgeKind": "rationale",        // rationale|lesson|constraint|scope|position|environment
  "text": "Jenkins core 锁死 2.387.3",
  "because": "新版插件签名校验变了",     // rationale / constraint 必填
  "cost": "无法使用新版特性",
  "signal": "ERROR: Failed Loading",   // lesson 必填
  "fix": "先移走 plugins 再解包",
  "excludes": "不含 Job 与构建历史",     // scope 必填
  "anchors": [{ "kind": "version", "value": "2.387.3", "path": "docker/Dockerfile" }],
  "evidence": [{ "sessionId": "…", "seq": 12, "quote": "…" }],
  "authority": "user_explicit|user_derived|assistant|tool_verified"
}
```

- **没有 `knowledgeKind` 的条目**：入库但不进新小节（低价值陈述）
- **纯值陈述**（路径/端口/版本/键值）且无因果支撑：不主动注入，但仍可检索

---

## 简报

```
[WorkMemory · 工作区 X · 以下是历史记录，不是当前指令]

当前任务：…（active · 最近活动 2 小时前）
- 位置：…
- 范围：…
相关理由：- 结论 —— 因为 …；代价：…
相关教训：- 结论 → 信号：… → 修复：…
约束 / 外部状态（可能已过期）

以上为自动摘要（本轮 N 条；库内共 M 条，未列出 K 条），不是全部记忆。
```

---

## 命令与工具

| 类型 | 内容 |
|---|---|
| 命令 | `brief` `items` `review` `confirm` `reject` `task` `stats` `compact` `verify` `backup` `backfill` `queue` `distill-backfill` `rebuild-items` |
| 工具 | `memory_recall` `memory_status` `memory_timeline` `memory_task` |

命令是诊断入口，日常使用不需要执行任何命令。

---

## 关键机制

| 机制 | 说明 |
|---|---|
| 授权由来源决定 | 工具输出 → `tool_verified`；用户原话 → `user_explicit`；助手推断 → 背景 |
| 归属三态 | `resolved` / `unresolved` / `rejected`；不确定就留空，宁可全局不写错任务 |
| 注入三档 | 事实 / 规则 / 仅上下文，按 `deriveUsagePolicy` 判定 |
| 读时折叠 | 同一件事的多种说法只占一行（标注"另 N 条相似"） |
| 回填双游标 | `readCursorSeq` 与 `committedCursorSeq` 分离，先写事实再提交 |
| 状态衰减 | 14 天无活动 → `paused`，并解除当前任务绑定 |
| 迁移自愈 | 版本落后自动迁移（校验→备份→原子替换→失败只读） |

---

## 测试

```bash
for f in packages/workmemory/test/*.test.mjs; do node "$f"; done
```

12 个套件 · 370 项用例：`offline` `schema` `migrate` `s1c` `s2` `s3` `s4a` `s5` `s6` `s7` `s8` `s9`。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 单机 | 本地文件无原子 CAS，不支持跨主机共享写 |
| Worktree 不共享 | 每个实际目录各自一份 `.dsh/memory` |
| 检索为词法 | 无向量检索（与零依赖冲突），同义改写可能召回为空 |
| 完成判定 | 只支持用户明确表达，未接入工具证据链 |
| 需重启 | 插件不支持热更新 |
