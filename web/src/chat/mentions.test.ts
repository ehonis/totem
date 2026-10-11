import { describe, it, expect } from 'vitest'
import { mentionAtCaret, splitMentions, insertMention } from './mentions'

describe('mentionAtCaret', () => {
  it('finds a token at the start and mid-sentence', () => {
    expect(mentionAtCaret('/fi', 3)).toEqual({ prefix: '/', term: 'fi', start: 0, end: 3 })
    const s = 'please use /find'
    expect(mentionAtCaret(s, s.length)).toMatchObject({ prefix: '/', term: 'find', start: 11 })
    expect(mentionAtCaret('run $', 5)).toMatchObject({ prefix: '$', term: '' })
  })

  it('ignores paths, words with a slash and a caret inside a token', () => {
    expect(mentionAtCaret('and/or', 6)).toBeNull()
    expect(mentionAtCaret('/home/owner', 11)).toBeNull()
    expect(mentionAtCaret('/find thread', 3)).toBeNull()
  })

  it('looks only at the text before the caret', () => {
    expect(mentionAtCaret('use /gr then more', 7)).toMatchObject({ term: 'gr', start: 4 })
  })
})

describe('splitMentions', () => {
  const known = new Set(['/find-thread', '$morning'])

  it('marks known commands only', () => {
    expect(splitMentions('use /find-thread on (/home/x) and /nope, then $morning.', known)).toEqual([
      { text: 'use ' },
      { text: '/find-thread', mention: '/find-thread' },
      { text: ' on (/home/x) and /nope, then ' },
      { text: '$morning', mention: '$morning' },
      { text: '.' },
    ])
  })

  it('keeps the text whole when nothing matches', () => {
    expect(splitMentions('plain words', known)).toEqual([{ text: 'plain words' }])
    expect(splitMentions('/find-threads', known)).toEqual([{ text: '/find-threads' }])
  })
})

describe('insertMention', () => {
  it('replaces the partial token and adds one space', () => {
    expect(insertMention('use /fi', 4, 7, '/find-thread')).toEqual({ value: 'use /find-thread ', caret: 17 })
    expect(insertMention('use /fi now', 4, 7, '/find-thread')).toEqual({ value: 'use /find-thread now', caret: 17 })
  })
})
