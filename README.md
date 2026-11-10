# WorkMemory

面向 DeepSeek Harness 的**工作区长期记忆**插件：在同一工作区连续工作多日时，
自动记住**文件里不会写**的知识——为什么这样定、哪里会错——并每轮注入上下文。

- 宿主：DeepSeek Harness 0.2.1-rc.2（Cordis）｜ 包名 `@shamojun/workmemory`
- 零第三方运行时依赖（无数据库 / Redis / 向量库 / Embedding）
- 文档：[需求与设计](docs/WorkMemory-需求与设计.md) ｜ 许可：Apache-2.0

---

## 要点

| | |
|---|---|
| 只记文件里没有的 | 取舍理由、失败教训、约束成因、范围边界、位置进度 |
| 知识形态 | `rationale` `lesson` `constraint` `scope` `position` `environment`，每类必须带支撑字段 |
| 证据可核 | 每条带 `sessionId + seq + quote`，引文逐字校验 |
| 零交互 | 不需要建任务、点确认、执行命令 |
| 不侵入 | 默认不写工作区，数据放用户目录 |

---

## 安装

把 `packages/workmemory` 复制到 DSH 的 profile 目录，并在 `cordis.patch.yml` 注册：

```yaml
- insert:
    - id: workmemory
      name: '<绝对路径>/plugins/workmemory/lib/index.js'
```

> 必须复制到 profile 目录，直接引用仓库路径会解析不到 `@deepseek-ai/*`。

**安装后需完全退出并重启应用**（插件不支持热更新）。

## 记忆存在哪

默认存用户目录，工作区零写入：

```
~/.dsh/storages/workmemory/<workspaceId>/
├── items.jsonl      事实（证据 / 可信度 / 知识形态）
├── entities.jsonl   任务
├── digest/          会话摘要
└── manifest.json    版本 / 游标
```

`<workspaceId>` 取自宿主工作区登记表（只读），因此**一个工作区一份记忆**：
不同会话、不同子目录共享同一份，重命名工作区也不影响。

想让记忆跟着项目目录走（便携盘等），改成：

```yaml
config:
  storage: { location: workspace }   # → <workspace>/.dsh/memory/
```

| | `global`（默认） | `workspace` |
|---|---|---|
| 位置 | `~/.dsh/storages/workmemory/<id>/` | `<workspace>/.dsh/memory/` |
| 工作区干净 | ✅ | ❌ 需 gitignore |
| 移动目录后 | 新空库 | 记忆跟着走 |
| 换机 | `memory export` 导出 | 复制目录 |

切换不搬迁数据，两个位置各自独立。

## 命令

| 类型 | 内容 |
|---|---|
| 用户命令 | `/memory brief` · `review [confirm\|reject <id>]` · `export` · `storage [path\|list\|gc]` · `doctor` · `clear --yes` |
| 模型工具 | `memory_recall` · `memory_status` · `memory_timeline` · `memory_task` |

命令只是诊断入口，**日常使用不需要执行任何命令**。
`clear --yes` 是唯一破坏性命令，会删除本工作区全部记忆。

## 开发

```bash
node packages/workmemory/sync.mjs               # 同步到 profile
node packages/workmemory/test/offline.test.mjs  # 测试（12 套件 367 项）
node scripts/eval.mjs                           # 质量指标
node scripts/export-memory.mjs <workspace>      # 导出记忆
```

改完代码需重启应用。

## 限制

单机（本地文件无原子 CAS）· Worktree 之间不共享存储 · 检索为词法（无向量）· 需重启生效。
