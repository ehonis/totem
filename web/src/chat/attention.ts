// What a chat is waiting on the owner for, if anything, in the words its row in
// the chats list, the running-chats panel and the chat itself use. A run held on
// him still counts as running, so without this a chat waiting for hours on a
// sign-in looks like one still working. As in T3 Code, questions come first,
// then a tool approval, then the browser, then an inbox proposal.
import type { BrowserHandoff, ChatThread } from './types'
import { pendingQuestions } from './questions'
import { pendingApproval } from './approvals'
import { pendingInboxCards } from './inboxCards'

export type Attention =
  | { kind: 'questions'; count: number }
  | { kind: 'approval' }
  | { kind: 'browser'; reason: string }
  | { kind: 'proposal'; titles: string[] }

/** The one thing a chat waits on him for. `handoff` is the store's `handoffs[t.id]`. */
export function attentionOf(t: Pick<ChatThread, 'messages'> | null | undefined, handoff?: BrowserHandoff | null): Attention | null {
  if (!t) return null
  const asking = pendingQuestions(t)
  if (asking) return { kind: 'questions', count: asking.part.questions.length }
  if (pendingApproval(t)) return { kind: 'approval' }
  if (handoff) return { kind: 'browser', reason: handoff.reason }
  const proposals = pendingInboxCards(t)
  if (proposals.length) return { kind: 'proposal', titles: proposals.map((p) => p.title) }
  return null
}

/** The badge on its row: a couple of words. */
export function attentionBadge(a: Attention): string {
  switch (a.kind) {
    case 'questions': return 'Awaiting input'
    case 'approval': case 'proposal': return 'Awaiting approval'
    case 'browser': return 'Your turn'
  }
}

/** The badge's tooltip, and its words for a screen reader. */
export function attentionTitle(a: Attention): string {
  switch (a.kind) {
    case 'questions': return a.count === 1 ? 'Totem asked you a question' : `Totem asked you ${a.count} questions`
    case 'approval': return 'A tool call is waiting for your approval'
    case 'browser': return `Your turn in the browser: ${a.reason}`
    case 'proposal': return a.titles.length === 1 ? `Waiting on your approval: ${a.titles[0]}` : `Waiting on your approval:\n${a.titles.join('\n')}`
  }
}

/** The running-chats panel's status line, which has a little more room. */
export function attentionStatus(a: Attention): string {
  switch (a.kind) {
    case 'questions': return a.count === 1 ? 'A question for you' : `${a.count} questions for you`
    case 'approval': return 'Waiting for your approval'
    case 'browser': return `Your turn in the browser: ${a.reason}`
    case 'proposal': return `Waiting on your approval: ${a.titles.length === 1 ? a.titles[0] : `${a.titles.length} proposals`}`
  }
}
