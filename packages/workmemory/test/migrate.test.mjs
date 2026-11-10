/**
 * v1 → v2 自动迁移用例。
 *   node packages/workmemory/test/migrate.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrateWorkspace, needsMigration } from '../lib/migrate.js'
import { validateItem, validateTask, validateQueueItem, SCHEMA_VERSION } from '../lib/schema.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-migrate-'))
const dir = path.join(root, '.dsh', 'memory')
fs.mkdirSync(path.join(dir, 'queue'), { recursive: true })

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  if (!ok) console.error('FAIL', name, JSON.stringify(detail))
}

// 铺 v1 数据
fs.copyFileSync(path.join(here, 'fixtures', 'v1-item.jsonl'), path.join(dir, 'items.jsonl'))
const task = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'v1-task.json'), 'utf8'))
task.kind = 'task'
fs.writeFileSync(path.join(dir, 'entities.jsonl'), `${JSON.stringify(task)}\n`)
fs.copyFileSync(path.join(here, 'fixtures', 'v1-queue.json'), path.join(dir, 'queue', 'backfill.json'))
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, createdAt: 1, cursors: {}, stats: {} }))

check('needsMigration detects v1', needsMigration(dir) === true)

let r
try {
  r = migrateWorkspace(dir)
} catch (e) {
  check('migration runs', false, { error: e.message, details: e.details })
}
check('migration ran', r?.migrated === true, r)

// 迁移后校验
const items = fs.readFileSync(path.join(dir, 'items.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const errs = items.map((i) => validateItem(i)).filter((v) => !v.ok)
check('all items valid v2', errs.length === 0, errs.slice(0, 2))
check('item count preserved', items.length === 3, items.length)
check('no rev field left', items.every((i) => i.rev === undefined && Number.isInteger(i.revision)), items.map((i) => ({ rev: i.rev, revision: i.revision })))

// 关键决议：无确认记录 → user_derived / unconfirmed
const derived = items.find((i) => i.id === 'mem_v1_b')
check('unconfirmed stays unconfirmed', derived.confirmationStatus === 'unconfirmed' && derived.authority === 'user_derived', { a: derived.authority, c: derived.confirmationStatus })

// 归属：无支持 → unresolved
check('assignment unresolved', items.every((i) => i.taskAssignment.status !== 'resolved' ? i.taskId === null : true))

const taskV2 = JSON.parse(fs.readFileSync(path.join(dir, 'entities.jsonl'), 'utf8').trim().split('\n').pop())
check('task migrated to v2', taskV2.schemaVersion === SCHEMA_VERSION && Number.isInteger(taskV2.revision), { sv: taskV2.schemaVersion, rev: taskV2.revision })
check('task validates', validateTask(taskV2).ok, validateTask(taskV2).errors)

const queue = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'backfill.json'), 'utf8'))
check('queue sessions migrated', queue.sessions.length === 3, queue.sessions.length)
check('done → completed', queue.sessions.find((s) => s.sessionId === 'session_v1')?.state === 'completed')
check('failed → retry_wait', queue.sessions.find((s) => s.sessionId === 'session_v2')?.state === 'retry_wait')
check('queue items validate', queue.sessions.every((s) => validateQueueItem(s).ok), queue.sessions.map((s) => validateQueueItem(s).errors).filter(Boolean))

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
check('manifest schemaVersion bumped', manifest.schemaVersion === SCHEMA_VERSION, manifest.schemaVersion)
check('migration recorded', manifest.migration?.status === 'completed' && manifest.migration?.from === 1, manifest.migration)

// 幂等
check('no second migration', needsMigration(dir) === false)
check('second run is noop', migrateWorkspace(dir).migrated === false)

// 备份存在
const backups = fs.readdirSync(path.join(dir, 'backup')).filter((d) => d.includes('-pre-v2'))
check('backup created', backups.length === 1, backups)

fs.rmSync(root, { recursive: true, force: true })
const failed = results.filter((x) => !x.ok)
console.log(JSON.stringify({ total: results.length, failed: failed.length, failures: failed.map((f) => f.name) }, null, 2))
process.exit(failed.length ? 1 : 0)
