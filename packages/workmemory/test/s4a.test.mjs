/**
 * S4a：任务状态衰减（僵尸任务治理）。
 *   node packages/workmemory/test/s4a.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EntitiesStore } from '../lib/entities.js'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  if (!ok) console.error('FAIL', name, JSON.stringify(detail))
}

const DAY = 864e5
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-s4a-'))
const es = new EntitiesStore({ dir, logger: { warn() {} } })
const now = Date.now()

const idle = es.createTask({ title: '陈旧任务', sessionId: 's1' }, now - 20 * DAY)
const fresh = es.createTask({ title: '新任务', sessionId: 's2' }, now - 1 * DAY)
const paused = es.createTask({ title: '已暂停任务', sessionId: 's3' }, now - 40 * DAY)
es.updateTask(paused.id, { status: 'paused' }, now - 40 * DAY)

// 回填 lastActivityAt（createTask 用传入 now 作为 startedAt/updatedAt/lastActivityAt）
check('fixture idle is old', now - (idle.lastActivityAt ?? 0) >= 19 * DAY, { last: idle.lastActivityAt })

const n = es.decayTasks({ now, idleDays: 14 })
check('decays idle active task', n === 1, n)
check('idle becomes paused', es.get(idle.id)?.status === 'paused', es.get(idle.id)?.status)
check('reason recorded', es.get(idle.id)?.statusReason === 'inactive_14d', es.get(idle.id)?.statusReason)
check('fresh stays active', es.get(fresh.id)?.status === 'active', es.get(fresh.id)?.status)
check('paused untouched', es.get(paused.id)?.status === 'paused' && es.get(paused.id)?.statusReason === undefined)

// 幂等：再跑一次不再变更
check('decay idempotent', es.decayTasks({ now, idleDays: 14 }) === 0)

// 不刷新 lastActivityAt：衰减动作不能当成"活动"
check('lastActivityAt untouched', es.get(idle.id)?.lastActivityAt === idle.lastActivityAt, { before: idle.lastActivityAt, after: es.get(idle.id)?.lastActivityAt })

// 阈值可配：7 天
const t7 = es.createTask({ title: '十天没动', sessionId: 's4' }, now - 10 * DAY)
check('threshold configurable', es.decayTasks({ now, idleDays: 7 }) === 1 && es.get(t7.id)?.status === 'paused')

// 持久化：重载后仍是 paused
const reloaded = new EntitiesStore({ dir, logger: { warn() {} } })
check('decay persisted', reloaded.get(idle.id)?.status === 'paused', reloaded.get(idle.id)?.status)

fs.rmSync(dir, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(JSON.stringify({ total: results.length, failed: failed.length, failures: failed.map((f) => f.name) }, null, 2))
process.exit(failed.length ? 1 : 0)
