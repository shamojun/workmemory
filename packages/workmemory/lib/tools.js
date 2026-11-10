/**
 * 模型可见工具（C/D）。
 * 注意：这里的 import 只有在插件位于 profile 插件目录时才能解析（见 sync.mjs）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { search } from './retrieval.js'
import { listDigests } from './store.js'

const MAX_LIMIT = 20

function fmt(item) {
  const id = String(item.id ?? '').slice(-4)
  const ev = item.evidence?.[0]
  const where = ev ? `（${ev.sessionId?.slice(0, 12)}…#${ev.seq}）` : ''
  return `[M${id}] ${item.type}/${item.status} ${item.text}${where}`
}

/**
 * @param {(agent:any)=>{items:{list:Function}|undefined}} resolveStore
 */
export function makeRecallTool(resolveStore, getTask) {
  return defineTool({
    name: 'memory_recall',
    description: '检索 WorkMemory 的工作区长期记忆（历史决策、约束、未决、踩坑、偏好）。当用户提到"之前/上次/当初/为什么"或需要延续旧工作时调用。',
    parameters: {
      query: { type: 'string', required: true, description: '要检索的问题或关键词，用自然语言描述。' },
      limit: { type: 'integer', description: `返回条数，默认 6，最大 ${MAX_LIMIT}。` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                type: { type: 'string', required: true },
                status: { type: 'string', required: true },
                text: { type: 'string', required: true },
                day: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.results.length
          ? value.results.map((r) => `[${r.id}] ${r.type}/${r.status} ${r.text}`).join('\n')
          : '（没有匹配的记忆）',
      }],
    },
    execute: (args, exec) => {
      const entry = resolveStore(exec.agent)
      if (!entry) return { results: [] }
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number(args.limit) || 6))
      const hits = search(entry.items.list(), String(args.query ?? ''), { limit, task: getTask?.(entry) })
      return {
        results: hits.map(({ item }) => ({
          id: `M${String(item.id ?? '').slice(-4)}`,
          type: item.type,
          status: item.status,
          text: item.text,
          day: new Date(item.updatedAt ?? item.createdAt ?? Date.now()).toISOString().slice(0, 10),
        })),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Recall workspace memory', kind: 'other', rawInput: args.query }),
  })
}

/** 供命令/调试复用 */
export const __formatItem = fmt

/** 当前任务（v3.1）：让模型能"接上"而不是重新问一遍。 */
export function makeTaskTool(resolveStore, getTask) {
  return defineTool({
    name: 'memory_task',
    description: '读取当前工作区正在进行的任务：标题、状态、目标、进度、下一步、阻塞。用户问"我们做到哪了/下一步是什么"时调用。',
    parameters: {
      taskId: { type: 'string', description: '可选。指定任务 id；省略则返回当前任务。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          id: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string' },
          objective: { type: 'string' },
          progress: { type: 'array', items: { type: 'string' } },
          nextSteps: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: v.found
          ? [
            `任务：${v.title}（${v.status}）`,
            v.objective ? `目标：${v.objective}` : '',
            v.progress?.length ? `进度：\n${v.progress.map((p) => `- ${p}`).join('\n')}` : '',
            v.nextSteps?.length ? `下一步：\n${v.nextSteps.map((p) => `- ${p}`).join('\n')}` : '',
            v.blockers?.length ? `阻塞：\n${v.blockers.map((p) => `- ${p}`).join('\n')}` : '',
          ].filter(Boolean).join('\n')
          : '（当前没有任务）',
      }],
    },
    execute: (args, exec) => {
      const entry = resolveStore(exec.agent)
      if (!entry) return { found: false }
      const t = args?.taskId ? entry.entities?.get(String(args.taskId)) : getTask?.(entry)
      if (!t) return { found: false }
      return {
        found: true,
        id: t.id,
        title: t.title,
        status: t.status,
        objective: t.objective ?? '',
        progress: t.progress ?? [],
        nextSteps: t.nextSteps ?? [],
        blockers: t.blockers ?? [],
      }
    },
  })
}

/** 记忆库状态：给模型一个"我到底记住了什么"的自查入口。 */
export function makeStatusTool(resolveStore) {
  return defineTool({
    name: 'memory_status',
    description: '查看 WorkMemory 记忆库状态：条目数、按类型/状态分布、最近更新时间。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          active: { type: 'integer', required: true },
          pending: { type: 'integer', required: true },
          byType: { type: 'object', required: true, additionalProperties: true, properties: {} },
          lastUpdatedAt: { type: 'string' },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: `记忆库：共 ${v.total} 条（active ${v.active} / pending ${v.pending}）\n按类型：${Object.entries(v.byType).map(([k, n]) => `${k}:${n}`).join(' ')}`,
      }],
    },
    execute: (_args, exec) => {
      const entry = resolveStore(exec.agent)
      const items = entry?.items?.list() ?? []
      const byType = {}
      let active = 0
      let pending = 0
      let last = 0
      for (const i of items) {
        byType[i.type] = (byType[i.type] ?? 0) + 1
        if (i.status === 'active') active += 1
        if (i.status === 'pending') pending += 1
        last = Math.max(last, i.updatedAt ?? 0)
      }
      return {
        total: items.length,
        active,
        pending,
        byType,
        lastUpdatedAt: last ? new Date(last).toISOString() : '',
      }
    },
  })
}

/** 按天回看会话摘要（D）：不依赖 items，直接读 digest。 */
export function makeTimelineTool(resolveStore) {
  return defineTool({
    name: 'memory_timeline',
    description: '按天回看这个工作区最近的会话摘要（每次会话最后一句话/回复），用于回答"这几天做了什么"。',
    parameters: {
      days: { type: 'integer', description: '回看天数，默认 7，最大 30。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          days: { type: 'integer', required: true },
          sessions: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                day: { type: 'string', required: true },
                turns: { type: 'integer' },
                user: { type: 'string' },
                assistant: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: v.sessions.length
          ? v.sessions.map((s) => `- ${s.day}（${s.turns ?? 0} 轮）用户：${s.user || '—'} ／ 回复：${s.assistant || '—'}`).join('\n')
          : '（这段时间没有会话记录）',
      }],
    },
    execute: (args, exec) => {
      const entry = resolveStore(exec.agent)
      const days = Math.min(30, Math.max(1, Number(args.days) || 7))
      if (!entry) return { days, sessions: [] }
      const since = Date.now() - days * 864e5
      const sessions = listDigests(entry.ws.dir)
        .filter((d) => (d.updatedAt ?? d.createdAt ?? 0) >= since)
        .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))
        .map((d) => ({
          day: new Date(d.updatedAt ?? d.createdAt ?? Date.now()).toISOString().slice(0, 10),
          turns: d.turns ?? 0,
          user: String(d.userText ?? '').slice(0, 120),
          assistant: String(d.assistantText ?? '').slice(0, 160),
        }))
      return { days, sessions }
    },
  })
}
