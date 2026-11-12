// A LinkedIn action for the owner to do himself: what an agent may stage, and how
// one is told apart from those already proposed.
//
// The connector never acts on LinkedIn. `linkedin__propose_action` stages a
// `linkedin` inbox card naming the post, profile or conversation, with a drafted
// comment or reply where one fits; the owner opens it on LinkedIn, does it (or
// not) and marks it done or denies it. Accepting changes nothing anywhere: it is
// his word that he did it.

import { canonicalLinkedinUrl } from './urls.mjs'

export const LINKEDIN_ACTIONS = Object.freeze(['like', 'repost', 'comment', 'reply', 'connect'])
/** At most this many cards wait at once, so a run cannot flood the inbox. */
export const MAX_PENDING = 5

const TARGETS = { like: ['post'], repost: ['post'], comment: ['post'], reply: ['conversation', 'post'], connect: ['profile'] }
const NEEDS_DRAFT = new Set(['comment', 'reply'])
// LinkedIn's own limits: a connection note is 300 characters, a comment 1,250.
const DRAFT_MAX = { comment: 1250, reply: 2000, repost: 1250, connect: 300 }

export const ACTION_VERBS = Object.freeze({
  like: 'Like', repost: 'Repost', comment: 'Comment on', reply: 'Reply to', connect: 'Connect with',
})

// A post's own text is shown on the card and goes nowhere, so a zero-width or
// direction character in it is dropped rather than refusing the whole card.
const display = (s, max) => String(s ?? '').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * The proposal as it will be stored, or an Error saying what to fix. `draftText`
 * is kept exactly (trimmed): it is what the owner copies into LinkedIn.
 */
export function normalizeLinkedinProposal(input = {}) {
  const action = String(input.kind || input.action || '').trim().toLowerCase()
  if (!LINKEDIN_ACTIONS.includes(action)) throw new Error(`kind must be one of ${LINKEDIN_ACTIONS.join(', ')}`)
  const { url: targetUrl } = canonicalLinkedinUrl(input.targetUrl, { kinds: TARGETS[action] })
  const authorName = display(input.authorName, 120)
  if (!authorName) throw new Error('authorName is required: whose post, profile or message this is')
  const postExcerpt = display(input.postExcerpt, 600)
  if (action !== 'connect' && postExcerpt.length < 8) throw new Error('postExcerpt is required: a few lines of what they wrote, so the owner can decide without opening it')
  const reason = String(input.reason || '').trim().replace(/\s+/g, ' ').slice(0, 400)
  if (reason.length < 8) throw new Error('reason is required: say in a sentence why this is worth his time')
  let draftText = String(input.draftText ?? '').trim()
  if (action === 'like') draftText = ''
  if (NEEDS_DRAFT.has(action) && !draftText) throw new Error(`draftText is required for a ${action}: write it, in the owner's voice, for him to copy`)
  if (draftText.length > DRAFT_MAX[action]) throw new Error(`draftText is too long for a ${action} (${DRAFT_MAX[action]} characters at most)`)
  return { action, targetUrl, authorName, postExcerpt, draftText, reason }
}

/** A short card title: "Comment on Sam Lee's post". */
export function proposalTitle({ action, authorName, targetUrl }) {
  const what = /\/messaging\//.test(targetUrl) ? 'message' : /\/in\//.test(targetUrl) ? '' : 'post'
  const who = authorName.replace(/[|]/g, '/').slice(0, 80)
  if (action === 'connect') return `Connect with ${who} on LinkedIn`
  return `${ACTION_VERBS[action]} ${who}${what ? `’s ${what}` : ''} on LinkedIn`
}

/** What became of an inbox line, from its stamp. */
export function lineOutcome(item) {
  if (item.status === 'open') return 'open'
  const note = String(item.note || '')
  if (/^skipped\b/.test(note)) return 'denied'
  if (/^uncertain\b/.test(note)) return 'uncertain'
  return 'done'
}

/** Every LinkedIn proposal in the inbox, newest first. `items` are parsed inbox lines. */
export function linkedinHistory(items) {
  return items
    .filter((it) => it?.kind === 'linkedin')
    .map((it) => ({
      id: it.id,
      status: lineOutcome(it),
      action: it.meta?.action || null,
      targetUrl: it.meta?.target || null,
      authorName: it.meta?.author || null,
      title: it.title,
      decided: it.status === 'open' ? null : (/\d{4}-\d{2}-\d{2}/.exec(it.note || '')?.[0] || null),
    }))
    .reverse()
}

/**
 * Why this proposal must not be staged, or null: the same target was proposed
 * before (open, done or denied: a denial is final), or MAX_PENDING cards wait.
 */
export function stagingConflict(items, proposal) {
  const history = linkedinHistory(items)
  const same = history.find((h) => h.targetUrl === proposal.targetUrl)
  if (same) return { alreadyProposed: { id: same.id, status: same.status } }
  const pending = history.filter((h) => h.status === 'open').length
  if (pending >= MAX_PENDING) return { capped: { pending, max: MAX_PENDING } }
  return null
}
