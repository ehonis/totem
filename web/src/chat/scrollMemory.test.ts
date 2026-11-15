import { beforeEach, describe, expect, it, vi } from 'vitest'
import { capEntries, pickAnchor, readScroll, resetScrollMemory, saveScroll, SCROLL_KEY, type ScrollEntry } from './scrollMemory'

describe('scroll memory', () => {
  beforeEach(() => { localStorage.clear(); resetScrollMemory() })

  it('anchors on the first message still showing at the top of the view', () => {
    const rows = [{ id: 'a', top: 0, bottom: 300 }, { id: 'b', top: 328, bottom: 900 }, { id: 'c', top: 928, bottom: 1200 }]
    expect(pickAnchor(rows, 0)).toEqual({ anchorId: 'a', offset: 0 })
    expect(pickAnchor(rows, 450)).toEqual({ anchorId: 'b', offset: 122 })
    // In the gap between two rows: the next one, which starts just below the top.
    expect(pickAnchor(rows, 310)).toEqual({ anchorId: 'b', offset: -18 })
    expect(pickAnchor(rows, 5000)).toBeNull()
  })

  it('keeps the chats looked at last', () => {
    const many: Record<string, ScrollEntry> = {}
    for (let i = 0; i < 105; i++) many[`t${i}`] = { atEnd: true, at: i }
    const kept = capEntries(many, 100)
    expect(Object.keys(kept)).toHaveLength(100)
    expect(kept.t0).toBeUndefined()
    expect(kept.t104).toBeDefined()
  })

  it('reads back what it saved, and writes it to disk soon after', () => {
    vi.useFakeTimers()
    saveScroll('x', { atEnd: false, anchorId: 'm1', offset: 40 })
    expect(readScroll('x')).toMatchObject({ atEnd: false, anchorId: 'm1', offset: 40 })
    expect(localStorage.getItem(SCROLL_KEY)).toBeNull()
    vi.advanceTimersByTime(600)
    resetScrollMemory()
    expect(readScroll('x')).toMatchObject({ anchorId: 'm1' })
    expect(readScroll('nope')).toBeNull()
    vi.useRealTimers()
  })

  it('a broken stored value reads as nothing remembered', () => {
    localStorage.setItem(SCROLL_KEY, '{nope')
    expect(readScroll('x')).toBeNull()
  })
})
