# WorkMemory

WorkMemory 是 DeepSeek Harness 的工作区长期记忆插件。在同一工作区持续多日工作时，
它记录**未写入文件的知识**——决策理由、失败教训、边界约束——并在后续会话中自动注入，
使回答质量不随使用时长衰减。

插件安装后无需任何额外操作：不创建任务、不确认条目、不执行命令。

- 宿主：DeepSeek Harness 0.2.1-rc.2（Cordis 插件平台）
- 包名：`@shamojun/workmemory` ｜ Cordis 名称：`workmemory`
- 运行时依赖：无（不使用数据库、缓存服务、向量库或 Embedding 服务）

---

## 记录范围

**记录**：取舍理由、失败教训、约束成因、外部状态、明确排除的范围、任务位置与进度。

**不记录**：路径、配置值、版本号、端口等可由文件或命令直接获得的信息。
判断标准是"读取文件或执行命令能否获得该信息"——能获得则不入库。

## 安装

将 `packages/workmemory` 复制至 DSH 的 profile 目录，并在 `cordis.patch.yml` 中注册：

```yaml
- insert:
    - id: workmemory
      name: '<绝对路径>/plugins/workmemory/lib/index.js'
```

插件必须置于 profile 目录内；直接引用仓库路径将导致 `@deepseek-ai/*` 依赖无法解析。

安装完成后需完全退出并重新启动 DSH。插件不支持热更新。

## 存储位置

默认存储于用户目录，不写入工作区：

```
~/.dsh/storages/workmemory/<workspaceId>/
```

`<workspaceId>` 取自宿主的工作区登记记录，因此**每个工作区对应一份记忆**：
该工作区下的所有会话与子目录共享同一份数据，重命名工作区不影响其内容。

如需将记忆随项目目录存放（例如便携存储介质），可修改配置：

```yaml
config:
  storage: { location: workspace }   # 数据写入 <workspace>/.dsh/memory/
```

| | `global`（默认） | `workspace` |
|---|---|---|
| 位置 | `~/.dsh/storages/workmemory/<id>/` | `<workspace>/.dsh/memory/` |
| 工作区目录 | 不产生额外文件 | 需加入版本控制忽略列表 |
| 移动项目目录 | 视为新工作区，从空库开始 | 记忆随目录迁移 |
| 迁移至其他设备 | 使用导出命令 | 复制目录 |

切换存储位置不会迁移既有数据；两种位置各自独立。

## 命令

命令为可选工具，用于查看与纠正，日常使用不需要执行。

| 命令 | 用途 |
|---|---|
| `/memory brief` | 输出当前简报 |
| `/memory review` | 查看待确认条目，并可确认或否决 |
| `/memory export` | 导出当前工作区的记忆 |
| `/memory doctor` | 自检：条目统计、证据完整性、备份 |
| `/memory clear --yes` | 清空当前工作区的记忆（不可恢复） |

## 已知限制

- 仅支持单机使用，不支持多台设备共享同一份数据。
- 检索基于词法匹配，同义改写可能导致检索为空。
- 修改插件代码后需重新启动 DSH 方可生效。

## 开发

```bash
node packages/workmemory/sync.mjs               # 同步至 DSH profile
node packages/workmemory/test/offline.test.mjs  # 测试（12 个套件，367 项用例）
```

设计与实现细节见 [需求与设计](docs/WorkMemory-需求与设计.md)。

## 许可

Apache License 2.0，详见 [LICENSE](LICENSE)。
