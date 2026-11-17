import { describe, expect, it } from 'vitest'
import { attentionOf, attentionBadge, attentionStatus, attentionTitle } from './attention'
import type { ChatMessage, Part } from './types'

const reply = (parts: Part[], status: ChatMessage['status'] = 'streaming'): ChatMessage => ({ id: 'a', role: 'assistant', content: '', createdAt: 1, status, parts })
const questions = { type: 'questions', id: 'q', status: 'pending', questions: [{ id: '1', question: 'Which?', options: [] }] } as unknown as Part
const approval = { type: 'approval', id: 'p', status: 'pending', tool: 'Bash' } as unknown as Part
const inbox = { type: 'inbox', id: 'i', status: 'pending', title: 'Send the email' } as unknown as Part
const handoff = { id: 'h', reason: 'Sign in to Gmail', at: 1 }

describe('what a chat waits on the owner for', () => {
  it('nothing, for a chat that waits on nothing', () => {
    expect(attentionOf({ messages: [reply([])] }, null)).toBeNull()
    expect(attentionOf(null, handoff)).toBeNull()
  })

  it('the browser, named with what to do there', () => {
    const a = attentionOf({ messages: [reply([])] }, handoff)!
    expect(a).toEqual({ kind: 'browser', reason: 'Sign in to Gmail' })
    expect(attentionBadge(a)).toBe('Your turn')
    expect(attentionTitle(a)).toBe('Your turn in the browser: Sign in to Gmail')
    expect(attentionStatus(a)).toBe('Your turn in the browser: Sign in to Gmail')
  })

  it('questions, then an approval, then the browser, then a proposal', () => {
    expect(attentionOf({ messages: [reply([inbox, approval, questions])] }, handoff)?.kind).toBe('questions')
    expect(attentionOf({ messages: [reply([inbox, approval])] }, handoff)?.kind).toBe('approval')
    expect(attentionOf({ messages: [reply([inbox])] }, handoff)?.kind).toBe('browser')
    const a = attentionOf({ messages: [reply([inbox], 'done')] }, null)!
    expect(a).toEqual({ kind: 'proposal', titles: ['Send the email'] })
    expect(attentionBadge(a)).toBe('Awaiting approval')
    expect(attentionStatus(a)).toBe('Waiting on your approval: Send the email')
  })

  it('an approval counts only while its reply runs', () => {
    expect(attentionOf({ messages: [reply([approval], 'done')] }, null)).toBeNull()
  })
})
