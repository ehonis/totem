import React from 'react'
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProxyAccount } from '../api'
vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  getProxyHistory: vi.fn(async () => ({ supported: true, samples: [] })),
}))
import { QuotaGraphs } from './QuotaGraphs'

const now = new Date(2026, 10, 9, 14, 0, 0).getTime()
const accounts = ['claude', 'codex'].map((backend) => ({
  id: `${backend}:proxy:a`,
  backend,
  source: 'cliproxy',
  displayName: `${backend} seat`,
  fetchedAt: now,
  meters: [
    { key: backend === 'claude' ? 'session:' : 'primary', remainingPct: 40, resetsAt: now + 3600_000, windowMinutes: 300 },
    { key: backend === 'claude' ? 'weekly_all:' : 'secondary', remainingPct: 50, resetsAt: now + 3 * 86400_000, windowMinutes: 10080 },
  ],
})) as ProxyAccount[]

// jsdom has no PointerEvent; a MouseEvent with the pointer fields stands in.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventStub extends MouseEvent {
    pointerId: number
    pointerType: string
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 0
      this.pointerType = init.pointerType ?? 'mouse'
    }
  }
  ;(window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventStub
}

const wheel = (el: Element, init: WheelEventInit) => {
  const event = new WheelEvent('wheel', { cancelable: true, bubbles: true, ...init })
  act(() => {
    el.dispatchEvent(event)
  })
  return event
}

// jsdom lays nothing out: the chart falls back to 320px wide (a 250px plot from x=56).
const RECT = { left: 0, top: 0, right: 320, bottom: 380, width: 320, height: 380, x: 0, y: 0, toJSON: () => ({}) }
let clock: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(RECT as DOMRect)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  clock.mockRestore()
})

const rangeText = () => document.querySelector('[class*="rangeText"]')!.textContent
const charts = () => screen.getAllByRole('group', { name: /pool chart/ })
const svgOf = (chart: HTMLElement) => chart.querySelector('svg')!

it('zooms every chart together from the buttons and the keyboard, and back out', async () => {
  render(<QuotaGraphs accounts={accounts} onAuthError={() => {}} />)
  await screen.findByRole('article', { name: 'Claude pool' })
  const whole = rangeText()
  expect(screen.getByRole('button', { name: 'Zoom out' })).toHaveProperty('disabled', true)
  expect(screen.queryByRole('slider')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  expect(rangeText()).not.toBe(whole)
  expect(charts().every((c) => c.dataset.zoomed === 'true')).toBe(true)
  expect(screen.getByRole('slider', { name: 'Visible part of the range' })).toBeTruthy()

  fireEvent.keyDown(charts()[0], { key: '+' })
  const closer = rangeText()
  fireEvent.keyDown(charts()[1], { key: '-' })
  expect(rangeText()).not.toBe(closer)
  fireEvent.keyDown(charts()[0], { key: '0' })
  expect(rangeText()).toBe(whole)
  expect(charts().every((c) => c.dataset.zoomed === 'false')).toBe(true)

  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show the whole range' }))
  expect(rangeText()).toBe(whole)
})

it('zooms to a stretch dragged across the plot, and a double-click undoes it', async () => {
  render(<QuotaGraphs accounts={accounts} onAuthError={() => {}} />)
  await screen.findByRole('article', { name: 'Claude pool' })
  const whole = rangeText()
  const svg = svgOf(charts()[0])
  // The 5-hour view spans 48 hours over the 250px plot: 125px is a day.
  fireEvent.pointerDown(svg, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 81 })
  fireEvent.pointerMove(svg, { pointerId: 1, pointerType: 'mouse', clientX: 206 })
  expect(svg.querySelector('rect[class*="selection"]')).toBeTruthy()
  fireEvent.pointerUp(svg, { pointerId: 1, pointerType: 'mouse', clientX: 206 })
  expect(svg.querySelector('rect[class*="selection"]')).toBeNull()
  expect(charts().every((c) => c.dataset.zoomed === 'true')).toBe(true)
  // 25px in is 4.8 hours past the start (02:00 today): 06:48 today to 06:48 tomorrow.
  expect(rangeText()).toMatch(/Nov 9 6:48\s?AM to Nov 10 6:48\s?AM/)
  // Zoomed to a day, the axis counts hours.
  expect(svg.textContent).toMatch(/\d\s?(AM|PM)/)

  fireEvent.doubleClick(svg)
  expect(rangeText()).toBe(whole)
})

it('ignores a click without a drag, and pans with a sideways scroll only once zoomed', async () => {
  render(<QuotaGraphs accounts={accounts} onAuthError={() => {}} />)
  await screen.findByRole('article', { name: 'Claude pool' })
  const whole = rangeText()
  const chart = charts()[0]
  const svg = svgOf(chart)
  fireEvent.pointerDown(svg, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 100 })
  fireEvent.pointerUp(svg, { pointerId: 1, pointerType: 'mouse', clientX: 102 })
  expect(rangeText()).toBe(whole)

  const sideways = wheel(chart, { deltaX: 50, deltaY: 0 })
  expect(sideways.defaultPrevented).toBe(false)
  const pinch = wheel(chart, { deltaY: -100, ctrlKey: true, clientX: 181 })
  expect(pinch.defaultPrevented).toBe(true)
  expect(chart.dataset.zoomed).toBe('true')
  const zoomed = rangeText()
  const pan = wheel(chart, { deltaX: 50, deltaY: 0 })
  expect(pan.defaultPrevented).toBe(true)
  expect(rangeText()).not.toBe(zoomed)
  // A plain vertical scroll is left to the page.
  const scroll = wheel(chart, { deltaY: 80 })
  expect(scroll.defaultPrevented).toBe(false)
})

it('pinches with two fingers on a phone', async () => {
  render(<QuotaGraphs accounts={accounts} onAuthError={() => {}} />)
  await screen.findByRole('article', { name: 'Claude pool' })
  const svg = svgOf(charts()[0])
  fireEvent.pointerDown(svg, { pointerId: 1, pointerType: 'touch', clientX: 140 })
  fireEvent.pointerDown(svg, { pointerId: 2, pointerType: 'touch', clientX: 200 })
  fireEvent.pointerMove(svg, { pointerId: 1, pointerType: 'touch', clientX: 80 })
  fireEvent.pointerMove(svg, { pointerId: 2, pointerType: 'touch', clientX: 260 })
  expect(charts()[0].dataset.zoomed).toBe('true')
  fireEvent.pointerUp(svg, { pointerId: 1, pointerType: 'touch', clientX: 80 })
  fireEvent.pointerUp(svg, { pointerId: 2, pointerType: 'touch', clientX: 260 })
  // Once the fingers lift, one finger only scrubs the crosshair.
  const pinched = rangeText()
  fireEvent.pointerDown(svg, { pointerId: 3, pointerType: 'touch', clientX: 100 })
  fireEvent.pointerMove(svg, { pointerId: 3, pointerType: 'touch', clientX: 220 })
  expect(rangeText()).toBe(pinched)
})

it('arrows slide a zoomed view and page on past the edge; Today resets both', async () => {
  render(<QuotaGraphs accounts={accounts} onAuthError={() => {}} />)
  await screen.findByRole('article', { name: 'Claude pool' })
  const whole = rangeText()
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  const first = rangeText()
  const next = screen.getByRole('button', { name: 'Next' })
  fireEvent.click(next)
  expect(rangeText()).not.toBe(first)
  for (let i = 0; i < 6 && !(next as HTMLButtonElement).disabled; i += 1) fireEvent.click(next)
  expect((next as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Today' }))
  expect(rangeText()).toBe(whole)
})

it('pans from the scrubber with the keyboard', async () => {
  render(<QuotaGraphs accounts={accounts} onAuthError={() => {}} />)
  await screen.findByRole('article', { name: 'Claude pool' })
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  const slider = screen.getByRole('slider')
  fireEvent.keyDown(slider, { key: 'Home' })
  const atStart = rangeText()
  expect(slider.getAttribute('aria-valuenow')).toBe('0')
  fireEvent.keyDown(slider, { key: 'ArrowRight' })
  expect(rangeText()).not.toBe(atStart)
  fireEvent.keyDown(slider, { key: 'End' })
  expect(slider.getAttribute('aria-valuenow')).toBe('50')
})

it('leaves Ctrl or Cmd with 0, - and = to the browser', async () => {
  render(<QuotaGraphs accounts={accounts} onAuthError={() => {}} />)
  await screen.findByRole('article', { name: 'Claude pool' })
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  const zoomed = rangeText()
  const chart = charts()[0]
  expect(fireEvent.keyDown(chart, { key: '0', ctrlKey: true })).toBe(true)
  expect(fireEvent.keyDown(chart, { key: '-', metaKey: true })).toBe(true)
  expect(fireEvent.keyDown(chart, { key: '=', ctrlKey: true })).toBe(true)
  expect(rangeText()).toBe(zoomed)
})

it('steps the crosshair inside a zoomed view that does not hold Now', async () => {
  render(<QuotaGraphs accounts={accounts} onAuthError={() => {}} />)
  await screen.findByRole('article', { name: 'Claude pool' })
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  fireEvent.keyDown(screen.getByRole('slider'), { key: 'End' })
  const tomorrow = rangeText()
  expect(tomorrow).toMatch(/Nov 10 2:00\s?AM to Nov 11 2:00\s?AM/)
  fireEvent.keyDown(charts()[0], { key: 'ArrowRight' })
  expect(rangeText()).toBe(tomorrow)
  expect(screen.getByRole('status').textContent).toMatch(/Nov 10/)  // Home brings Now back into the middle of the view.
  fireEvent.keyDown(charts()[0], { key: 'Home' })
  expect(rangeText()).toMatch(/Nov 9 2:00\s?AM to Nov 10 2:00\s?AM/)
})

it('resizes from one scrubber edge without moving the other', async () => {
  render(<QuotaGraphs accounts={accounts} onAuthError={() => {}} />)
  await screen.findByRole('article', { name: 'Claude pool' })
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  // The track is 320px for 48 hours (02:00 today to 02:00 in two days); the view is 14:00 to 14:00.
  expect(rangeText()).toMatch(/Nov 9 2:00\s?PM to Nov 10 2:00\s?PM/)
  const [start] = document.querySelectorAll('[data-handle]')
  const track = start.closest('[class*="zoomTrack"]')!
  fireEvent.pointerDown(start, { pointerId: 1, button: 0, clientX: 90 })
  fireEvent.pointerMove(track, { pointerId: 1, clientX: -40 })
  expect(rangeText()).toMatch(/Nov 9 2:00\s?AM to Nov 10 2:00\s?PM/)
  fireEvent.pointerMove(track, { pointerId: 1, clientX: 400 })
  expect(rangeText()).toMatch(/Nov 10 1:30\s?PM to Nov 10 2:00\s?PM/)
  fireEvent.pointerUp(track, { pointerId: 1, clientX: 400 })
  expect(screen.getByRole('button', { name: 'Zoom in' })).toHaveProperty('disabled', true)
})
