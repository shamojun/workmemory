/**
 * 任务连续性离线评测（v3.1.1 P1-4）。
 *
 *   node scripts/continuity-eval.mjs
 *
 * 用固定场景序列模拟"多任务交替推进"，逐步断言 detectTask 选中哪个任务。
 * 每步之后按真实行为更新状态（选中者 active，其余 in-progress → paused），
 * 因此能覆盖"切换后还能切回来"这类真正容易错的路径。
 */
import { detectTask } from '../packages/workmemory/lib/continuity.js'

const now = Date.now()
const mkTask = (id, title, keywords, status = 'active', ageH = 1) => ({
  id, kind: 'task', title, keywords, status, updatedAt: now - ageH * 3600_000,
})

const scenarios = [
  {
    name: '单任务延续',
    tasks: [mkTask('t1', '排查 Jenkins 构建失败', ['jenkins', 'maven'])],
    steps: [
      ['继续上次那个排查', 't1'],
      ['maven 又报错了', 't1'],
      ['今天天气不错', 't1'],
    ],
  },
  {
    name: '双任务切换与切回',
    tasks: [
      mkTask('t1', '排查 Jenkins 构建失败', ['jenkins', 'maven']),
      mkTask('t2', 'MongoDB 增量同步迁移', ['mongodb', 'changestreams'], 'paused', 30),
    ],
    steps: [
      ['先看 jenkins 流水线', 't1'],
      ['mongodb 的 changestreams 怎么配', 't2'],
      ['再看 maven 构建', 't1'],
      ['继续 mongodb 那边', 't2'],
    ],
  },
  {
    name: 'todo 只在点名时激活',
    tasks: [
      mkTask('t1', '排查 Jenkins 构建失败', ['jenkins']),
      mkTask('t3', '补充断点续跑', ['断点续跑'], 'todo', 48),
    ],
    steps: [
      ['继续上次那个', 't1'],
      ['把断点续跑补上', 't3'],
    ],
  },
  {
    name: '无任务时可新建',
    tasks: [],
    steps: [
      ['帮我把验收脚本写出来', 'new'],
    ],
  },
  {
    name: '模糊消息不来回跳',
    tasks: [
      mkTask('t1', '排查 Jenkins 构建失败', ['jenkins']),
      mkTask('t2', 'MongoDB 增量同步迁移', ['mongodb'], 'paused', 5),
    ],
    steps: [
      ['jenkins 和 mongodb 都想看下', 't1'],
      ['嗯', 't1'],
    ],
  },
]

const rows = []
for (const sc of scenarios) {
  const tasks = sc.tasks.map((t) => ({ ...t }))
  for (const [text, expected] of sc.steps) {
    const r = detectTask({ tasks, text, now })
    const actual = r.task?.id ?? (r.create ? 'new' : 'none')
    // 模拟真实状态迁移：选中的任务变 active，其余非 todo 的 active → paused
    if (r.task) {
      for (const t of tasks) {
        if (t.id === r.task.id) t.status = 'active'
        else if (t.status === 'active') t.status = 'paused'
      }
      const hit = tasks.find((t) => t.id === r.task.id)
      if (hit) hit.updatedAt = now
    }
    rows.push({ scenario: sc.name, text, expected, actual, reason: r.reason, pass: actual === expected })
  }
}

const passed = rows.filter((r) => r.pass).length
const rate = Math.round((passed / rows.length) * 100)

for (const r of rows) {
  console.log(`${r.pass ? '✅' : '❌'} [${r.scenario}] ${r.text}\n   期望 ${r.expected} · 实际 ${r.actual}（${r.reason}）`)
}
console.log(`\n任务连续性：${passed}/${rows.length}（${rate}%）`)
process.exit(rate >= 95 ? 0 : 1)
