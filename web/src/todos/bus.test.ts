import { afterEach, describe, expect, it, vi } from 'vitest'
import { announceTasks, announcing, onTasksChanged } from './bus'

describe('task change bus', () => {
  afterEach(() => { vi.useRealTimers() })

  it('tells every other view once per burst, never the one that made the change', () => {
    vi.useFakeTimers()
    const board = vi.fn()
    const work = vi.fn()
    const offBoard = onTasksChanged('board', board)
    const offWork = onTasksChanged('work', work)
    announceTasks('work')
    announceTasks('work', { sheet: true })
    vi.advanceTimersByTime(300)
    expect(board).toHaveBeenCalledTimes(1)
    expect(board).toHaveBeenCalledWith({ origin: 'work', sheet: true })
    expect(work).not.toHaveBeenCalled()
    announceTasks('chat')
    vi.advanceTimersByTime(300)
    expect(work).toHaveBeenCalledWith({ origin: 'chat', sheet: false })
    expect(board).toHaveBeenCalledTimes(2)
    offBoard(); offWork()
    announceTasks('chat')
    vi.advanceTimersByTime(300)
    expect(board).toHaveBeenCalledTimes(2)
  })

  it('announces a wrapped call only when it succeeds', async () => {
    vi.useFakeTimers()
    const seen = vi.fn()
    const off = onTasksChanged('board', seen, 0)
    const ok = announcing('work', async (n: number) => n * 2)
    const bad = announcing('work', async () => { throw new Error('no') })
    expect(await ok(2)).toBe(4)
    await expect(bad()).rejects.toThrow('no')
    vi.advanceTimersByTime(1)
    expect(seen).toHaveBeenCalledTimes(1)
    off()
  })
})
