# 插件索引（DSH 插件市场格式 1）

本目录提供一个符合 DSH 插件市场索引格式的 JSON，供 DSH 的「发现」标签页读取。

## 使用

1. DSH 侧栏 → **插件** → **实验性插件** → 启用 **自定义插件索引**
2. 切到 **发现** → 添加索引 URL：

```
https://raw.githubusercontent.com/shamojun/workmemory/main/market/index.json
```

3. 在列表中找到 **WorkMemory** 并安装

## 说明

- DSH 当前**没有官方插件索引**；「发现」只列出用户自己添加的索引源。
- 安装来源是仓库的固定提交（`source.type = "git"`），不依赖 npm 账号。
- 元数据格式见 `@deepseek-ai/dsh-plugin-market-index`；`format` 必须为 `1`。

## 更新版本时

```bash
# 1. 改版本号并提交
# 2. 取新提交 SHA
git rev-parse HEAD

# 3. 更新本文件
#    versions[].version / publishTimestamp / source.commit
#    dist-tags.latest
```

`publishTimestamp` 为**秒**级 Unix 时间戳；`commit` 为 40 位小写 SHA。
