import { describe, it, expect } from 'vitest'
import { ciLine } from './ChangeCard'
import { applyEvent } from './reduce'
import type { ChangePart, ChatMessage } from './types'

const card: ChangePart = {
  type: 'change-pr', id: 'reading-abc-1', url: 'https://github.com/o/r/pull/7', number: 7, title: 'Reading list page',
  branch: 'totem-change/reading-abc', head: 'a1b2c3', files: 3, checks: { state: 'pending', passed: 2, failed: 0, pending: 1 }, warnings: [], createdAt: 1,
}
const reply = (): ChatMessage => ({ id: 'm1', role: 'assistant', content: '', createdAt: 0, parts: [] })

describe('the change PR card', () => {
  it('joins the reply once, whatever the stream repeats', () => {
    let m = applyEvent(reply(), { type: 'change', change: card })
    m = applyEvent(m, { type: 'change', change: card })
    expect(m.parts).toEqual([card])
    expect(applyEvent(reply(), { type: 'change', change: { ...card, type: 'file' } }).parts).toEqual([])
  })

  it('says where CI is in a few words', () => {
    expect(ciLine(card.checks)).toBe('CI running · 2 of 3 done')
    expect(ciLine({ state: 'failure', passed: 2, failed: 1, pending: 0 })).toBe('CI failed · 1 of 3')
    expect(ciLine({ state: 'success', passed: 1, failed: 0, pending: 0 })).toBe('CI passed · 1 check')
    expect(ciLine({ state: 'none', passed: 0, failed: 0, pending: 0 })).toBe('No checks yet')
  })
})
