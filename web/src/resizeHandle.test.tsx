import React, { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ResizeHandle, { CHATS_WIDTH, PANEL_RESIZE_END, SIDE_PANEL_VAR, TERMINAL_WIDTH, usePublishedWidth } from './components/ResizeHandle'

// jsdom has no layout, so this stands in for the stylesheet (shell.css, chat.css),
// grid and all. The chats panel and the terminal are tracks from their minimum up
// to their saved width: the free space past every minimum and the page's is
// shared out equally until each track reaches its width, the way the grid does,
// so a track can be drawn narrower than it is saved. The page takes the rest. A
// side panel is its basis between its minimum and what leaves the chat its own.
// No rail, for round numbers.
let WINDOW = 1200
const TERM = { min: 340, initial: 520 }, CHATS = { min: 220, initial: 268, max: 560 }
const CHAT_MIN = 380, SIDE_MIN = 320, PAGE_MIN = 400, SPLIT_PAGE_MIN = CHAT_MIN + SIDE_MIN + 1
const shellEl = () => document.querySelector<HTMLElement>('.app.shell')!
const sideEl = () => document.querySelector<HTMLElement>('.vc-artifact')
const num = (el: Element | null, cssVar: string) => parseFloat((el as HTMLElement | null)?.style.getPropertyValue(cssVar) || '')
const pick = (set: number, initial: number) => (Number.isFinite(set) ? set : initial)
const clampTo = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max))
function layout() {
  const shell = shellEl()
  const side = sideEl()
  const tracks: Array<{ key: 'chats' | 'term'; min: number; limit: number; size: number }> = []
  if (shell.querySelector(':scope > .sh-panel')) tracks.push({ key: 'chats', min: CHATS.min, limit: Math.max(CHATS.min, Math.min(pick(num(shell, '--sh-panel-w'), CHATS.initial), CHATS.max)), size: CHATS.min })
  if (shell.querySelector(':scope > .term-panel')) tracks.push({ key: 'term', min: TERM.min, limit: Math.max(TERM.min, pick(num(shell, '--term-w'), TERM.initial)), size: TERM.min })
  // With a side panel open the page keeps the chat's minimum and the side panel's saved width (--side-saved).
  const sideSaved = num(shell, '--side-saved')
  const pageMin = side ? SPLIT_PAGE_MIN + Math.max(0, (Number.isFinite(sideSaved) ? sideSaved : 0) - SIDE_MIN) : PAGE_MIN
  let free = Math.max(0, WINDOW - pageMin - tracks.reduce((n, t) => n + t.min, 0))
  // Equal shares, smallest need first, each track frozen at its width.
  const open = [...tracks].sort((a, b) => (a.limit - a.min) - (b.limit - b.min))
  while (open.length && free > 0) {
    const share = free / open.length
    const t = open[0]
    if (t.limit - t.size <= share) { free -= t.limit - t.size; t.size = t.limit; open.shift(); continue }
    for (const o of open) o.size += share
    free = 0
  }
  const size = (k: 'chats' | 'term') => tracks.find((t) => t.key === k)?.size ?? 0
  const main = WINDOW - size('chats') - size('term')
  const split = main - 1
  const sideWidth = side ? clampTo(pick(num(side, SIDE_PANEL_VAR), split - Math.min(split * 0.46, 640)), SIDE_MIN, split - CHAT_MIN) : 0
  return { chats: size('chats'), term: size('term'), main, side: sideWidth, chat: split - sideWidth }
}
const rect = (width: number) => ({ width, height: 800, top: 0, left: 0, right: width, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
const WIDTH_OF: Array<[string, keyof ReturnType<typeof layout>]> = [['term-panel', 'term'], ['sh-panel', 'chats'], ['main', 'main'], ['vc-artifact', 'side'], ['vc-chat', 'chat']]

// jsdom has no PointerEvent; a MouseEvent with a pointer id is all the handle reads.
class TestPointerEvent extends MouseEvent {
  pointerId: number
  constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1 }
}

// A ResizeObserver the tests fire by hand, as the browser would after a layout.
const observers = new Set<() => void>()
class TestResizeObserver {
  cb: () => void
  constructor(cb: () => void) { this.cb = cb }
  observe() { observers.add(this.cb) }
  disconnect() { observers.delete(this.cb) }
}
const resizeAll = () => act(() => { observers.forEach((cb) => cb()) })
const setInnerWidth = (width: number) => Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
const resizeWindow = (width: number) => act(() => { WINDOW = width; setInnerWidth(width); window.dispatchEvent(new Event('resize')) })

let frames: FrameRequestCallback[] = []
const flushFrames = () => act(() => { const run = frames; frames = []; run.forEach((cb) => cb(0)) })

beforeEach(() => {
  localStorage.clear()
  WINDOW = 1200
  setInnerWidth(1200)
  frames = []
  observers.clear()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('PointerEvent', TestPointerEvent)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const hit = WIDTH_OF.find(([cls]) => this.classList.contains(cls))
    return rect(hit ? layout()[hit[1]] : 0)
  })
  const captured = new Set<number>()
  HTMLElement.prototype.setPointerCapture = (id: number) => { captured.add(id) }
  HTMLElement.prototype.hasPointerCapture = (id: number) => captured.has(id)
  HTMLElement.prototype.releasePointerCapture = (id: number) => { captured.delete(id) }
})
afterEach(() => {
  cleanup()
  document.body.className = ''
  document.documentElement.removeAttribute('style')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function Terminal() {
  return (
    <div className="app shell">
      <main className="main" />
      <aside className="term-panel">
        <ResizeHandle role="terminal" {...TERMINAL_WIDTH} label="Resize the terminal panel" />
      </aside>
    </div>
  )
}
const PANEL_MIN = TERM.min, DEFAULT = TERM.initial
const handle = () => screen.getByRole('separator', { name: 'Resize the terminal panel' })
const termVar = () => shellEl().style.getPropertyValue('--term-w')

it('picks up a width the terminal saved before the shared handle, under the same key', () => {
  localStorage.setItem('totem.terminal.width', '720')
  render(<Terminal />)
  expect(termVar()).toBe('720px')
  expect(handle()).toHaveAttribute('aria-valuenow', '720')
  // Set on the shell, where the grid reads it, not on the whole document.
  expect(document.documentElement.style.getPropertyValue('--term-w')).toBe('')
})

it('ignores a saved width that is not one', () => {
  localStorage.setItem('totem.terminal.width', 'NaN')
  render(<Terminal />)
  expect(termVar()).toBe('')
  expect(handle()).toHaveAttribute('aria-valuenow', String(DEFAULT))
})

it('reports its limits as the stylesheet allows them, once the pointer is over it', () => {
  render(<Terminal />)
  fireEvent.pointerEnter(handle())
  flushFrames()
  expect(handle()).toHaveAttribute('aria-valuemin', String(PANEL_MIN))
  expect(handle()).toHaveAttribute('aria-valuemax', String(WINDOW - PAGE_MIN))
  expect(handle()).toHaveAttribute('aria-valuenow', String(DEFAULT))
  // Measuring leaves the width as it was.
  expect(termVar()).toBe('')
})

it('drags, saves on release, and takes focus so the keys work after', () => {
  render(<Terminal />)
  fireEvent.pointerDown(handle(), { clientX: 1000, button: 0 })
  expect(document.activeElement).toBe(handle())
  expect(document.body).toHaveClass('panel-resizing')
  fireEvent.pointerMove(handle(), { clientX: 800 })
  expect(termVar()).toBe(`${DEFAULT}px`) // pinned where it is drawn; the move is written on the next frame
  flushFrames()
  expect(termVar()).toBe('720px')
  fireEvent.pointerMove(handle(), { clientX: 0 })
  fireEvent.pointerUp(handle(), { clientX: 0 })
  expect(termVar()).toBe(`${WINDOW - PAGE_MIN}px`)
  expect(localStorage.getItem('totem.terminal.width')).toBe(String(WINDOW - PAGE_MIN))
  expect(document.body).not.toHaveClass('panel-resizing')
  fireEvent.keyDown(handle(), { key: 'ArrowRight' })
  expect(termVar()).toBe(`${WINDOW - PAGE_MIN - 16}px`)
})

it('puts the width back on Escape mid-drag, saves nothing, and leaves Escape to no one else', () => {
  localStorage.setItem('totem.terminal.width', '600')
  render(<Terminal />)
  const closer = vi.fn()
  window.addEventListener('keydown', closer)
  fireEvent.pointerDown(handle(), { clientX: 1000, button: 0 })
  fireEvent.pointerMove(handle(), { clientX: 700 })
  flushFrames()
  expect(termVar()).toBe('800px')
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(termVar()).toBe('600px')
  expect(localStorage.getItem('totem.terminal.width')).toBe('600')
  expect(document.body).not.toHaveClass('panel-resizing')
  expect(closer).not.toHaveBeenCalled()
  // The drag is over: a later Escape is the page's again.
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(closer).toHaveBeenCalledTimes(1)
  window.removeEventListener('keydown', closer)
})

it('cleans up when the panel goes away mid-drag', () => {
  const removed = vi.spyOn(window, 'removeEventListener')
  const { unmount } = render(<Terminal />)
  fireEvent.pointerDown(handle(), { clientX: 1000, button: 0 })
  fireEvent.pointerMove(handle(), { clientX: 900 })
  unmount()
  expect(document.body).not.toHaveClass('panel-resizing')
  expect(removed).toHaveBeenCalledWith('keydown', expect.any(Function), true)
  expect(localStorage.getItem('totem.terminal.width')).toBeNull()
})

it('steps with the arrows, jumps with Home and End, and resets with Enter or a double-click', () => {
  render(<Terminal />)
  const h = handle()
  fireEvent.keyDown(h, { key: 'ArrowLeft' })
  expect(termVar()).toBe(`${DEFAULT + 16}px`)
  fireEvent.keyDown(h, { key: 'ArrowRight', shiftKey: true })
  expect(termVar()).toBe(`${DEFAULT + 16 - 64}px`)
  fireEvent.keyDown(h, { key: 'Home' })
  expect(termVar()).toBe(`${PANEL_MIN}px`)
  fireEvent.keyDown(h, { key: 'End' })
  expect(termVar()).toBe(`${WINDOW - PAGE_MIN}px`)
  expect(localStorage.getItem('totem.terminal.width')).toBe(String(WINDOW - PAGE_MIN))
  fireEvent.keyDown(h, { key: 'Enter' })
  expect(termVar()).toBe('')
  expect(localStorage.getItem('totem.terminal.width')).toBeNull()
  fireEvent.keyDown(h, { key: 'End' })
  fireEvent.doubleClick(h)
  expect(termVar()).toBe('')
  expect(localStorage.getItem('totem.terminal.width')).toBeNull()
})

it('gives an idle handle bounds that cost no layout, and its true limits on focus', () => {
  render(<Terminal />)
  flushFrames()
  const measured = vi.mocked(Element.prototype.getBoundingClientRect)
  // A resize running frame after frame: the width each time, never the limits.
  for (const width of [1100, 1050, 1000]) {
    WINDOW = width
    setInnerWidth(width)
    measured.mockClear()
    resizeAll()
    flushFrames()
    expect(measured.mock.calls.length).toBeLessThanOrEqual(1)
  }
  // A value inside its range, so a screen reader never reads it clamped into 0–100.
  expect(handle()).toHaveAttribute('aria-valuemin', '0')
  expect(handle()).toHaveAttribute('aria-valuemax', '1000')
  expect(handle()).toHaveAttribute('aria-valuenow', String(DEFAULT))
  act(() => { handle().focus() })
  expect(handle()).toHaveAttribute('aria-valuemin', String(PANEL_MIN))
  expect(handle()).toHaveAttribute('aria-valuemax', String(1000 - PAGE_MIN))
})

it('stops measuring every frame once a drag that focused it is over and the pointer has gone', () => {
  render(<Terminal />)
  fireEvent.pointerEnter(handle())
  dragBy(handle(), -40)
  expect(document.activeElement).toBe(handle())
  fireEvent.pointerLeave(handle())
  flushFrames()
  const measured = vi.mocked(Element.prototype.getBoundingClientRect)
  WINDOW = 1000
  setInnerWidth(1000)
  measured.mockClear()
  resizeAll()
  flushFrames()
  expect(measured.mock.calls.length).toBeLessThanOrEqual(1)
})

it('does not measure again on the frame after a drag: the drag measured, and moved room without making any', () => {
  render(<Terminal />)
  fireEvent.pointerEnter(handle())
  flushFrames()
  const measured = vi.mocked(Element.prototype.getBoundingClientRect)
  fireEvent.pointerDown(handle(), { clientX: 1000, button: 0 })
  fireEvent.pointerMove(handle(), { clientX: 960 })
  flushFrames()
  // Let go once the last move is drawn, as a hand does: no size changes after it.
  fireEvent.pointerUp(handle(), { clientX: 960 })
  measured.mockClear()
  flushFrames()
  expect(measured.mock.calls.length).toBeLessThanOrEqual(1)
  expect(handle()).toHaveAttribute('aria-valuenow', String(DEFAULT + 40))
  expect(handle()).toHaveAttribute('aria-valuemax', String(1200 - PAGE_MIN))
})

it('measures nothing when the pointer crosses a handle whose limits are current', () => {
  render(<Terminal />)
  fireEvent.pointerEnter(handle())
  flushFrames()
  fireEvent.pointerLeave(handle())
  const measured = vi.mocked(Element.prototype.getBoundingClientRect)
  measured.mockClear()
  fireEvent.pointerEnter(handle())
  flushFrames()
  expect(measured).not.toHaveBeenCalled()
})

it('re-measures its limits when the page beside it changes size while it is in use, but not during anyone\'s drag', () => {
  render(<Terminal />)
  fireEvent.pointerEnter(handle())
  flushFrames()
  expect(handle()).toHaveAttribute('aria-valuemax', String(1200 - PAGE_MIN))
  WINDOW = 1000
  resizeAll()
  flushFrames()
  expect(handle()).toHaveAttribute('aria-valuemax', String(1000 - PAGE_MIN))
  // Another panel's drag: the page resizes every frame, and this handle waits.
  const measured = vi.mocked(Element.prototype.getBoundingClientRect)
  document.body.classList.add('panel-resizing')
  WINDOW = 900
  measured.mockClear()
  resizeAll()
  flushFrames()
  expect(handle()).toHaveAttribute('aria-valuemax', String(1000 - PAGE_MIN))
  expect(measured.mock.calls.length).toBeLessThanOrEqual(1) // the width itself, never the limits
  document.body.classList.remove('panel-resizing')
  act(() => { window.dispatchEvent(new Event(PANEL_RESIZE_END)) })
  flushFrames()
  expect(handle()).toHaveAttribute('aria-valuemax', String(900 - PAGE_MIN))
})

function PublishedTerminal() {
  const ref = useRef<HTMLElement | null>(null)
  usePublishedWidth(ref, true, '--term-width')
  return <div className="app shell"><main className="main" /><aside className="term-panel" ref={ref} /></div>
}

it('publishes the terminal\'s width once another panel\'s drag ends, not on every frame of it', () => {
  render(<PublishedTerminal />)
  const published = () => document.documentElement.style.getPropertyValue('--term-width')
  expect(published()).toBe(`${DEFAULT}px`)
  document.body.classList.add('panel-resizing')
  shellEl().style.setProperty('--term-w', '600px')
  resizeAll()
  expect(published()).toBe(`${DEFAULT}px`)
  document.body.classList.remove('panel-resizing')
  act(() => { window.dispatchEvent(new Event(PANEL_RESIZE_END)) })
  expect(published()).toBe('600px')
})

it('keeps the focus line for the keyboard: a drag focuses the handle without lighting it', () => {
  render(<Terminal />)
  fireEvent.pointerDown(handle(), { clientX: 1000, button: 0 })
  fireEvent.pointerUp(handle(), { clientX: 1000 })
  expect(document.activeElement).toBe(handle())
  expect(handle()).toHaveAttribute('data-pointer')
  fireEvent.keyDown(handle(), { key: 'ArrowLeft' })
  expect(handle()).not.toHaveAttribute('data-pointer')
})

it('marks a limit so the cursor can say which way is left', () => {
  render(<Terminal />)
  fireEvent.keyDown(handle(), { key: 'Home' })
  expect(handle()).toHaveAttribute('data-limit', 'min')
  fireEvent.keyDown(handle(), { key: 'End' })
  expect(handle()).toHaveAttribute('data-limit', 'max')
  fireEvent.keyDown(handle(), { key: 'ArrowRight' })
  expect(handle()).not.toHaveAttribute('data-limit')
})

// The shell with any of its docked panels: the chats panel, the chat with a side panel (the canvas), the terminal.
function Shell({ chats = true, term = true, side = true }: { chats?: boolean; term?: boolean; side?: boolean }) {
  return (
    <div className="app shell">
      {chats && <aside className="sh-panel"><ResizeHandle role="chats" {...CHATS_WIDTH} label="Resize the chats panel" /></aside>}
      <main className="main">
        <div className={`vc-split${side ? ' has-artifact' : ''}`}>
          <div className="vc vc-chat" />
          {side && <ResizeHandle role="side" className="inline" cssVar={SIDE_PANEL_VAR} storageKey="totem.panel.canvas.width" label="Resize the canvas" />}
          {side && <aside className="vc vc-artifact" />}
        </div>
      </main>
      {term && <aside className="term-panel"><ResizeHandle role="terminal" {...TERMINAL_WIDTH} label="Resize the terminal panel" /></aside>}
    </div>
  )
}
const sep = (name: string) => screen.getByRole('separator', { name })
const canvasHandle = () => sep('Resize the canvas')
const chatsHandle = () => sep('Resize the chats panel')
const termHandle = () => sep('Resize the terminal panel')
const inline = () => ({ chats: shellEl().style.getPropertyValue('--sh-panel-w'), term: shellEl().style.getPropertyValue('--term-w'), side: sideEl()?.style.getPropertyValue(SIDE_PANEL_VAR) ?? '' })
const saved = () => ({ chats: localStorage.getItem(CHATS_WIDTH.storageKey), term: localStorage.getItem(TERMINAL_WIDTH.storageKey), side: localStorage.getItem('totem.panel.canvas.width') })
/** A drag of `dx` pixels on a handle, released (or put back with Escape). */
function dragBy(h: HTMLElement, dx: number, { escape = false } = {}) {
  fireEvent.pointerDown(h, { clientX: 1000, button: 0 })
  fireEvent.pointerMove(h, { clientX: 1000 + dx })
  flushFrames()
  if (escape) fireEvent.keyDown(window, { key: 'Escape' })
  else fireEvent.pointerUp(h, { clientX: 1000 + dx })
}

it('widens a side panel past the chat by taking from the terminal, then the chats panel, to their minimums; Escape puts all three back', () => {
  WINDOW = 1600
  render(<Shell />)
  const start = layout()
  expect(start.chat).toBe(CHAT_MIN) // the chat has nothing left to give: the handle used to be dead here
  fireEvent.pointerEnter(canvasHandle())
  flushFrames()
  const room = (TERM.initial - TERM.min) + (CHATS.initial - CHATS.min)
  expect(canvasHandle()).toHaveAttribute('aria-valuemax', String(start.side + room))
  // All the way: the terminal, then the chats panel, each to its minimum, and no further.
  fireEvent.pointerDown(canvasHandle(), { clientX: 900, button: 0 })
  fireEvent.pointerMove(canvasHandle(), { clientX: -2000 })
  flushFrames()
  expect(layout()).toMatchObject({ term: TERM.min, chats: CHATS.min, side: start.side + room, chat: CHAT_MIN })
  // Escape: every inline width and every saved one as it was.
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(inline()).toEqual({ term: '', chats: '', side: '' })
  expect(localStorage.length).toBe(0)
  expect(layout()).toMatchObject({ term: TERM.initial, chats: CHATS.initial, side: start.side })
})

it('saves only what moved: the dragged panel and the panel that gave; one that gave nothing keeps its saved width', () => {
  WINDOW = 1600
  render(<Shell />)
  const start = layout()
  dragBy(canvasHandle(), -50)
  expect(layout()).toMatchObject({ term: TERM.initial - 50, chats: CHATS.initial, side: start.side + 50 })
  expect(saved()).toEqual({ term: String(TERM.initial - 50), chats: null, side: String(start.side + 50) })
})

it('holds a squeezed panel where it is drawn, so the room a drag made is not taken back (the 1366 case)', () => {
  // A laptop where the saved widths do not all fit: the grid draws the chats panel
  // at 240 though it is saved at 400, and the terminal at 360 for its 520.
  WINDOW = 1301
  localStorage.setItem(CHATS_WIDTH.storageKey, '400')
  localStorage.setItem(TERMINAL_WIDTH.storageKey, '520')
  render(<Shell />)
  expect(layout()).toMatchObject({ chats: 240, term: 360, side: SIDE_MIN, chat: CHAT_MIN })
  dragBy(canvasHandle(), -20)
  // The canvas took 20 from the terminal; the chats panel gave nothing.
  expect(layout()).toMatchObject({ chats: 240, term: 340, side: SIDE_MIN + 20 })
  // The terminal gave 20, so it is saved at its saved 520 less 20, not at the 340
  // it is drawn at here, which the window squeezed; it stays drawn at 340 for now.
  expect(saved()).toEqual({ chats: '400', term: '500', side: String(SIDE_MIN + 20) })
  expect(inline().term).toBe('340px')
  // Released, nothing snaps back: the chats panel is held at 240 on screen, still 400 saved.
  expect(inline().chats).toBe('240px')
  resizeAll()
  flushFrames()
  expect(layout()).toMatchObject({ chats: 240, term: 340, side: SIDE_MIN + 20 })
  // Another gesture and Escape: the hold and the saved widths stay as they were.
  dragBy(canvasHandle(), -10, { escape: true })
  expect(inline().chats).toBe('240px')
  expect(saved()).toEqual({ chats: '400', term: '500', side: String(SIDE_MIN + 20) })
})

it('drops the holds when the window changes size, and a wider window brings every saved width back', () => {
  WINDOW = 1301
  localStorage.setItem(CHATS_WIDTH.storageKey, '400')
  render(<Shell />)
  dragBy(canvasHandle(), -20)
  expect(inline().chats).toBe('240px')
  // A height-only resize (docked devtools, an infobar) keeps the holds.
  act(() => { window.dispatchEvent(new Event('resize')) })
  expect(inline().chats).toBe('240px')
  // A width change drops them, and the saved widths alone keep the canvas at its
  // new width: the page reserves it (--side-saved), so the chats panel and the
  // terminal share the squeeze instead.
  resizeWindow(1300)
  expect(inline()).toMatchObject({ chats: '400px', term: '500px' })
  expect(layout()).toMatchObject({ side: SIDE_MIN + 20, chat: CHAT_MIN, chats: 229.5, term: 349.5 })
  // Wide: every saved width.
  resizeWindow(2000)
  expect(layout()).toMatchObject({ chats: 400, term: 500, side: SIDE_MIN + 20 })
})

it('publishes the side panel\'s saved width for the page minimum, and forgets it with the panel', () => {
  WINDOW = 1600
  localStorage.setItem('totem.panel.canvas.width', '500')
  const { rerender } = render(<Shell />)
  expect(shellEl().style.getPropertyValue('--side-saved')).toBe('500px')
  dragBy(canvasHandle(), -20)
  expect(shellEl().style.getPropertyValue('--side-saved')).toBe('520px')
  fireEvent.doubleClick(canvasHandle())
  expect(shellEl().style.getPropertyValue('--side-saved')).toBe('')
  dragBy(canvasHandle(), -10)
  rerender(<Shell side={false} />)
  expect(shellEl().style.getPropertyValue('--side-saved')).toBe('')
})

it('drops the holds when a docked panel opens or closes', () => {
  WINDOW = 1301
  localStorage.setItem(CHATS_WIDTH.storageKey, '400')
  const { rerender } = render(<Shell />)
  dragBy(canvasHandle(), -20)
  expect(inline().chats).toBe('240px')
  rerender(<Shell term={false} />)
  expect(inline().chats).toBe('400px')
  dragBy(chatsHandle(), -10)
  rerender(<Shell term={false} side={false} />)
  expect(inline().side).toBe('')
})

it('drops the holds when a docked panel opens', () => {
  // The terminal closed and a window the chats panel's saved 400 does not fit:
  // drawn at 299, it gives the canvas 20, is saved at 380 and held at 279.
  WINDOW = 1000
  localStorage.setItem(CHATS_WIDTH.storageKey, '400')
  const { rerender } = render(<Shell term={false} />)
  expect(layout()).toMatchObject({ chats: 299, side: SIDE_MIN, chat: CHAT_MIN })
  dragBy(canvasHandle(), -20)
  expect(inline().chats).toBe('279px')
  expect(saved().chats).toBe('380')
  // The terminal opens: the hold made for the other set of panels goes.
  rerender(<Shell />)
  expect(inline().chats).toBe('380px')
})

it('never leaves the chats panel or the terminal dead after the other took its room', () => {
  WINDOW = 1301
  const { unmount } = render(<Shell />)
  expect(layout()).toMatchObject({ chats: 240, term: 360, side: SIDE_MIN, chat: CHAT_MIN })
  // The chats panel gives 20 to the chat, then takes 40: 20 back from the chat, 20 from the terminal.
  dragBy(chatsHandle(), -20)
  expect(layout()).toMatchObject({ chats: 220, chat: CHAT_MIN + 20, term: 360 })
  dragBy(chatsHandle(), 40)
  expect(layout()).toMatchObject({ chats: 260, chat: CHAT_MIN, side: SIDE_MIN, term: 340 })
  expect(saved()).toMatchObject({ chats: '260', term: String(TERM.initial - 20), side: null })
  // And the mirror, from the start: the terminal gives 20 to the chat, then takes 40,
  // 20 back from the chat and 20 from the chats panel (the side panel is at its minimum).
  unmount()
  localStorage.clear()
  render(<Shell />)
  dragBy(termHandle(), 20)
  expect(layout()).toMatchObject({ term: TERM.min, chat: CHAT_MIN + 20, chats: 240 })
  dragBy(termHandle(), -40)
  expect(layout()).toMatchObject({ term: TERM.min + 40, chats: 220, chat: CHAT_MIN, side: SIDE_MIN })
})

it('takes in each handle\'s order: the chats panel from the side panel, then the terminal; the terminal from the side panel, then the chats panel', () => {
  WINDOW = 1500
  const { unmount } = render(<Shell />)
  const start = layout()
  expect(start).toMatchObject({ chats: CHATS.initial, term: TERM.initial, chat: CHAT_MIN })
  const sideRoom = start.side - SIDE_MIN
  expect(sideRoom).toBeGreaterThan(0)
  dragBy(chatsHandle(), 30)
  expect(layout()).toMatchObject({ chats: CHATS.initial + 30, side: SIDE_MIN, term: TERM.initial - (30 - sideRoom) })
  expect(saved()).toEqual({ chats: String(CHATS.initial + 30), side: String(SIDE_MIN), term: String(TERM.initial - (30 - sideRoom)) })
  unmount()
  localStorage.clear()
  render(<Shell />)
  dragBy(termHandle(), -30)
  expect(layout()).toMatchObject({ term: TERM.initial + 30, side: SIDE_MIN, chats: CHATS.initial - (30 - sideRoom) })
})

it('keys follow the same rule as a drag', () => {
  WINDOW = 1600
  render(<Shell />)
  fireEvent.keyDown(canvasHandle(), { key: 'End' })
  expect(layout()).toMatchObject({ term: TERM.min, chats: CHATS.min, chat: CHAT_MIN })
  expect(canvasHandle()).toHaveAttribute('data-limit', 'max')
  fireEvent.keyDown(canvasHandle(), { key: 'ArrowRight' })
  // Narrower gives the room to the chat, not back to the terminal or the chats panel.
  expect(layout()).toMatchObject({ term: TERM.min, chats: CHATS.min, chat: CHAT_MIN + 16 })
})

it('takes from the page first while it has room, even when this panel\'s own cap stops the widest measure', () => {
  WINDOW = 2000
  render(<Shell />)
  const start = layout()
  expect(start.chat).toBeGreaterThan(CHAT_MIN + 40)
  dragBy(chatsHandle(), 40)
  // (The side panel's proportional default is fractional; pinned, it is drawn at the whole pixel.)
  expect(layout()).toMatchObject({ chats: CHATS.initial + 40, chat: Math.round(start.chat - 40), side: Math.round(start.side), term: start.term })
  expect(saved()).toEqual({ chats: String(CHATS.initial + 40), term: null, side: null })
})
