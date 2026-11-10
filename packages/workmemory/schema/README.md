# schema 目录（v3.1.2.1-final）

这里是**字段级**约束（JSON Schema draft-07）。**跨字段不变式**写在 `lib/schema.js` 里，
因为 JSON Schema 表达这些规则会变得难读甚至写不出来。

## 分工

| 约束类型 | 位置 | 例子 |
|---|---|---|
| 字段类型 / 枚举 / 长度 | `*.schema.json` | `source ∈ {user, assistant}` |
| 字段间关系 | `lib/schema.js` | `taskId` 必须是 `taskAssignment.taskId` 的镜像 |
| 互斥关系 | `lib/schema.js` | `decision` 对象 ⇔ `assertionMode=decision` |
| 保留值拒绝 | `lib/schema.js` | `tool` / `tool_verified` 在 v3.1.3 前不可写 |
| 派生字段 | `lib/schema.js` | `importanceScore`、`usagePolicy` 不入库 |

## 冻结决议对应关系

| 决议 | 落点 |
|---|---|
| C1 importance 枚举 | `item.schema.json` 的 `importance` + `deriveImportanceScore()` |
| C2 revision 命名 | `item/task/queue` 的 `revision`，代码读 `revision ?? rev` |
| C3 taskId 镜像 | `validateItem` 的归属不变式 |
| C4 decision 互斥 | `validateItem` 的 decision 区块 |
| C5 TaskEvent 派生 | 不建 schema 文件；`statusReason` 支撑派生 |
| C6 reserved 值 | `validateItem` 直接拒绝 `tool` / `tool_verified` |
| C7 task.json 派生 | 本目录不出现 task.json 的 schema（它不是事实来源） |
| M1 时间语义 | `observedAt <= recordedAt` |
| M2 合并取强 | `mergePrecedence()` |
| M3 provenance | `provenance` 字段 + `deriveUsagePolicy()` |
| M4 compact 口径 | revision 只是计数器；历史依赖 archive 快照 |

## 校验入口

```js
import { validateItem, validateTask, validateQueueItem } from '../lib/schema.js'

const r = validateItem(item)
if (!r.ok) { /* 拒绝写入，logger.warn(r.errors) */ }
```

## 尚未接入运行时

v3.1.2.1 只交付**校验器与契约**；把校验接到 `ItemsStore.append` / `EntitiesStore.put` /
队列 `markChunk` 属于 v3.1.2 的 S1 实施项（见修订设计 §12）。
在接入之前，运行时行为与 v3.1.1 一致。
