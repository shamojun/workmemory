/**
 * 工作区解析：身份随目录走（.dsh/memory/workspace.json），路径只用于找到它。
 * 优先级：显式配置 > 向上查找既有身份 > Git 根 > 规范化 cwd。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ensureDir, hashIdentity, memoryDir, readIdentity, writeIdentity } from './store.js'
import { resolveWorkspaceKey } from './storage.js'

export function normalizeRoot(p) {
  let r
  try { r = fs.realpathSync.native(p) } catch { r = path.resolve(p) }
  return r.replace(/[\\/]+$/, '')
}

function findGitRoot(start) {
  let dir = start
  for (let i = 0; i < 40; i += 1) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** 从 cwd 向上找已存在的记忆库身份（子目录启动也能复用同一工作区）。 */
function findExistingRoot(start, config) {
  let dir = start
  for (let i = 0; i < 40; i += 1) {
    const candidate = path.join(memoryDir(dir, config), 'workspace.json')
    if (fs.existsSync(candidate)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export function resolveWorkspace(cwd, config) {
  if (!cwd) return undefined
  const start = normalizeRoot(cwd)
  const mode = config.workspace.identityMode

  let root
  if (config.workspace.root) {
    root = normalizeRoot(config.workspace.root)
  } else if (mode === 'explicit') {
    return undefined
  } else if (mode === 'dir-id') {
    root = start
  } else {
    root = findExistingRoot(start, config)
      ?? (mode === 'git' ? findGitRoot(start) : (findGitRoot(start) ?? start))
    if (!root) root = start
  }

  // 钥匙：宿主登记表 → workspaceId；未登记时由 resolveWorkspaceKey 兜底
  const resolved = resolveWorkspaceKey(root)
  // 命中登记时以登记根为准：子目录启动也落在同一份数据上
  const effectiveRoot = resolved.registered ? resolved.root : root
  const scoped = { ...config, __workspaceKey: resolved.key }
  const out = attachIdentity(effectiveRoot, scoped)
  return {
    ...out,
    key: resolved.key,
    title: resolved.title,
    registered: resolved.registered,
    identityRoot: resolved.root,
    config: scoped,
  }
}

export function attachIdentity(root, config) {
  const dir = memoryDir(root, config)
  const existing = readIdentity(dir)
  if (existing?.workspaceId) {
    return { root, dir, workspaceId: existing.workspaceId, identity: existing, temporary: false }
  }

  const identity = {
    workspaceId: `ws_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
    root,
    createdAt: Date.now(),
  }

  try {
    ensureDir(dir)
    writeIdentity(dir, identity)
    return { root, dir, workspaceId: identity.workspaceId, identity, temporary: false }
  } catch {
    // 只读挂载等情况：退化为路径哈希，并标记临时身份
    const fallback = { workspaceId: hashIdentity(root), root, createdAt: Date.now(), temporary: true }
    return { root, dir, workspaceId: fallback.workspaceId, identity: fallback, temporary: true }
  }
}
