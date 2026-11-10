# WorkMemory

> 面向 DeepSeek Harness 的**工作区长期记忆**插件：在同一个工作区连续工作多日时，
> 自动记住"文件里不会写"的知识——**为什么这样定、哪里会错**——并每轮注入上下文，
> 让回答质量不随时间衰减。

- 宿主：DeepSeek Harness 0.2.1-rc.2（Cordis 插件平台）
- 包名：`@shamojun/workmemory` ｜ Cordis 名：`workmemory`
- 依赖：**零第三方运行时依赖**（无数据库 / Redis / 向量库 / Embedding 服务）

---

## 设计要点

| 要点 | 说明 |
|---|---|
| **只记文件里没有的** | 取舍理由、失败教训、约束成因、范围边界、位置进度；路径/版本/端口等不主动注入 |
| **知识形态** | `rationale` · `lesson` · `constraint` · `scope` · `position` · `environment`，每类必须带 `because` / `signal` 等支撑字段 |
| **证据可核** | 每条记忆带 `sessionId + seq + quote`，引文逐字校验 |
| **授权由来源决定** | 工具输出 → `tool_verified`；用户原话 → `user_explicit`；助手推断 → 仅作背景 |
| **零交互** | 不要求用户建任务、点确认、执行命令；一切从自然对话与工作区产物中提取 |
| **失败不破坏** | 迁移/写入失败降级只读；单写者锁 + fencing 代次校验 |

---

## 安装

插件通过 Cordis 配置挂载。把本仓库的 `packages/workmemory` 复制到 DSH 的 profile 目录，并在 `cordis.patch.yml` 中注册：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- insert:
    - id: workmemory
      name: '<绝对路径>/plugins/workmemory/lib/index.js'
      config:
        storage: { dir: '.dsh/memory' }
        brief: { enabled: true }
```

> 必须复制到 profile 目录，而不是直接引用仓库路径——否则 `@deepseek-ai/*` 依赖无法解析。

安装后**需完全退出并重启应用**，插件不支持热更新。

---

## 数据位置

```
<workspace>/.dsh/memory/
├── items.jsonl          事实（含证据、可信度、知识形态）
├── entities.jsonl       任务/项目/目标
├── manifest.json        版本、游标、任务绑定
├── digest/              会话摘要
├── queue/backfill.json  历史回填队列
├── archive/ backup/     归档与备份
└── lock                 单写者锁
```

---

## 命令与工具

| 类型 | 内容 |
|---|---|
| 命令（`/memory …`） | `brief` `items` `review` `confirm` `reject` `task` `stats` `compact` `verify` `backup` `backfill` `queue` `distill-backfill` `rebuild-items` |
| 工具（模型可调） | `memory_recall` `memory_status` `memory_timeline` `memory_task` |

命令是**诊断入口**，不是使用前提——日常使用不需要执行任何命令。

---

## 开发

```bash
# 同步到 profile（改完源码后执行）
node packages/workmemory/sync.mjs

# 测试（零依赖，直接跑）
node packages/workmemory/test/offline.test.mjs
node packages/workmemory/test/schema.test.mjs
node packages/workmemory/test/s1c.test.mjs
# … s2 ~ s9 同理

# 质量与回放
node scripts/eval.mjs
node scripts/replay.mjs
```

改完代码必须重启应用才生效（DSH 不重载宿主插件）。

---

## 目录结构

```
packages/workmemory/
├── lib/            23 个模块（采集/蒸馏/存储/检索/注入/安全/迁移）
├── schema/         字段级 JSON Schema
├── test/           370 项用例（9 个套件）+ 迁移夹具
├── sync.mjs        同步到 profile
└── README.md       模块级说明
scripts/            评估、回放、验收、探针
```

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 单机 | 本地文件无原子 CAS，不支持跨主机共享写 |
| Worktree 不共享 | 每个实际目录各自一份 `.dsh/memory` |
| 检索为词法 | 无向量检索（与"零第三方依赖"冲突），同义改写可能召回为空 |
| 完成判定 | 只能由用户明确表达触发，未接入工具证据链 |
| 需重启 | 插件不支持热更新 |

---

## 许可

Apache License 2.0，见 [LICENSE](LICENSE)。

