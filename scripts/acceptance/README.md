# 30 天验收怎么跑

## 三个脚本

| 脚本 | 用途 | 频率 |
|---|---|---|
| `acceptance-30d.mjs run` | 健康度 + 召回，写历史 | 每天 |
| `acceptance-30d.mjs report` | 30 天汇总与结论 | 第 30 天或随时 |
| `acceptance-multitask.mjs` | 多任务隔离（离线，12 项断言） | 改动任务逻辑后 |
| `workspace-probe.mjs [目录]` | 目标目录的文件系统能力探针 | 换工作区/在线盘时 |

## 每天一次

```bash
node scripts/acceptance-30d.mjs run
```

- 只读 `.dsh/memory/`，不启动 DSH、不调模型、零成本；
- 结果追加到 `.dsh/memory/acceptance/history.jsonl`；
- 有硬失败时退出码为 1（方便挂到任务计划里告警）。

## 多任务隔离

```bash
node scripts/acceptance-multitask.mjs
```

验证"两个任务交替推进"不会串：任务切换、检索隔离、简报只带当前任务、跨任务亲和度被压低、状态机可用。

## 在线工作空间（网络盘 / 远程主机 / 同步盘）

```bash
node scripts/workspace-probe.mjs "<workspace-path>"
```

九项检查里**四项是致命的**：

| 致命项 | 不通过的后果 |
|---|---|
| `lock:exclusive-create` | 文件锁失效，多实例同时写 |
| `write:rename-overwrite` | 原子写失效，可能读到半截文件 |
| `jsonl:append` | 记忆库不可用 |
| `basic:read-write-cjk` | 中文内容/文件名不可用 |

降级项（不致命但要知情）：`fsync` 不支持 → 断电容错下降；`path:long-260` 不支持 → 深层目录会失败；
`perf:200-appends` 过慢 → 每轮写摘要会卡顿。

结论为 `unsafe` 时，建议把存储目录指到本地磁盘（配置 `storage.dir` 用绝对路径），
只把项目文件放在网络盘上。

## 第 30 天看结论

```bash
node scripts/acceptance-30d.mjs report
```

输出覆盖天数、召回走势、简报 token、pending 率、失败项统计，并判断是否达到门槛：

| 条件 | 门槛 |
|---|---|
| 覆盖天数 | ≥ 30 |
| 平均召回（库内已有主题） | ≥ 85% |
| 硬失败 | 0 |

## 自动跑（可选）

Windows 任务计划程序，每天 09:00：

```powershell
schtasks /Create /TN "WorkMemory 30d" /SC DAILY /ST 09:00 /TR "node C:\个人文档\startup\dsh\memoryplugin\scripts\acceptance-30d.mjs run"
```

Linux / macOS（crontab）：

```
0 9 * * * cd /path/to/memoryplugin && node scripts/acceptance-30d.mjs run
```

## 判定口径（重要）

**召回率只统计"库内已有主题"**：一个问题只有当记忆库里**至少命中 2 个关键词**时才计入分母。
原因：库里没有的东西搜不到，是采集问题，不是检索问题；混在一起算会把检索能力低估。

每次 run 的 JSON 里保留了 `questions[].known / keywordHits / top`，可以事后核对判定是否合理。

## 每轮检查什么

| 检查 | 类型 | 门槛 |
|---|---|---|
| `data:no-corrupt-lines` | 硬 | 0 条坏行 |
| `data:every-item-has-evidence` | 硬 | 缺失 0 |
| `evidence:quotes-well-formed` | 硬 | 引用长度 ≥4 |
| `data:duplicate-pairs` | 硬 | ≤2 对 |
| `recall:known-topics` | 硬 | ≥85% |
| `task:active-exists` | 软 | 有活跃任务 |
| `task:session-bound` | 软 | 至少 1 个会话 |
| `task:progress-recorded` | 软 | 至少 1 条进度 |
| `brief:token-budget` | 硬 | ≤1200 token |

软性项只告警，不判失败——它们依赖真实使用节奏（比如刚建任务时还没有进度）。

## 与 A/B 对照的关系

本脚本证明的是"记忆本身的健康度与召回能力"。

要证明"Agent 是否因此更强"，需要另开 A/B 对照：关/开插件跑同一组任务问题，
比较四类结果：

| 编号 | 问题类型 | 判定 |
|---|---|---|
| Q1 | "为什么当初这么定" | 答出理由（含 because 关键信息），不是只报值 |
| Q2 | "上次那个失败怎么修的" | 答出信号与修复方式 |
| Q3 | "这次包含 X 吗" | 说出范围排除项 |
| Q4 | "现在卡在哪" | 与 position 一致 |

这部分需要人工标注（判定是否答对），脚本不自动打分。

