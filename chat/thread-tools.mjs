// chat/thread-tools.mjs — what an agent sees when it looks at the owner's other chats.
//
// threads__list and threads__read (totem_threads_* on /mcp) exist for the turn
// where the owner says "another thread is working on this" or "we sorted that
// out in the other chat", or where a reply plainly depends on work done in
// another chat. They are not a habit: the tool descriptions and THREADS_RULE
// tell the agent to leave other chats alone unless one of those is true.
//
// Pure functions over thread objects (chat/store.mjs), so the bridge supplies
// the live bits: which chats have a run going, the projects, keyword hits from
// the search index.

const DAY_MS = 86_400_000
const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const iso = (ms) => (ms ? new Date(ms).toISOString() : null)

/** The title the chat list shows: its own, or its first question. */
export function threadTitle(t) {
  if (t.title) return t.title
  const first = clip(t.messages?.find((m) => m.role === 'user')?.content, 49)
  return first || (t.kind === 'temporary' ? 'Temporary chat' : 'New chat')
}

/** "Work", or "Work / Hiring" for a folder; null for Home. */
export function projectPath(projectId, projects) {
  const p = projectId && projects.find((x) => x.id === projectId)
  if (!p) return null
  const parent = p.parentId && projects.find((x) => x.id === p.parentId)
  return parent ? `${parent.name} / ${p.name}` : p.name
}

/**
 * Where the chat sits in the owner's list: active, snoozed or settled. A mirror
 * of web/src/chat/settle.ts (auto-settle included), so the agent and the panel agree.
 */
export function shelfOf(t, { now = Date.now(), autoSettleDays = 3, running = false } = {}) {
  if (t.snoozedUntil && t.snoozedUntil > now) return 'snoozed'
  if (t.settledOverride === 'settled') return 'settled'
  if (t.settledOverride === 'active' || t.pinned || running || !autoSettleDays) return 'active'
  const at = Math.max(t.updatedAt || 0, t.unsettledAt || 0, t.snoozedUntil || 0)
  return now - at >= autoSettleDays * DAY_MS ? 'settled' : 'active'
}

const lastOf = (t, role) => [...(t.messages || [])].reverse().find((m) => m.role === role && (m.content || m.parts?.length))

/** One row of threads__list. */
export function threadSummary(t, { projects = [], running = false, now = Date.now(), autoSettleDays = 3, matches } = {}) {
  const request = lastOf(t, 'user')
  const reply = lastOf(t, 'assistant')
  const out = {
    id: t.id,
    title: threadTitle(t),
    project: projectPath(t.projectId, projects),
    projectId: t.projectId && projects.some((p) => p.id === t.projectId) ? t.projectId : null,
    updatedAt: iso(t.updatedAt),
    messages: (t.messages || []).length,
    running,
    waitingOnOwner: !!t.needsReply && !running,
    shelf: shelfOf(t, { now, autoSettleDays, running }),
    lastRequest: clip(request?.content, 240),
    lastReply: clip(reply?.content, 240),
  }
  if (t.totemId) out.totemId = t.totemId
  if (t.kind === 'temporary') out.temporary = true
  if (matches?.length) out.matches = matches
  return out
}

/**
 * threads__list. `hits` are keyword matches from the search index, grouped by
 * thread id (only passed with a query); with a query a chat must match, by hit
 * or by title, and chats with more hits come first. Otherwise newest first.
 */
export function listThreads(threads, args = {}, { projects = [], isRunning = () => false, hits = null, now = Date.now(), autoSettleDays = 3 } = {}) {
  const limit = Math.max(1, Math.min(Number(args.limit) || 15, 50))
  const known = new Set(projects.map((p) => p.id))
  // A project includes its folders unless a folder is asked for by id.
  const inProject = (t) => {
    if (!args.project) return true
    if (args.project === 'home') return !(t.projectId && known.has(t.projectId))
    if (t.projectId === args.project) return true
    return projects.some((p) => p.id === t.projectId && p.parentId === args.project)
  }
  const words = String(args.query || '').toLowerCase().split(/\s+/).filter(Boolean)
  const titleHit = (t) => words.length > 0 && words.every((w) => threadTitle(t).toLowerCase().includes(w))
  let rows = threads.filter((t) => t.id !== args.exclude && (t.messages || []).length && inProject(t))
  if (args.status === 'running') rows = rows.filter((t) => isRunning(t.id))
  if (args.status === 'waiting') rows = rows.filter((t) => t.needsReply && !isRunning(t.id))
  if (args.status === 'active') rows = rows.filter((t) => shelfOf(t, { now, autoSettleDays, running: isRunning(t.id) }) === 'active')
  if (words.length) rows = rows.filter((t) => hits?.has(t.id) || titleHit(t))
  const score = (t) => (hits?.get(t.id)?.length || 0) + (titleHit(t) ? 3 : 0)
  rows.sort((a, b) => (words.length ? score(b) - score(a) : 0) || (isRunning(b.id) - isRunning(a.id)) || (b.updatedAt || 0) - (a.updatedAt || 0))
  return {
    total: rows.length,
    threads: rows.slice(0, limit).map((t) => threadSummary(t, { projects, running: isRunning(t.id), now, autoSettleDays, matches: hits?.get(t.id)?.slice(0, 3) })),
  }
}

/** A tool row as one line: what the agent in that chat did. */
const toolLine = (p) => `${p.status === 'running' ? '… ' : ''}${p.title}${p.detail ? ` — ${clip(p.detail, 160)}` : ''}${p.status === 'error' ? ' (failed)' : ''}`

/**
 * threads__read: the chat's last `last` messages (or `last` from index `from`),
 * each clipped to `maxChars`. Tool rows come as one-liners on the message they
 * belong to, so "what is the other chat doing right now" is answerable.
 */
export function readThread(t, args = {}, { projects = [], running = false, now = Date.now(), autoSettleDays = 3 } = {}) {
  const all = (t.messages || []).filter((m) => m.role === 'user' || m.role === 'assistant')
  const last = Math.max(1, Math.min(Number(args.last) || 12, 60))
  const maxChars = Math.max(200, Math.min(Number(args.maxChars) || 3000, 20_000))
  const from = Number.isInteger(Number(args.from)) && args.from !== undefined && args.from !== null
    ? Math.max(0, Math.min(Number(args.from), all.length))
    : Math.max(0, all.length - last)
  const transcript = all.slice(from, from + last).map((m, i) => {
    const out = { index: from + i, role: m.role, at: iso(m.createdAt), content: clip(m.content, maxChars) }
    if (m.role === 'assistant' && m.status && m.status !== 'done') out.status = m.status
    const tools = (m.parts || []).filter((p) => p.type === 'tool').map(toolLine)
    if (tools.length && args.tools !== false) out.tools = tools.slice(-25)
    if (m.attachments?.length) out.attachments = m.attachments.map((a) => a.name)
    return out
  })
  return { ...threadSummary(t, { projects, running, now, autoSettleDays }), from, transcript }
}

/**
 * The line every chat turn gets (with the gateway on): this chat's id, and when
 * to look at other chats, which is rarely.
 */
export function threadsRule(thread, projects = []) {
  const where = projectPath(thread.projectId, projects)
  return `OTHER CHATS: this chat's id is ${thread.id}${where ? `, in the owner's project "${where}" (project id ${thread.projectId})` : ''}. `
    + 'threads__list and threads__read can look at the owner\'s other chats. Use them only when the owner points at another chat '
    + '("the other thread", "another agent is working on this", "what we figured out earlier"), or when you cannot do this turn '
    + 'well without context that clearly lives in another chat. Never look by habit, to be thorough, or at the start of a turn. '
    + 'When you do, narrow it (this project, a query, exclude this chat), read only what you need, and tell the owner which chat you drew on.'
}
