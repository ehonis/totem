import { describe, expect, it } from 'vitest'
import { createFollow } from './follow'

describe('following the chat bottom', () => {
  it('follows at the bottom and stops when he scrolls up', () => {
    const f = createFollow()
    expect(f.following).toBe(true)
    expect(f.scrolled(400)).toBe(false)
    expect(f.following).toBe(false)
    expect(f.scrolled(10)).toBe(true)
    expect(f.following).toBe(true)
  })

  // #266 review: opening the chat jumps to the bottom, and that jump's scroll event
  // arrived after the landing had started. Read as "at the bottom", it pinned the
  // chat again, so the log growing (an image loading) snapped it back down.
  it('a landing ignores the opening jump\'s scroll event, so the log growing does not pull it down', () => {
    const f = createFollow()
    f.open()
    f.startLanding()
    expect(f.scrolled(0)).toBeNull()
    expect(f.following).toBe(false)
    // An image above loads; the ResizeObserver and the layout effect ask.
    expect(f.following).toBe(false)
    expect(f.endLanding(true, 4000)).toBe(false)
    expect(f.following).toBe(false)
    // After landing, his own scrolling decides again.
    expect(f.scrolled(5)).toBe(true)
  })

  it('a landing that never found its message goes back to following', () => {
    const f = createFollow()
    f.startLanding()
    f.endLanding(false)
    expect(f.following).toBe(true)
  })

  // Round 2: a landing cut short by hiding the chat never ended, and following
  // stayed off until a reload.
  it('opening the chat again ends a landing that was cut short', () => {
    const f = createFollow()
    f.startLanding()
    f.open()
    expect(f.following).toBe(true)
    expect(f.scrolled(0)).toBe(true)
  })

  it('a message too near the bottom to scroll to leaves the chat following', () => {
    const f = createFollow()
    f.startLanding()
    expect(f.endLanding(true, 20)).toBe(true)
    expect(f.following).toBe(true)
  })
})
