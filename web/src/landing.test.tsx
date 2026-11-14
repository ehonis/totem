import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import React, { useState } from 'react'
import {
  FLASH_MS, LANDING_TIMEOUT_MS, finishLanding, subscribeLanding, flashElement, headingIndexAtLine, hitLanding, goalAnchor, isFar, pendingLanding,
  requestLanding, revealWhenReady, useLandOn,
} from './landing'

beforeEach(() => { vi.useFakeTimers(); document.documentElement.classList.remove('reduce-motion') })
afterEach(() => { vi.useRealTimers(); requestLanding('none', null) })

describe('the landing request', () => {
  it('is waiting only for its own kind, and drops out after the timeout', () => {
    requestLanding('task', 't1', { item: 'x', empty: '' }, 1000)
    expect(pendingLanding('goal', 1000)).toBeNull()
    expect(pendingLanding('task', 1000)).toMatchObject({ kind: 'task', id: 't1', extra: { item: 'x' } })
    expect(pendingLanding('task', 1000)?.extra).not.toHaveProperty('empty')
    expect(pendingLanding('task', 1000 + LANDING_TIMEOUT_MS + 1)).toBeNull()
  })

  it('an abandoned request drops itself at the timeout and tells subscribers', () => {
    const told = vi.fn()
    const off = subscribeLanding(told)
    requestLanding('msg', 'm1', {}, 0)
    vi.advanceTimersByTime(LANDING_TIMEOUT_MS + 60)
    expect(told).toHaveBeenCalledTimes(2)
    expect(pendingLanding('msg', 0)).toBeNull()
    off()
  })

  it('a finished landing does not clear a newer request', () => {
    requestLanding('task', 'old', {}, 1)
    const old = pendingLanding('task', 1)!
    requestLanding('task', 'new', {}, 2)
    finishLanding(old)
    expect(pendingLanding('task', 2)?.id).toBe('new')
  })
})

describe('flashElement', () => {
  it('washes the element and clears it after the flash', () => {
    const el = document.createElement('div')
    flashElement(el, false)
    expect(el.classList.contains('land-flash')).toBe(true)
    vi.advanceTimersByTime(FLASH_MS)
    expect(el.classList.contains('land-flash')).toBe(false)
  })

  it('a second flash within the first one\'s second runs its full time', () => {
    const el = document.createElement('div')
    flashElement(el, false)
    vi.advanceTimersByTime(FLASH_MS - 200)
    flashElement(el, false)
    vi.advanceTimersByTime(400)
    expect(el.classList.contains('land-flash')).toBe(true)
    vi.advanceTimersByTime(FLASH_MS)
    expect(el.classList.contains('land-flash')).toBe(false)
  })

  it('with less motion, a still outline that clears too', () => {
    document.documentElement.classList.add('reduce-motion')
    const el = document.createElement('div')
    flashElement(el)
    expect(el.classList.contains('land-flash-still')).toBe(true)
    expect(el.classList.contains('land-flash')).toBe(false)
    vi.advanceTimersByTime(FLASH_MS)
    expect(el.className).toBe('')
  })
})

describe('revealWhenReady', () => {
  it('waits for the element, scrolls it to the middle and flashes it', () => {
    let el: HTMLElement | null = null
    const done = vi.fn()
    revealWhenReady(() => el, { until: Date.now() + 2000, onDone: done, still: false })
    vi.advanceTimersByTime(500)
    expect(done).not.toHaveBeenCalled()
    el = document.createElement('div')
    el.scrollIntoView = vi.fn()
    vi.advanceTimersByTime(250)
    expect(el.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
    expect(el.classList.contains('land-flash')).toBe(true)
    expect(done).toHaveBeenCalledWith(true)
  })

  it('flashes only once a smooth scroll has stopped moving the element', () => {
    const el = document.createElement('div')
    el.scrollIntoView = vi.fn()
    let top = 2000
    el.getBoundingClientRect = () => ({ top } as DOMRect)
    const done = vi.fn()
    revealWhenReady(() => el, { until: Date.now() + 5000, onDone: done, still: false })
    for (let i = 0; i < 12; i += 1) { top -= 150; vi.advanceTimersByTime(25) }
    expect(el.classList.contains('land-flash')).toBe(false)
    vi.advanceTimersByTime(100)
    expect(el.classList.contains('land-flash')).toBe(false)
    vi.advanceTimersByTime(100)
    expect(el.classList.contains('land-flash')).toBe(true)
    expect(done).toHaveBeenCalledWith(true)
  })

  it('jumps to a far target instead of a long smooth pan, then flashes it', () => {
    const el = document.createElement('div')
    let top = 30000
    el.getBoundingClientRect = () => ({ top, height: 80 } as DOMRect)
    el.scrollIntoView = vi.fn(() => { top = 360 })
    const done = vi.fn()
    revealWhenReady(() => el, { until: Date.now() + 5000, onDone: done, still: false })
    vi.advanceTimersByTime(250)
    expect(el.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' })
    expect(el.classList.contains('land-flash')).toBe(true)
    expect(el.getBoundingClientRect().top).toBe(360)
    expect(done).toHaveBeenCalledWith(true)
  })

  it('isFar: more than two screens from the middle', () => {
    expect(isFar({ top: 300, height: 100 }, 900)).toBe(false)
    expect(isFar({ top: -1200, height: 100 }, 900)).toBe(false)
    expect(isFar({ top: 2500, height: 100 }, 900)).toBe(true)
    expect(isFar({ top: -31387, height: 100 }, 900)).toBe(true)
  })

  it('gives up quietly when it never appears', () => {
    const done = vi.fn()
    revealWhenReady(() => null, { until: Date.now() + 1000, onDone: done })
    vi.advanceTimersByTime(1100)
    expect(done).toHaveBeenCalledWith(false)
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('stops waiting when cancelled', () => {
    const done = vi.fn()
    const find = vi.fn(() => null)
    const stop = revealWhenReady(find, { until: Date.now() + 1000, onDone: done })
    vi.advanceTimersByTime(100)
    stop()
    const calls = find.mock.calls.length
    vi.advanceTimersByTime(2000)
    expect(find.mock.calls.length).toBe(calls)
    expect(done).not.toHaveBeenCalled()
  })
})

describe('useLandOn', () => {
  function Rows({ ids }: { ids: string[] }) {
    const [unfolded, setUnfolded] = useState(false)
    useLandOn('task', { ready: ids.length > 0, prepare: () => setUnfolded(true) })
    return <div>{ids.map((id) => <div key={id} data-land={`task:${id}`}>{id}</div>)}{unfolded && <div data-land="task:folded">folded</div>}</div>
  }

  it('lands once the view is ready, after its prepare step', () => {
    Element.prototype.scrollIntoView = vi.fn()
    const { container, rerender } = render(<Rows ids={[]} />)
    act(() => { requestLanding('task', 'folded') })
    act(() => { vi.advanceTimersByTime(200) })
    expect(container.querySelector('.land-flash')).toBeNull()
    rerender(<Rows ids={['a', 'b']} />)
    act(() => { vi.advanceTimersByTime(300) })
    expect(container.querySelector('[data-land="task:folded"]')!.classList.contains('land-flash')).toBe(true)
    expect(pendingLanding('task')).toBeNull()
  })
})

describe('headingIndexAtLine', () => {
  const md = '# Watches\nintro\n\n## Seiko\n```\n# not a heading\n```\n## Casio\n'
  it('counts the headings before the line, skipping fenced code', () => {
    expect(headingIndexAtLine(md, 1)).toBe(0)
    expect(headingIndexAtLine(md, 4)).toBe(1)
    expect(headingIndexAtLine(md, 8)).toBe(2)
    expect(headingIndexAtLine(md, 2)).toBeNull()
    expect(headingIndexAtLine(md, 99)).toBeNull()
  })
})

describe('hitLanding', () => {
  it('maps each search target to the item its view looks for', () => {
    expect(hitLanding({ tab: 'chat', thread: 't1', message: 'm1' })).toEqual({ kind: 'msg', id: 'm1', extra: {} })
    expect(hitLanding({ tab: 'chat', thread: 't1', message: null })).toBeNull()
    expect(hitLanding({ tab: 'chat', project: 'p1', section: 'memory' })).toEqual({ kind: 'project', id: 'p1', extra: { section: 'memory' } })
    expect(hitLanding({ tab: 'totems', totem: 'j1', section: 'instructions' })).toEqual({ kind: 'totem', id: 'j1', extra: { section: 'instructions' } })
    expect(hitLanding({ tab: 'brain', path: 'a/b.md', line: 5 })).toEqual({ kind: 'note', id: 'a/b.md', extra: { line: '5' } })
    expect(hitLanding({ tab: 'productivity', app: 'todos', id: 'x' })).toEqual({ kind: 'task', id: 'x', extra: {} })
    expect(hitLanding({ tab: 'productivity', app: 'lists', id: 'L', item: 'i' })).toEqual({ kind: 'list', id: 'L', extra: { item: 'i' } })
    expect(hitLanding({ tab: 'productivity', app: 'goals', id: 'g2', parent: 'g1', period: 'month', start: '2026-11-01', end: '2026-11-30' }))
      .toEqual({ kind: 'goal', id: 'g2', extra: { parent: 'g1', period: 'month', start: '2026-11-01', end: '2026-11-30' } })
    expect(hitLanding({ tab: 'productivity', app: 'journal', id: 'j' })).toEqual({ kind: 'journal', id: 'j', extra: {} })
    expect(hitLanding({ tab: 'productivity', app: 'calendar' })).toBeNull()
    expect(hitLanding(null)).toBeNull()
  })
})

describe('goalAnchor', () => {
  it('stays on the tab\'s own window for a current goal and steps to an older one', () => {
    const extra = { period: 'week', start: '2026-11-09', end: '2026-11-15' }
    expect(goalAnchor(extra, '2026-11-14')).toBeNull()
    expect(goalAnchor(extra, '2026-11-20')).toEqual({ type: 'week', start: '2026-11-09' })
    expect(goalAnchor({ period: 'week' }, '2026-11-14')).toBeNull()
  })
})
