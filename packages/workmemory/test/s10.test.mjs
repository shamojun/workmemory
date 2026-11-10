/**
 * 存储位置（设计文档 §5）：钥匙解析、目录选择、索引、重绑、导出。
 *   node packages/workmemory/test/s10.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  dshHome, storageBase, resolveWorkspaceKey, dataDirFor, pathHash,
  normalizeRoot, readIndex, upsertIndex, rebindByRoot, INDEX_VERSION,
} from '../lib/storage.js'
import { memoryDir, atomicWriteJson, ensureDir } from '../lib/store.js'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  if (!ok) console.error('FAIL', name, JSON.stringify(detail))
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-s10-home-'))
const wsA = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-s10-a-'))
const wsB = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-s10-b-'))
const sub = path.join(wsA, 'src', 'deep')
fs.mkdirSync(sub, { recursive: true })

/* 宿主登记表（只读来源） */
const registry = [
  { workspaceId: 'id-aaaa-1111', root: wsA, title: '工作区A' },
  { workspaceId: 'id-bbbb-2222', root: wsB, title: '工作区B' },
]

/* ── 钥匙解析 ── */
{
  const a = resolveWorkspaceKey(wsA, { registry })
  check('命中登记工作区', a.key === 'id-aaaa-1111' && a.registered === true, a)
  check('标题来自登记表', a.title === '工作区A', a.title)

  const s = resolveWorkspaceKey(sub, { registry })
  check('子目录归同一工作区', s.key === 'id-aaaa-1111' && s.root === normalizeRoot(wsA), s)

  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-s10-x-'))
  const x = resolveWorkspaceKey(other, { registry })
  check('未登记 → unreg 兜底', x.key.startsWith('unreg-') && x.registered === false, x)
  check('兜底 key 稳定', x.key === `unreg-${pathHash(other)}`, x.key)
  check('不同目录不同 key', resolveWorkspaceKey(other, { registry }).key !== a.key)

  const withTrailing = resolveWorkspaceKey(`${wsA}${path.sep}`, { registry })
  check('尾部分隔符不影响钥匙', withTrailing.key === a.key, withTrailing.key)
}

/* ── 目录选择 ── */
{
  const g = dataDirFor({ workspaceRoot: wsA, key: 'id-aaaa-1111', location: 'global', home })
  check('global → 用户目录', g === path.join(storageBase({}, home), 'id-aaaa-1111'), g)

  const w = dataDirFor({ workspaceRoot: wsA, key: 'id-aaaa-1111', location: 'workspace', home })
  check('workspace → 工作区内', w === path.join(normalizeRoot(wsA), '.dsh', 'memory'), w)

  const cfg = { storage: { location: 'global' }, __workspaceKey: 'id-aaaa-1111' }
  check('memoryDir 走 global', memoryDir(wsA, cfg).includes('-'.repeat(0)) && memoryDir(wsA, cfg).endsWith('id-aaaa-1111'), memoryDir(wsA, cfg))

  const cfgW = { storage: { location: 'workspace' }, __workspaceKey: 'id-aaaa-1111' }
  check('memoryDir 走 workspace', memoryDir(wsA, cfgW) === path.join(normalizeRoot(wsA), '.dsh', 'memory'), memoryDir(wsA, cfgW))
}

/* ── 索引与重绑 ── */
{
  const base = storageBase({}, home)
  const deps = { atomicWriteJson, ensureDir }

  upsertIndex(base, { key: 'id-aaaa-1111', root: wsA, title: '工作区A', registered: true }, deps)
  const idx = readIndex(base)
  check('索引写入', idx.version === INDEX_VERSION && !!idx.workspaces['id-aaaa-1111'], idx)
  check('索引记录 root', normalizeRoot(idx.workspaces['id-aaaa-1111'].root) === normalizeRoot(wsA), idx.workspaces['id-aaaa-1111'])

  // 旧 key 有数据 → 新 key 无数据 → 重绑
  ensureDir(path.join(base, 'id-old-9999'))
  fs.writeFileSync(path.join(base, 'id-old-9999', 'items.jsonl'), '{"id":"m1"}\n')
  upsertIndex(base, { key: 'id-old-9999', root: wsA, title: '工作区A', registered: true }, deps)

  const rb = rebindByRoot({ base, key: 'id-aaaa-1111', root: wsA, deps, liveKeys: new Set(['id-aaaa-1111', 'id-bbbb-2222']) })
  check('重绑成功', rb.rebound === true && rb.from === 'id-old-9999', rb)
  check('数据目录已改名', fs.existsSync(path.join(base, 'id-aaaa-1111', 'items.jsonl')), fs.readdirSync(base))
  check('旧索引项已移除', !readIndex(base).workspaces['id-old-9999'])

  // 再重绑一次：无旧项 → false（幂等）
  check('重绑幂等', rebindByRoot({ base, key: 'id-aaaa-1111', root: wsA, deps, liveKeys: new Set(['id-aaaa-1111', 'id-bbbb-2222']) }).rebound === false)

  // 路径不同则不重绑
  upsertIndex(base, { key: 'id-cccc-3333', root: wsB, title: '工作区B', registered: true }, deps)
  check('活 key 并存时不重绑', rebindByRoot({ base, key: 'id-dddd-4444', root: wsA, deps, liveKeys: new Set(['id-aaaa-1111', 'id-bbbb-2222']) }).rebound === false)
}

/* ── 目录隔离 ── */
{
  const base = storageBase({}, home)
  const dirA = path.join(base, 'id-aaaa-1111')
  const dirB = path.join(base, 'id-bbbb-2222')
  check('两工作区目录不同', normalizeRoot(dirA) !== normalizeRoot(dirB))
  check('索引可列出两个', Object.keys(readIndex(base).workspaces).length >= 2, Object.keys(readIndex(base).workspaces))
}

/* ── dshHome 解析 ── */
{
  check('DSH_HOME 优先', dshHome({ DSH_HOME: '/custom/home' }) === path.join('/custom/home').replace(/\\/g, path.sep) || dshHome({ DSH_HOME: '/custom/home' }).includes('custom'), dshHome({ DSH_HOME: '/custom/home' }))
  check('默认 ~/.dsh', dshHome({ USERPROFILE: home }).endsWith('.dsh'), dshHome({ USERPROFILE: home }))
}

const failed = results.filter((r) => !r.ok)
console.log(JSON.stringify({ total: results.length, failed: failed.length, failures: failed.map((f) => f.name) }, null, 2))
process.exit(failed.length ? 1 : 0)
