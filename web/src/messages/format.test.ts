import { describe, expect, it } from 'vitest'
import type { Message } from './api'
import { initials, layoutThread, listTime, mergeLatest, prependOlder, previewText, reactionLabel } from './format'

const NOW = new Date(2026, 9, 5, 15, 0) // Mon 5 Oct 2026, 3 pm local

let nextId = 1
function msg(at: Date, over: Partial<Message> = {}): Message {
  return {
    id: nextId++, at: at.toISOString(), fromMe: false, sender: '+15550001', senderName: 'Ada', text: 'hi',
    service: 'iMessage', attachments: [], reactions: [], ...over,
  }
}
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 9, 5 + dayOffset, h, m)

describe('listTime', () => {
  it('shows a clock time for today and words for the recent past', () => {
    expect(listTime(at(9, 5).toISOString(), NOW)).toMatch(/9.*05/)
    expect(listTime(at(23, 0, -1).toISOString(), NOW)).toBe('Yesterday')
    const fourDaysAgo = at(12, 0, -4)
    expect(listTime(fourDaysAgo.toISOString(), NOW)).toBe(fourDaysAgo.toLocaleDateString(undefined, { weekday: 'long' }))
  })
  it('is empty for nothing', () => {
    expect(listTime(null, NOW)).toBe('')
    expect(listTime('not a date', NOW)).toBe('')
  })
})

describe('previewText', () => {
  it('prefixes the owner\'s own messages and names a bare attachment', () => {
    expect(previewText({ at: NOW.toISOString(), fromMe: true, text: 'on my way' })).toBe('You: on my way')
    expect(previewText({ at: NOW.toISOString(), fromMe: false, text: '' })).toBe('Attachment')
    expect(previewText({ at: NOW.toISOString(), fromMe: false, text: 'a\n\nb' })).toBe('a b')
    expect(previewText(null)).toBe('')
  })
})

describe('layoutThread', () => {
  it('puts a timestamp line at the start and after an hour of quiet', () => {
    const items = layoutThread([msg(at(9)), msg(at(9, 2)), msg(at(11))], false, NOW)
    expect(items.map((i) => !!i.divider)).toEqual([true, false, true])
    expect(items[0].divider).toMatch(/^Today /)
  })

  it('groups one sender\'s close messages into a run', () => {
    const items = layoutThread([
      msg(at(9)), msg(at(9, 1)), msg(at(9, 2), { fromMe: true, sender: 'me' }), msg(at(9, 3)), msg(at(9, 20)),
    ], true, NOW)
    expect(items.map((i) => [i.first, i.last])).toEqual([
      [true, false], [false, true], [true, true], [true, true], [true, true],
    ])
    // Sender names only on others' runs in a group chat.
    expect(items.map((i) => i.showSender)).toEqual([true, false, false, true, true])
  })

  it('never names the sender in a one-to-one chat', () => {
    expect(layoutThread([msg(at(9))], false, NOW)[0].showSender).toBe(false)
  })
})

describe('mergeLatest / prependOlder', () => {
  it('keeps older pages a poll does not cover and takes the poll for the rest', () => {
    const a = msg(at(8)), b = msg(at(9)), c = msg(at(10))
    const cFresh = { ...c, reactions: [{ by: 'Ada', kind: 'loved' }] }
    const d = msg(at(11))
    const merged = mergeLatest([a, b, c], [b, cFresh, d])
    expect(merged.map((m) => m.id)).toEqual([a.id, b.id, c.id, d.id])
    expect(merged[2].reactions).toHaveLength(1)
    expect(mergeLatest([a], [])).toEqual([a])
  })
  it('prepends without duplicates', () => {
    const a = msg(at(8)), b = msg(at(9))
    expect(prependOlder([b], [a, b]).map((m) => m.id)).toEqual([a.id, b.id])
  })
})

describe('small labels', () => {
  it('reads tapbacks and initials naturally', () => {
    expect(reactionLabel({ by: 'Ada', kind: 'loved' })).toBe('Ada loved')
    expect(reactionLabel({ by: 'Me', kind: 'liked' })).toBe('You liked')
    expect(initials('Ada Lovelace')).toBe('AL')
    expect(initials('Ada')).toBe('A')
    expect(initials('+1 (555) 000-1234')).toBe('#')
  })
})
