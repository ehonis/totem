import { describe, expect, it } from 'vitest'
import { approvalOptions, approvalOutcome, pendingApproval } from './approvals'
import type { ApprovalPart, ChatMessage } from './types'

const part = (id: string, status: ApprovalPart['status'], extra: Partial<ApprovalPart> = {}): ApprovalPart => ({ type: 'approval', id, tool: 'Bash', title: 'Ran a command', detail: 'touch x', status, ...extra })
const reply = (id: string, parts: ApprovalPart[], status: ChatMessage['status'] = 'streaming'): ChatMessage => ({ id, role: 'assistant', content: '', createdAt: 0, parts, status })

describe('approvals', () => {
  it('finds the request still waiting in a running reply', () => {
    expect(pendingApproval({ messages: [reply('a', [part('x', 'approved'), part('y', 'pending')])] })?.part.id).toBe('y')
    expect(pendingApproval({ messages: [reply('a', [part('x', 'pending')], 'done')] })).toBeNull()
    expect(pendingApproval(null)).toBeNull()
  })
  it('offers Always allow unless Claude says no standing grant', () => {
    expect(approvalOptions({}).more.map((o) => o.decision)).toEqual(['acceptForSession', 'cancel'])
    expect(approvalOptions({ once: true }).more.map((o) => o.decision)).toEqual(['cancel'])
    expect(approvalOptions({}).primary.map((o) => o.decision)).toEqual(['decline', 'accept'])
  })
  it('says what happened', () => {
    expect(approvalOutcome({ status: 'declined', feedback: 'use tmp' })).toBe('Declined: use tmp')
    expect(approvalOutcome({ status: 'approved', decision: 'acceptForSession' })).toBe('Approved for this chat')
    expect(approvalOutcome({ status: 'expired' })).toMatch(/Expired/)
  })
})
