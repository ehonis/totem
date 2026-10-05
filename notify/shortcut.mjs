// notify/shortcut.mjs — the two pushes that bracket a phone request.
//
// A Shortcut answer lives in exactly one place: the popup on the phone, which is
// gone the moment it's dismissed and unreadable before then if the answer ran
// long. These two notifications give the request a receipt and the answer a
// keepable, lock-screen-shaped version of itself.
//
// The receipt carries no AI on purpose. Its whole job is to arrive in the second
// the request lands — "it's running, put the phone away" — and a model can only
// add latency to that, plus the chance of it saying something other than what was
// actually asked. The summary is the opposite case: a full answer is paragraphs
// of plain text that a lock screen truncates mid-sentence, so something has to
// choose the sentence, and that is a judgement call.
import { parseCopy } from './digest.mjs'
import { TITLE_MAX } from './text.mjs'

// Labels, not content — see the header of notify/text.mjs. Both fit the 32-char
// title budget with room to spare, which is the point of them being fixed.
export const RECEIVED_TITLE = 'Totem got it'
export const ANSWERED_TITLE = 'Totem answered'
export const FAILED_TITLE = 'That one failed'

// A phone shows a few lines. Past that iOS truncates, and a truncated summary is
// the thing this feature exists to avoid producing.
const BODY_MAX = 300

/**
 * One line of plain prose out of whatever was typed, dictated, or answered.
 *
 * Markdown is stripped rather than rendered because a lock screen shows the
 * asterisks. The http channel already asks the agent for plain text, so this is
 * a backstop for the request side (where the owner types whatever he likes) and for
 * an agent that ignored the rule.
 */
export function flatten(text, max = BODY_MAX) {
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')           // fenced code, whole
    .replace(/`([^`]*)`/g, '$1')               // inline code
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images, keep the label
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')        // headings
    .replace(/^\s{0,3}[-*+]\s+/gm, '')         // bullets
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (clean.length <= max) return clean
  // Cut at a word, not mid-word: "Added buy mil…" reads like a bug.
  const cut = clean.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** The receipt. No model, no network, no thinking — just what he asked for. */
export function receivedNotification(request) {
  const body = flatten(request, 180)
  return { title: RECEIVED_TITLE, body: body || 'A request with no text in it.' }
}

/**
 * The summariser's reply, or null if it did not produce a usable one.
 *
 * Null is a normal outcome, not an error: the caller ships the deterministic
 * summary instead, exactly as the digest ships template wording when its model
 * call fails. Never hold up a notification for a model.
 */
export function parseSummary(raw) {
  // `parseCopy` is the digest's line-per-object reader, and it handles the fence,
  // the preamble and a JSON array. What it can't read is a pretty-printed object
  // spread over several lines — the one shape a small model reliably returns
  // instead — so that's tried first, from the first brace to the last.
  const cleaned = String(raw || '').replace(/```(?:json)?/g, '').trim()
  let line = null
  const braced = /\{[\s\S]*\}/.exec(cleaned)
  if (braced) {
    try { line = JSON.parse(braced[0]) } catch { /* not one object; try line by line */ }
  }
  if (!line) [line] = parseCopy(cleaned)
  if (Array.isArray(line)) line = line[0]
  if (!line || typeof line !== 'object') return null
  const body = typeof line.body === 'string' ? flatten(line.body) : ''
  if (!body) return null
  const title = typeof line.title === 'string' ? flatten(line.title, TITLE_MAX * 2) : ''
  return {
    // A title over the budget is dropped for the label rather than truncated:
    // the phone cuts the end, and the end of a title is usually the point.
    title: title && title.length <= TITLE_MAX ? title : ANSWERED_TITLE,
    body,
  }
}

/**
 * The summary that needs nothing: the answer's own opening, flattened.
 *
 * Crude and always available. An agent answering the `http` channel already
 * leads with the outcome — "Added buy milk to your Personal list" — so its first
 * couple of sentences are a passable summary of themselves.
 */
export function fallbackSummary(reply) {
  const flat = flatten(reply, BODY_MAX)
  return { title: ANSWERED_TITLE, body: flat || 'Done — open the thread for the answer.' }
}

/**
 * The third outcome: the request never produced an answer at all.
 *
 * Without this the receipt is the last thing he hears, which reads as "still
 * working" forever — the one state a receipt must never be able to get stuck in.
 * No model: the reason is an error string, and summarising an error is how you
 * end up with a friendlier version of the wrong cause.
 */
export function failedNotification(error) {
  const why = flatten(error, 200)
  return {
    title: FAILED_TITLE,
    body: why ? `Your request didn't finish: ${why}` : "Your request didn't finish, and said nothing about why.",
  }
}
