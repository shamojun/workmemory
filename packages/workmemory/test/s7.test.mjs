/**
 * 位置信息修复（digest id + 任务头部诚实化）。
 *   node packages/workmemory/test/s7.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listDigests, writeDigest } from '../lib/store.js'
import { buildBrief } from '../lib/brief.js'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  if (!ok) console.error('FAIL', name, JSON.stringify(detail))
}

const now = Date.now()
const cfg = { brief: { enabled: true, maxChars: 3600, recentSessions: 5, showUnverified: true, collapse: true } }
const ws = { root: '/tmp/ws', dir: '/tmp/ws/.dsh/memory' }

/* ── digest id 回填 ── */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-s7-'))
  writeDigest(dir, { sessionId: 'sess-abc', createdAt: now, updatedAt: now, turns: 12, userText: '继续', assistantText: '好' })
  const list = listDigests(dir)
  check('digest gets id from sessionId', list[0]?.id === 'sess-abc', list[0])
  check('digest keeps sessionId', list[0]?.sessionId === 'sess-abc')
  fs.rmSync(dir, { recursive: true, force: true })
}

/* ── 绑定任务时"上次停在"能显示 ── */
{
  const digests = [{ id: 'sess-abc', sessionId: 'sess-abc', createdAt: now - 7200e3, updatedAt: now - 3600e3, turns: 12, userText: '继续做 S3', assistantText: '已完成' }]
  const task = { id: 'task_1', title: '做 S3', status: 'active', sessionIds: ['sess-abc'], lastActivityAt: now - 3600e3 }
  const brief = buildBrief({ ws, digests, items: [], config: cfg, now, task })
  check('brief shows last stop for bound session', brief.includes('上次停在'), brief)
  check('brief shows last user text', brief.includes('继续做 S3'), brief)
}

/* ── 任务头部显示最近活动 ── */
{
  const task = { id: 'task_2', title: '写脚本', status: 'active', lastActivityAt: now - 3 * 3600e3 }
  const brief = buildBrief({ ws, digests: [], items: [], config: cfg, now, task })
  check('header shows recent activity', /当前任务：写脚本（active · 最近活动 3 小时前）/.test(brief), brief.split('\n')[2])
}

/* ── 超过 3 天无活动：加过期提醒 ── */
{
  const task = { id: 'task_3', title: '旧任务', status: 'active', lastActivityAt: now - 5 * 864e5 }
  const brief = buildBrief({ ws, digests: [], items: [], config: cfg, now, task })
  check('stale task warns', brief.includes('超过 3 天没有活动'), brief)
  check('stale task shows days', brief.includes('最近活动 5 天前'), brief.split('\n')[2])
}

/* ── 新鲜任务不加过期提醒 ── */
{
  const task = { id: 'task_4', title: '新任务', status: 'active', lastActivityAt: now - 60e3 }
  const brief = buildBrief({ ws, digests: [], items: [], config: cfg, now, task })
  check('fresh task has no warning', !brief.includes('超过 3 天没有活动'), brief)
  check('fresh task shows minutes', brief.includes('最近活动 1 分钟前'), brief.split('\n')[2])
}

/* ── 最近改动指针 ── */
{
  const { pickToolPath, isMutatingTool } = await import('../lib/ingest.js')
  check('path from file_path', pickToolPath({ file_path: '/a/b.js' }) === '/a/b.js')
  check('path from path', pickToolPath({ path: 'lib/x.js' }) === 'lib/x.js')
  check('no path for command-only args', pickToolPath({ command: 'ls' }) === '')
  check('no path for null args', pickToolPath(null) === '')
  check('read is not a change', isMutatingTool('read') === false)
  check('edit is a change', isMutatingTool('edit') === true)
  check('apply_patch is a change', isMutatingTool('apply_patch') === true)

  const digests = [{
    id: 's1', sessionId: 's1', createdAt: now - 9e6, updatedAt: now - 600e3, turns: 20,
    userText: '继续', assistantText: '好',
    filesTouched: [
      { path: 'C:/ws/lib/brief.js', at: now - 600e3, tool: 'edit' },
      { path: 'C:/ws/lib/ingest.js', at: now - 900e3, tool: 'edit' },
      { path: 'C:/ws/lib/brief.js', at: now - 1200e3, tool: 'write' },
    ],
  }]
  const task = { id: 't', title: '做 S8', status: 'active', sessionIds: ['s1'], lastActivityAt: now - 600e3 }
  const brief = buildBrief({ ws, digests, items: [], config: cfg, now, task })
  check('brief shows recent files', brief.includes('最近改动：brief.js、ingest.js'), brief.split('\n').slice(0, 6).join('\n'))
  check('recent files deduped', (brief.match(/brief\.js/g) ?? []).length === 1, brief)
  check('recent files sorted by time', brief.indexOf('brief.js') < brief.indexOf('ingest.js'))
}

const failed = results.filter((r) => !r.ok)
console.log(JSON.stringify({ total: results.length, failed: failed.length, failures: failed.map((f) => f.name) }, null, 2))
process.exit(failed.length ? 1 : 0)
