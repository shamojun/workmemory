/**
 * 多任务隔离验收（离线）。
 *
 *   node scripts/acceptance-multitask.mjs
 *
 * 模拟"两个任务交替推进"：Jenkins 排查 与 MongoDB 迁移。
 * 验证四件事：
 *   1. 任务识别能切过去（不会永远粘在 active 上）；
 *   2. 检索不会跨任务串扰（当前任务的条目排在前面）；
 *   3. 简报只带当前任务 + 少量全局背景；
 *   4. 任务状态机（done / paused / abandoned）可用。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EntitiesStore } from '../packages/workmemory/lib/entities.js'
import { detectTask, belongsToTask, taskAffinity } from '../packages/workmemory/lib/continuity.js'
import { search } from '../packages/workmemory/lib/retrieval.js'
import { buildBrief } from '../packages/workmemory/lib/brief.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-mt-'))
const dir = path.join(root, '.dsh', 'memory')
fs.mkdirSync(dir, { recursive: true })

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`)
}

const es = new EntitiesStore({ dir, logger: { warn() {} } })
const now = Date.now()

// 任务 A：Jenkins
const ta = es.createTask({ title: '排查 Jenkins 构建失败', objective: '恢复流水线', keywords: ['jenkins', 'maven', 'pipeline'], sessionId: 's1' }, now - 3600_000)
es.updateTask(ta.id, { status: 'active' }, now - 600_000)
// 任务 B：MongoDB（暂停中，等待恢复）
const tb = es.createTask({ title: 'MongoDB 增量同步迁移', objective: '完成双写切换', keywords: ['mongodb', 'mongo', 'changesstreams'], sessionId: 's2' }, now - 86400_000)
es.updateTask(tb.id, { status: 'paused' }, now - 1200_000)

const tasks = es.list({ kind: 'task' })

// 1) 延续词 → 活跃任务
const r1 = detectTask({ tasks, text: '继续上次那个排查', now })
check('continue → active task', r1.task?.id === ta.id, r1.reason)

// 2) 明确提到另一个任务 → 必须切过去（旧版会粘住）
const r2 = detectTask({ tasks, text: 'mongodb 的 changestreams 方案怎么配', now })
check('mention other task → switch', r2.task?.id === tb.id, { got: r2.task?.title, reason: r2.reason })

// 3) 两个任务都提到时，取重合度更高的
const r3 = detectTask({ tasks, text: 'jenkins 流水线里 maven 构建失败', now })
check('stronger overlap wins', r3.task?.id === ta.id, { got: r3.task?.title, reason: r3.reason })

// 4) 都不沾边 → 沿用活跃任务（不新建）
const r4 = detectTask({ tasks, text: '顺便问下今天天气怎么样', now })
check('unrelated → keep active', r4.task?.id === ta.id, r4.reason)

// 5) 检索隔离：同文本、不同任务
const items = [
  { id: 'i1', type: 'gotcha', status: 'active', text: 'pipeline 构建报权限错误', taskId: ta.id, importance: 'high', updatedAt: now },
  { id: 'i2', type: 'gotcha', status: 'active', text: 'pipeline 构建报权限错误', taskId: tb.id, importance: 'high', updatedAt: now },
  { id: 'i3', type: 'constraint', status: 'active', text: '所有实现不依赖单独第三方服务', importance: 'critical', updatedAt: now },
]
const hitsA = search(items, 'pipeline 构建报权限错误', { task: ta, limit: 3 })
const hitsB = search(items, 'pipeline 构建报权限错误', { task: tb, limit: 3 })
check('search isolates task A', hitsA[0]?.item.id === 'i1', hitsA.map((h) => `${h.item.id}:${(h.score ?? 0).toFixed(2)}`))
check('search isolates task B', hitsB[0]?.item.id === 'i2', hitsB.map((h) => `${h.item.id}:${(h.score ?? 0).toFixed(2)}`))

// 6) 简报：只带当前任务 + 全局背景
const brief = buildBrief({
  ws: { root },
  digests: [{ id: 's1', sessionId: 's1', updatedAt: now, turns: 3, userText: '排查 pipeline', assistantText: '已定位 maven 版本' }],
  items,
  config: { brief: { enabled: true, maxChars: 3600, recentSessions: 5 } },
  task: ta,
})
check('brief has current task', brief.includes('排查 Jenkins'), brief.slice(0, 80))
check('brief keeps global constraint', brief.includes('不依赖'), brief)
check('brief excludes other task text', !brief.includes('MongoDB 增量同步'), brief)

// 7) 亲和度：跨任务被压低
check('affinity cross-task ≤0.1', taskAffinity({ taskId: tb.id, text: 'pipeline' }, ta, now) <= 0.1)

// 8) 状态机
es.updateTask(tb.id, { status: 'done' })
check('task done closed', es.get(tb.id).status === 'done' && es.get(tb.id).closedAt > 0)
check('done task not live', !['active', 'paused', 'blocked'].includes(es.get(tb.id).status))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
fs.rmSync(root, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
