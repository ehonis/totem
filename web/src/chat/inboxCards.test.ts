import { describe, expect, it } from 'vitest'
import { inboxOutcome, outcomeLabel, pendingInboxCards, resultOf, statusFor } from './inboxCards'
import type { ChatMessage, InboxPart } from './types'

const card = (id: string, status: InboxPart['status'], extra: Partial<InboxPart> = {}): InboxPart => ({ type: 'inbox', id, kind: 'email', title: `Email ${id}`, status, ...extra })
const reply = (id: string, parts: InboxPart[]): ChatMessage => ({ id, role: 'assistant', content: '', createdAt: 0, parts, status: 'done' })

describe('inbox cards', () => {
  it('finds every card still waiting, in finished replies too', () => {
    const t = { messages: [reply('a', [card('P1', 'accepted'), card('P2', 'pending')]), reply('b', [card('P3', 'pending')])] }
    expect(pendingInboxCards(t).map((p) => p.id)).toEqual(['P2', 'P3'])
    expect(pendingInboxCards(null)).toEqual([])
  })

  it('says what happened, with his note', () => {
    expect(inboxOutcome(card('P1', 'accepted', { result: 'sent to sam' }))).toBe('Accepted: sent to sam')
    expect(inboxOutcome(card('P1', 'denied', { note: 'not now' }))).toBe('Denied · “not now”')
    expect(statusFor('draft')).toBe('draft')
    expect(resultOf('confirmed 2026-11-04 → saved as a draft in me (d1)')).toBe('saved as a draft in me (d1)')
  })

  it('shows the bridge-written outcome as a label and his own words only', () => {
    const m = { inbox: { id: 'P1', status: 'denied' as const }, content: "[Inbox P1 · email: Email Sam] The owner denied it. Nothing was done.\n\nThe owner's note: wrong address" }
    expect(outcomeLabel(m)).toEqual({ label: 'P1 · Denied', text: 'wrong address' })
    expect(outcomeLabel({ inbox: { id: 'P1', status: 'pending' }, content: "[About inbox P1 · email: Email Sam, still waiting for the owner's decision] shorter please" }))
      .toEqual({ label: 'About P1', text: 'shorter please' })
    expect(outcomeLabel({ inbox: { id: 'P2', status: 'pending' }, content: "[About inbox P2 · email: Email Sam: [GitHub] weekly, still waiting for the owner's decision] make it shorter" }).text)
      .toBe('make it shorter')
    expect(outcomeLabel({ content: 'hi' })).toBeNull()
  })
})
