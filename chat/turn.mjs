// chat/turn.mjs — what one chat turn sends, and how its reply accumulates.

//
// Pure functions, so the rules are testable without spawning an agent:
//
//   planHistory      — resume the provider's own session, or replay the thread as
//                      text. A thread can change provider mid-way; whatever the
//                      resumed session did not see is replayed, never dropped.
//   renderTranscript — prior turns as plain text, newest-first under a budget.
//   attachmentBlock  — where each attached file is, plus pasted text inline.
//   applyEvent       — fold one stream event into the assistant message. The
//                      browser has a TypeScript twin (web/src/chat/reduce.ts);
//                      keep the two in step.

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

export function renderTranscript(messages, { budget = 16_000, heading = 'Conversation so far:' } = {}) {
  if (!Array.isArray(messages) || !messages.length) return ''
  const lines = []
  let left = budget
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const content = (m?.content || '').trim()
    if (!content && !m?.attachments?.length) continue
    // A reply that failed carries no useful text; saying so beats replaying an
    // apology the model will then try to continue.
    const body = m.role === 'assistant' && m.status === 'error' && !content ? '(that reply failed)' : content
    const line = `${m.role === 'user' ? OWNER_LABEL : 'Totem'}: ${body}${describeAttachments(m)}`
    if (left - line.length < 0) {
      if (!lines.length) lines.unshift(line.slice(0, left))
      break
    }
    left -= line.length
    lines.unshift(line)
  }
  return lines.length ? `${heading}\n${lines.join('\n\n')}\n\n` : ''
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
        ...(t.input ? { input: t.input } : {}),
      })
      break
    }
    case 'image':
      if (event.uploadId) msg.parts.push({ type: 'image', uploadId: event.uploadId, alt: event.alt || '' })
      break
    case 'file':
      if (event.file?.uploadId) msg.parts.push({ type: 'file', ...event.file })
      break
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
  }
  msg.status = status
  if (error) msg.error = error
  else delete msg.error
  if (startedAt) msg.durationMs = Math.max(0, now - startedAt)
  return msg
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
