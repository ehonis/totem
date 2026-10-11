import { afterEach, describe, expect, it, vi } from 'vitest'
import { dismissToast, holdToasts, pushToast } from './toast'

// pushToast returns the id of the toast a message landed in, so a repeat that
// joins an existing toast returns that toast's id.
describe('toast store', () => {
  afterEach(() => { vi.useRealTimers() })

  it('joins a repeated message into the toast already showing it', () => {
    vi.useFakeTimers()
    const a = pushToast('Saved.', 'success')
    expect(pushToast('Saved.', 'success')).toBe(a)
    expect(pushToast('Saved.', 'info')).not.toBe(a) // another kind is another toast
    dismissToast(a!)
  })

  it('restarts the timer on a repeat, and expires on the short default', () => {
    vi.useFakeTimers()
    const a = pushToast('Synced.', 'success')
    vi.advanceTimersByTime(3000)
    expect(pushToast('Synced.', 'success')).toBe(a)
    vi.advanceTimersByTime(3000) // 6 s after the first, 3 s after the repeat
    expect(pushToast('Synced.', 'success')).toBe(a)
    vi.advanceTimersByTime(3600)
    expect(pushToast('Synced.', 'success')).not.toBe(a)
  })

  it('holds every timer while the deck is spread', () => {
    vi.useFakeTimers()
    const id = pushToast('Held.', 'info')
    holdToasts(true)
    vi.advanceTimersByTime(10_000)
    holdToasts(false)
    expect(pushToast('Held.', 'info')).toBe(id)
    vi.advanceTimersByTime(3600)
    expect(pushToast('Held.', 'info')).not.toBe(id)
  })
})
