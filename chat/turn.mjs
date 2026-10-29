// chat/turn.mjs — what one chat turn sends, and how its reply accumulates.

//
// Pure functions, so the rules are testable without spawning an agent:
//
//   planHistory      — resume the provider's own session, or replay the thread as
//                      text. A thread can change provider mid-way; whatever the
//                      resumed session did not see is replayed, never dropped.
//   renderTranscript — prior turns as plain text, newest-first under a budget.
//   attachmentBlock  — where each attached file is, plus pasted text inline.
//   projectBlock     — a project chat's shared instructions, memory and files.
//   applyEvent       — fold one stream event into the assistant message. The
//                      browser has a TypeScript twin (web/src/chat/reduce.ts);
//                      keep the two in step.

import { foldAgent } from './subagents.mjs'

// How the owner's lines are labelled when a transcript is replayed to an agent.
const OWNER_LABEL = String(process.env.OWNER_NAME || '').trim() || 'Owner'

const TEXT_INLINE_LIMIT = 60_000

export function planHistory(thread, provider, userIndex) {
  const messages = thread?.messages || []
  const session = thread?.sessions?.[provider]
  if (session?.id && session.through <= userIndex) {
    return { resumeId: session.id, replay: messages.slice(session.through, userIndex) }
  }
  return { resumeId: null, replay: messages.slice(0, userIndex) }
}

function describeAttachments(m) {
  if (!m.attachments?.length) return ''
  return ` [attached: ${m.attachments.map((a) => a.name).join(', ')}]`
}

// A reply the owner steered reads in order: what Totem said, what the owner
// added mid-reply, what Totem said after. Null when there was no steer.
function steeredText(m) {
  if (m?.role !== 'assistant' || !m.parts?.some((p) => p.type === 'steer')) return null
  return m.parts.map((p) => (p.type === 'text' ? p.text : p.type === 'steer' ? `\n\n[${OWNER_LABEL}, mid-reply: ${[p.text, p.attachments?.length ? `(attached ${p.attachments.map((a) => a.name).join(', ')})` : ''].filter(Boolean).join(' ')}]\n\n` : '')).join('')
}

const TOOL_LINES_PER_REPLY = 12

// What a reply did, one line a step, for an agent taking the chat over: it did
// not run these itself, and files or state may have changed under it. Only the
// last few steps of a long reply, with how many came before.
function toolLines(m) {
  const tools = (m?.parts || []).filter((p) => p.type === 'tool')
  if (!tools.length) return ''
  const shown = tools.slice(-TOOL_LINES_PER_REPLY).map((p) => {
    const detail = p.detail ? ` — ${String(p.detail).replace(/\s+/g, ' ').slice(0, 200)}` : ''
    return `  - ${p.title || 'Tool call'}${detail}${p.status === 'error' ? ' (failed)' : ''}`
  })
  const more = tools.length > shown.length ? `  - (${tools.length - shown.length} earlier steps)\n` : ''
  return `\n[steps taken]\n${more}${shown.join('\n')}`
}

function transcriptLine(m, { tools }) {
  const content = (steeredText(m) ?? m?.content ?? '').trim()
  const steps = tools && m?.role === 'assistant' ? toolLines(m) : ''
  if (!content && !m?.attachments?.length && !steps) return ''
  // A reply that failed carries no useful text; saying so beats replaying an
  // apology the model will then try to continue.
  const body = m.role === 'assistant' && m.status === 'error' && !content ? '(that reply failed)' : content
  return `${m.role === 'user' ? OWNER_LABEL : 'Totem'}: ${body}${describeAttachments(m)}${steps}`
}

/**
 * Prior turns as plain text, newest first until `budget` characters are used.
 *
 * A handoff (the chat moving to another account, planHistory above) asks for
 * more, the way T3 Code hands a thread between providers: each reply's steps
 * (`tools`), the owner's first message kept however long ago it was
 * (`keepFirst`, it usually says what the chat is for), and `omitted(n)` to say
 * where the n messages that did not fit can be read.
 */
export function renderTranscript(messages, { budget = 16_000, heading = 'Conversation so far:', tools = false, keepFirst = false, omitted = null } = {}) {
  if (!Array.isArray(messages) || !messages.length) return ''
  const all = messages.map((m) => transcriptLine(m, { tools }))
  const firstUser = keepFirst ? messages.findIndex((m, i) => m?.role === 'user' && all[i]) : -1
  const first = firstUser >= 0 && all[firstUser].length <= budget / 4 ? firstUser : -1
  const kept = new Set()
  let left = budget - (first >= 0 ? all[first].length : 0)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!all[i] || i === first) continue
    if (left - all[i].length < 0) {
      if (!kept.size) { all[i] = all[i].slice(0, Math.max(0, left)); kept.add(i) }
      break
    }
    left -= all[i].length
    kept.add(i)
  }
  if (first >= 0) kept.add(first)
  if (!kept.size) return ''
  const order = [...kept].sort((a, b) => a - b)
  const lines = []
  order.forEach((i, k) => {
    // A gap between the first message and the newest ones is said, not hidden.
    if (k > 0 && all.slice(order[k - 1] + 1, i).some(Boolean)) lines.push('(…)')
    lines.push(all[i])
  })
  const leftOut = all.filter((l, i) => l && !kept.has(i)).length
  const note = leftOut && omitted ? `${omitted(leftOut)}\n\n` : ''
  return `${heading}\n${lines.join('\n\n')}\n\n${note}`
}

/**
 * `files` are attachments with `path` resolved and, for text ones, `text`
 * already read. Images are listed too even when the provider receives them
 * natively, so a model that wants to crop, OCR or forward one knows where it is.
 */
export function attachmentBlock(files) {
  if (!files?.length) return ''
  const lines = []
  const pasted = []
  let inlineLeft = TEXT_INLINE_LIMIT
  for (const f of files) {
    const kb = Math.max(1, Math.round((f.size || 0) / 1024))
    if (f.kind === 'text' && typeof f.text === 'string' && f.text.length <= inlineLeft) {
      inlineLeft -= f.text.length
      pasted.push(`--- ${f.name} (${kb} KB, also saved at ${f.path}) ---\n${f.text}\n--- end of ${f.name} ---`)
      continue
    }
    const what = f.kind === 'image' ? 'image' : f.mime
    lines.push(`- ${f.name} (${what}, ${kb} KB): ${f.path}`)
  }
  let out = ''
  if (lines.length) {
    out += 'ATTACHMENTS: The owner attached these files. They are saved on this machine; open them with your file tools when you need their contents.\n'
    out += `${lines.join('\n')}\n\n`
  }
  if (pasted.length) out += `PASTED / TEXT FILES:\n${pasted.join('\n\n')}\n\n`
  return out
}

const PROJECT_MEMORY_PROMPT_LIMIT = 12_000
const PROJECT_FILES_LISTED = 80

function fileLines(files) {
  const listed = files.filter((f) => f?.path).slice(-PROJECT_FILES_LISTED)
  if (!listed.length) return ''
  const lines = listed.map((f) => {
    const kb = Math.max(1, Math.round((f.size || 0) / 1024))
    const what = f.kind === 'image' ? 'image' : f.mime
    return `- ${f.name} (${what}, ${kb} KB${f.source === 'agent' ? ', made by you in an earlier chat' : ''}): ${f.path}`
  })
  const more = files.length > listed.length ? `\n(${files.length - listed.length} older files not listed.)` : ''
  return `${lines.join('\n')}${more}`
}

const clip = (mem) => (mem.length > PROJECT_MEMORY_PROMPT_LIMIT ? `${mem.slice(0, PROJECT_MEMORY_PROMPT_LIMIT)}\n…(truncated; the full file is at the path below)` : mem)

/**
 * What a chat in a project knows about the project: its instructions, its
 * memory (and where to keep it), and every shared file with its path. Sent on
 * every turn, resumed or not, because files and memory change between turns.
 * `files` carry `path` resolved; ones whose upload has gone are left out.
 *
 * A folder's chat (`parent` given) reads the parent project's instructions,
 * memory and files too, but keeps only the folder's memory: nothing it learns
 * reaches the parent unless the owner moves it there.
 */
export function projectBlock(project, { memory = '', memoryPath = '', files = [], parent = null } = {}) {
  if (!project) return ''
  const out = []
  if (parent?.project) {
    out.push(`PROJECT: This chat is in "${project.name}", a folder inside the owner's project "${parent.project.name}". The folder is a side topic: the other chats in it share its instructions, memory and files; the parent project's are shown for context and are read-only here.`)
    const pi = String(parent.project.instructions || '').trim()
    if (pi) out.push(`Instructions from the parent project "${parent.project.name}" (follow them in this chat):\n${pi}`)
    const pm = String(parent.memory || '').trim()
    if (pm) out.push(`Parent project memory (read-only; do not edit that file, and do not copy this folder's notes into it):\n${clip(pm)}`)
    const pf = fileLines(parent.files || [])
    if (pf) out.push(`Parent project files, saved on this machine. Open the ones that matter with your file tools:\n${pf}`)
  } else {
    out.push(`PROJECT: This chat is part of the owner's project "${project.name}". The other chats in it share these instructions, this memory and these files.`)
  }
  const scope = parent?.project ? 'Folder' : 'Project'
  const instructions = String(project.instructions || '').trim()
  if (instructions) out.push(`${scope} instructions from the owner (follow them in this chat):\n${instructions}`)
  const mem = String(memory || '').trim()
  out.push(
    `${scope} memory (${memoryPath}):\n${clip(mem) || '(empty so far)'}\n` +
    `Keep that file current with your file tools: when this chat settles a decision, learns a fact or preference the other chats in the ${scope.toLowerCase()} will need, or finishes something worth remembering, add a short dated bullet under a fitting heading, and correct anything that is no longer true. Keep it short; it is notes for the next chat, not a transcript. Do not tell the owner each time you update it.`,
  )
  const own = fileLines(files)
  if (own) out.push(`${scope} files, saved on this machine. Open the ones that matter to the request with your file tools; do not ask the owner to upload them again:\n${own}`)
  return `${out.join('\n\n')}\n\n`
}

// --- Reply accumulation ----------------------------------------------------

function lastPart(msg) {
  return msg.parts?.length ? msg.parts[msg.parts.length - 1] : null
}

/** Mutates `msg` (an assistant message) by one stream event. Returns msg. */
export function applyEvent(msg, event, now = Date.now()) {
  if (!msg.parts) msg.parts = []
  switch (event.type) {
    case 'delta': {
      if (!event.text) break
      const tail = lastPart(msg)
      if (tail?.type === 'text') tail.text += event.text
      else msg.parts.push({ type: 'text', text: event.text })
      msg.content = (msg.content || '') + event.text
      break
    }
    case 'tool': {
      const t = event.tool || {}
      const existing = t.id ? msg.parts.find((p) => p.type === 'tool' && p.id === t.id) : null
      if (t.phase === 'end') {
        const target = existing || [...msg.parts].reverse().find((p) => p.type === 'tool' && p.status === 'running')
        if (target) {
          target.status = t.status === 'error' ? 'error' : 'done'
          target.endedAt = now
          if (t.output) target.output = t.output
          if (t.detail && !target.detail) target.detail = t.detail
        }
        break
      }
      if (existing) break
      msg.parts.push({
        type: 'tool', id: t.id || `t${msg.parts.length}`, kind: t.kind || 'tool', title: t.title || 'Tool call',
        detail: t.detail || '', status: 'running', startedAt: now,
        ...(t.server ? { server: t.server } : {}), ...(t.tool ? { tool: t.tool } : {}),
        ...(t.app ? { app: t.app } : {}), ...(t.logo ? { logo: t.logo } : {}),
        ...(t.input ? { input: t.input } : {}),
      })
      break
    }
    case 'agent': {
      // Another agent this one started (chat/subagents.mjs), folded into the
      // card of the call that started it.
      const target = event.toolId ? msg.parts.find((p) => p.type === 'tool' && p.id === event.toolId) : null
      // An agent starts with its provider; anything else on a plain card is not one.
      if (target && (target.agent || event.agent?.provider)) target.agent = foldAgent(target.agent, event)
      break
    }
    case 'image':
      if (event.uploadId) msg.parts.push({ type: 'image', uploadId: event.uploadId, alt: event.alt || '' })
      break
    case 'file':
      if (event.file?.uploadId) msg.parts.push({ type: 'file', ...event.file })
      break
    case 'questions': {
      // Questions the agent asked (chat/questions.mjs): added where they were
      // asked, then updated in place when answered or dismissed.
      const q = event.questions || {}
      if (!q.id) break
      const existing = msg.parts.find((p) => p.type === 'questions' && p.id === q.id)
      if (existing) Object.assign(existing, q)
      else msg.parts.push({ type: 'questions', ...q })
      break
    }
    case 'steer': {
      // The owner's words mid-reply, kept where they landed among the steps.
      const st = event.steer || {}
      if ((!st.text && !st.attachments?.length) || msg.parts.some((p) => p.type === 'steer' && p.id === st.id)) break
      msg.parts.push({ type: 'steer', id: st.id || `s${msg.parts.length}`, text: st.text || '', via: st.via || 'live', createdAt: st.createdAt || now, ...(st.attachments?.length ? { attachments: st.attachments } : {}) })
      // What it says after the steer is a new paragraph in the copyable text too.
      if (msg.content) msg.content = msg.content.replace(/\s*$/, '\n\n')
      break
    }
    default:
      break
  }
  return msg
}

/** Close out a reply: settle any tool still marked running, record the outcome. */
export function finalizeMessage(msg, { status, error, finalText, startedAt, now = Date.now() }) {
  if (!msg.parts) msg.parts = []
  // A provider that never streamed (or streamed less than it settled on) still
  // has its final text recorded.
  const streamed = (msg.content || '').trim()
  const settled = (finalText || '').trim()
  if (settled && !streamed) applyEvent(msg, { type: 'delta', text: settled }, now)
  for (const p of msg.parts) {
    if (p.type === 'tool' && p.status === 'running') { p.status = status === 'error' ? 'error' : 'done'; p.endedAt = now }
    if (p.type === 'tool' && p.agent?.status === 'running') {
      p.agent = { ...p.agent, status: status === 'error' ? 'error' : status === 'stopped' ? 'stopped' : 'done', endedAt: now }
      for (const st of p.agent.steps || []) if (st.status === 'running') st.status = 'done'
    }
  }
  msg.status = status
  if (error) msg.error = error
  else delete msg.error
  if (startedAt) msg.durationMs = Math.max(0, now - startedAt)
  return msg
}

/**
 * Why a reply failed, in words for the owner. A provider's raw error can be a
 * JSON body ({"error":{"message":…}}); a 429 is its usage limit, said plainly,
 * with the provider's own words kept after it.
 */
export function failureText(raw, providerName = 'The agent') {
  let text = String(raw || '').trim()
  try {
    const body = JSON.parse(text)
    const inner = body?.error?.message || body?.message
    if (typeof inner === 'string' && inner.trim()) text = inner.trim()
  } catch { /* not JSON */ }
  if (!text) return ''
  if (/\b429\b|too many requests|usage limit|rate limit/i.test(text)) {
    return `${providerName} hit its usage limit, so the reply stopped here. (${text})`
  }
  return text
}

/** A short, human title from the first request, for when no AI title arrives. */
export function fallbackTitle(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  if (clean.length <= 48) return clean
  const cut = clean.slice(0, 48)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 32))}…`
}

/**
 * The answer itself, without the narration before it. Agents talk while they
 * work ("I'll look for Bushido's MCP, then…") and that text sits in the same
 * message as the reply, ahead of or between the tool steps. The answer is what
 * follows the last tool step; with no tools it is the whole text.
 */
export function finalAnswer(msg) {
  const parts = msg?.parts || []
  let lastTool = -1
  parts.forEach((p, i) => { if (p.type === 'tool') lastTool = i })
  const after = parts.slice(lastTool + 1).filter((p) => p.type === 'text').map((p) => p.text).join('').trim()
  return after || (lastTool < 0 ? String(msg?.content || '').trim() : '')
}
