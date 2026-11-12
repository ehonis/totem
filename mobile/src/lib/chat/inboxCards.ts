// Inbox proposals a chat's agent staged (chat/inbox-outcome.mjs on the bridge).
// The card shows in the reply that staged it (InboxCardRow.tsx) with the
// Inbox's own Accept and Deny, a note for the agent and Reply; the owner's
// decision comes back into the chat as his message, marked `inbox`.
import type { ChatMessage, ChatThread, InboxPart } from './types'

/** Every card in a chat still waiting on the owner, oldest first. */
export function pendingInboxCards(t: Pick<ChatThread, 'messages'> | null | undefined): InboxPart[] {
  const out: InboxPart[] = []
  for (const m of t?.messages || []) {
    for (const p of m.parts || []) if (p.type === 'inbox' && p.status === 'pending') out.push(p)
  }
  return out
}

/** What happened to a card, in a few words. */
export function inboxOutcome(part: Pick<InboxPart, 'status' | 'note' | 'result'>): string {
  const said = {
    pending: 'Waiting for your approval',
    accepted: part.result ? `Accepted: ${part.result}` : 'Accepted',
    draft: part.result ? `Saved as a draft: ${part.result}` : 'Saved as a draft',
    denied: 'Denied',
    uncertain: 'May or may not have gone out: check before retrying',
  }[part.status] || 'Decided'
  return part.note ? `${said} · “${part.note}”` : said
}

/** The resolve route's stamp ("confirmed 2026-11-04 → sent to …"), without its date. */
export const resultOf = (stamp?: string) => String(stamp || '').replace(/^(confirmed|skipped|uncertain)\s+\d{4}-\d{2}-\d{2}:?\s*(→\s*)?/, '').trim()

const STATUS_FOR: Record<string, InboxPart['status']> = { accept: 'accepted', deny: 'denied', draft: 'draft' }
export const statusFor = (action: string): InboxPart['status'] => STATUS_FOR[action] || 'pending'

/** A message the bridge wrote for an outcome, as the owner reads it: the label, then his words. */
export function outcomeLabel(m: Pick<ChatMessage, 'inbox' | 'content'>): { label: string; text: string } | null {
  if (!m.inbox) return null
  const label = m.inbox.status === 'pending' ? `About ${m.inbox.id}` : `${m.inbox.id} · ${inboxOutcome({ status: m.inbox.status })}`
  // The bracketed header is for the agent; the note after it is what he wrote.
  const note = /\n\nThe owner's note: ([\s\S]*)$/.exec(m.content)?.[1]
  // Anchored on its own ending: a title may hold "]" ("[GitHub] weekly").
  const reply = /^\[About inbox [\s\S]*?, still waiting for the owner's decision\] ([\s\S]*)$/.exec(m.content)?.[1]
  return { label, text: (note ?? reply ?? '').trim() }
}
