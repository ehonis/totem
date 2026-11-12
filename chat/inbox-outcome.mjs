// chat/inbox-outcome.mjs — an inbox proposal answers the chat that asked (#160).
//
// A chat run that stages a proposal (an email, a message, a command, a prompt, an
// away span) writes its thread and run onto the inbox line (`thread: … | run: …`),
// and an `inbox` part joins that reply, where the chat shows the approval card.
// When the owner decides it in the dashboard (the Inbox tab or the card), the
// card is updated and the outcome goes back into the chat as his message, so the
// agent carries on knowing it: a new turn, or a follow-up to the reply running
// now (queued or steered, as Settings → Chat › Follow-up behaviour says). A
// denial with no note is recorded in the chat and starts nothing.
//
// Lines without `thread:` (every ingest, every older proposal) are left as they were.

const ID = /^[A-Za-z0-9_-]{1,128}$/
const INBOX_ID = /^[A-Za-z]+\d+$/

export const INBOX_CARD_STATUSES = ['pending', 'accepted', 'denied', 'draft', 'uncertain']
export const NOTE_MAX = 2000

/** The inbox-line segments that tie a proposal to the chat run that staged it; none outside a chat run. */
export function chatRefMeta(chat) {
  if (!chat || !ID.test(chat.threadId || '') || !ID.test(chat.runId || '')) return []
  return [`thread: ${chat.threadId}`, `run: ${chat.runId}`]
}

/** The chat a parsed inbox line came from, or null. */
export function chatRefOf(meta) {
  const threadId = meta?.thread
  if (!ID.test(threadId || '')) return null
  return { threadId, runId: ID.test(meta.run || '') ? meta.run : null }
}

export const cleanNote = (v) => (typeof v === 'string' ? v.trim().slice(0, NOTE_MAX) : '')

/** The stamp doResolveInboxItem writes ("confirmed 2026-11-04 → sent to …"), without its date. */
export const resultOf = (stamp) => String(stamp || '').replace(/^(confirmed|skipped|uncertain)\s+\d{4}-\d{2}-\d{2}:?\s*(→\s*)?/, '').trim()

const STATUS_FOR = { accept: 'accepted', deny: 'denied', draft: 'draft' }

/** The card's status after the owner's action (`uncertain` when it may or may not have gone out). */
export const cardStatus = (action, uncertain = false) => (uncertain ? 'uncertain' : STATUS_FOR[action] || 'pending')

/** What the agent is told, as the owner's message in the chat. */
export function outcomeText(item, { status, note = '', result = '' }) {
  const head = `[Inbox ${item.id} · ${item.kind}: ${item.title}]`
  const said = {
    accepted: `The owner accepted it.${result ? ` Result: ${result}.` : ''}`,
    draft: `The owner saved it as a draft instead of sending it.${result ? ` Result: ${result}.` : ''}`,
    denied: 'The owner denied it. Nothing was done.',
    uncertain: `The owner accepted it, but it may or may not have gone out${result ? ` (${result})` : ''}. Check before trying again.`,
  }[status] || 'The owner answered it.'
  return `${head} ${said}${note ? `\n\nThe owner's note: ${note}` : ''}`
}

/** The owner's words about a proposal still open (the card's Reply). */
export const replyText = (item, words) => `[About inbox ${item.id} · ${item.kind}: ${item.title}, still waiting for the owner's decision] ${words}`

/**
 * How the outcome reaches the chat: `record` (a message, no turn), `start` a
 * turn, or follow the running reply (`queue` or `steer`). Never a turn for a
 * denial without a note.
 */
export function outcomeRoute({ status, note, running, followUp }) {
  if (status === 'denied' && !note) return 'record'
  if (status === 'uncertain' && !note) return 'record'
  if (!running) return 'start'
  return followUp === 'steer' ? 'steer' : 'queue'
}

/**
 * The bridge's side. `threads` is the thread store; `liveCard(runId)` the
 * running reply's own way to update its card (its in-memory copy wins over the
 * file until it ends), or null; `running(threadId)` whether a reply runs;
 * `startTurn`, `steer` and `enqueue` are startChatTurn, steerRun and the queue's
 * add. `followUp()` reads the setting at the moment of the decision.
 */
export function createInboxOutcomes({ threads, liveCard = () => null, running, startTurn, steer, enqueue, followUp = () => 'queue', now = Date.now, log = () => {} }) {
  /** Update the card in the reply that staged it. */
  async function markCard(ref, patch) {
    if (!ref.runId) return
    const live = liveCard(ref.runId)
    if (live) return live(patch)
    await threads.update(ref.threadId, (t) => {
      const m = t.messages.find((x) => x.id === ref.runId)
      const p = m?.parts?.find((x) => x.type === 'inbox' && x.id === patch.id)
      if (p) Object.assign(p, patch)
    })
  }

  /**
   * Update the card behind `item`, and with `tell` (the owner's own decision)
   * tell its chat. Returns how the outcome went there (`card` for the card alone), or null.
   */
  async function report(item, { action, note = '', stamp = '', uncertain = false, tell = true }) {
    const ref = chatRefOf(item.meta)
    if (!ref) return null
    const thread = await threads.get(ref.threadId)
    if (!thread) return null
    const status = cardStatus(action, uncertain)
    const words = cleanNote(note)
    const result = resultOf(stamp)
    await markCard(ref, { id: item.id, status, ...(words ? { note: words } : {}), ...(result ? { result } : {}), decidedAt: now() })
      .catch((e) => log('inbox outcome: card update failed', e?.message || e))
    if (!tell) return 'card'
    const text = outcomeText(item, { status, note: words, result })
    const marker = { id: item.id, status }
    const route = outcomeRoute({ status, note: words, running: running(ref.threadId), followUp: followUp() })
    if (route === 'record') {
      await threads.update(ref.threadId, (t) => {
        t.messages.push({ id: `inbox-${item.id}-${now()}`, role: 'user', content: text, createdAt: now(), inbox: marker })
        t.updatedAt = now()
      })
      return route
    }
    return deliver(thread, text, marker, route)
  }

  /** The owner's words about a proposal still open: a message in its chat, as his own. */
  async function reply(item, words) {
    const ref = chatRefOf(item.meta)
    const text = cleanNote(words)
    if (!ref || !text) return null
    const thread = await threads.get(ref.threadId)
    if (!thread) return null
    const route = outcomeRoute({ status: 'pending', note: text, running: running(ref.threadId), followUp: followUp() })
    return deliver(thread, replyText(item, text), { id: item.id, status: 'pending' }, route)
  }

  async function deliver(thread, text, marker, route) {
    const ms = thread.modelSettings || null
    const turn = {
      threadId: thread.id, text, inbox: marker,
      ...(thread.provider ? { provider: thread.provider, model: ms?.modelId || undefined, effort: ms?.effort && ms.effort !== 'default' ? ms.effort : undefined, modelSettings: ms || undefined } : {}),
    }
    if (route === 'steer' && await steer(thread.id, text)) return 'steer'
    if (route === 'start') {
      try {
        await startTurn(turn)
        return 'start'
      } catch (e) {
        // Something started first (a 409): this waits its turn instead.
        if (e?.status !== 409) throw e
      }
    }
    await enqueue(turn)
    return 'queue'
  }

  return { report, reply }
}

export const validInboxId = (id) => INBOX_ID.test(String(id || ''))

/** The mark on a chat message that carries an outcome or a reply (`{ id, status }`), or null. */
export const inboxMarker = (m) => (m && typeof m === 'object' && validInboxId(m.id) && INBOX_CARD_STATUSES.includes(m.status) ? { id: m.id, status: m.status } : null)

/** A stored `inbox` part: the approval card in the reply that staged the proposal. */
export function normalizeInboxPart(p) {
  if (!validInboxId(p?.id)) return null
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
  const out = { type: 'inbox', id: p.id, kind: str(p.kind, 40) || 'inbox', title: str(p.title, 300), status: INBOX_CARD_STATUSES.includes(p.status) ? p.status : 'pending' }
  if (p.note) out.note = str(p.note, NOTE_MAX)
  if (p.result) out.result = str(p.result, 600)
  for (const k of ['stagedAt', 'decidedAt']) if (Number(p[k]) > 0) out[k] = Number(p[k])
  return out
}
