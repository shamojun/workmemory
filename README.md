# WorkMemory

给 DeepSeek Harness 用的**工作区长期记忆**插件：在同一个工作区连着做几天活，
它替你记住"文件里不会写"的东西——为什么这么定、哪里会踩坑——每轮自动带上。

安装后**不需要任何操作**：不建任务、不点确认、不敲命令。

---

## 它记什么

只记文件里没有的：**取舍理由、失败教训、约束成因、范围边界、做到哪了**。

不记文件里已有的：路径、配置值、版本号、端口——这些模型读一眼就有。

## 安装

把 `packages/workmemory` 复制到 DSH 的 profile 目录，然后在 `cordis.patch.yml` 注册：

```yaml
- insert:
    - id: workmemory
      name: '<绝对路径>/plugins/workmemory/lib/index.js'
```

**装完要完全退出并重启 DSH**（插件不支持热更新）。

## 记忆存哪

默认存用户目录，**不碰你的项目**：

```
~/.dsh/storages/workmemory/<工作区 ID>/
```

一个工作区一份记忆：换会话、从子目录启动、甚至重命名工作区，都还是同一份。

想让记忆跟着项目目录走（比如放移动硬盘），加一行配置：

```yaml
config:
  storage: { location: workspace }   # 改存到 <项目>/.dsh/memory/
```

两种模式的区别：

| | 默认（用户目录） | 项目内 |
|---|---|---|
| 项目目录干净 | ✅ | ❌ 需要 gitignore |
| 移动项目目录后 | 新目录从零开始 | 记忆跟着走 |
| 换电脑 | 用导出命令带走 | 复制目录即可 |

切换不会搬迁数据，两份各自独立。

## 命令（可选）

日常不需要用；只在想确认或纠错时：

| 命令 | 作用 |
|---|---|
| `/memory brief` | 看它现在记住了什么 |
| `/memory review` | 看待确认的条目，可确认或否掉 |
| `/memory export` | 导出备份 |
| `/memory doctor` | 自检：条数、证据完整性、备份 |
| `/memory clear --yes` | 清空本工作区记忆（不可恢复） |

## 限制

单机使用（不支持多机共享同一份）· 按文字匹配检索（换种说法可能找不到）· 改代码后需重启 DSH。

## 开发

```bash
node packages/workmemory/sync.mjs               # 同步到 DSH profile
node packages/workmemory/test/offline.test.mjs  # 测试（12 套件 367 项）
```

设计与实现细节见 [需求与设计](docs/WorkMemory-需求与设计.md)。

## 许可

Apache-2.0，见 [LICENSE](LICENSE)。
