// Tool calls waiting on the owner's approval (chat/approvals.mjs on the bridge).
// T3 Code's pending approvals: the request shows in the reply where it was asked
// (features/chat/ApprovalRow.tsx) with Decline and Approve, and "Always allow in this chat" and
// "Cancel turn" under More. While one waits, a message sent from the composer
// declines it and tells the agent why (T3's "send feedback to decline").
import type { ApprovalDecision, ApprovalPart, ChatMessage, ChatThread } from './types'

/** The oldest request still waiting in a chat, and the reply it belongs to. */
export function pendingApproval(t: Pick<ChatThread, 'messages'> | null | undefined): { message: ChatMessage; part: ApprovalPart } | null {
  for (const message of t?.messages || []) {
    if (message.role !== 'assistant' || message.status !== 'streaming') continue
    const part = message.parts?.find((p): p is ApprovalPart => p.type === 'approval' && p.status === 'pending')
    if (part) return { message, part }
  }
  return null
}

export interface ApprovalOption { decision: ApprovalDecision; label: string }

/** Decline and Approve as buttons; the rest under More. No standing grant when Claude says so. */
export function approvalOptions(part: Pick<ApprovalPart, 'once'>): { primary: ApprovalOption[]; more: ApprovalOption[] } {
  return {
    primary: [{ decision: 'decline', label: 'Decline' }, { decision: 'accept', label: 'Approve' }],
    more: [
      ...(part.once ? [] : [{ decision: 'acceptForSession' as const, label: 'Always allow in this chat' }]),
      { decision: 'cancel', label: 'Cancel turn' },
    ],
  }
}

/** What happened to a request, in a few words, for the transcript. */
export function approvalOutcome(part: Pick<ApprovalPart, 'status' | 'decision' | 'feedback'>): string {
  switch (part.status) {
    case 'pending': return 'Waiting for approval'
    case 'approved': return part.decision === 'acceptForSession' ? 'Approved for this chat' : 'Approved'
    case 'declined': return part.feedback ? `Declined: ${part.feedback}` : 'Declined'
    case 'cancelled': return 'Cancelled'
    default: return 'Expired: the reply that asked has ended'
  }
}

/** The composer's hint while a request waits: what sending a message will do. */
export const DECLINE_PLACEHOLDER = 'Send feedback to decline this request'
