/**
 * The drag handle every docked side panel uses to change its width: the chats
 * panel, the terminal, and the chat's side panel (Files, Browser, Agents or the
 * canvas). T3 Code's behaviour: a wide invisible grab strip on the panel's inner
 * edge with a line that shows on hover, double-click (or Enter) for the default
 * width, arrow keys when focused, and the width kept per panel on this device.
 *
 * The width is a CSS variable, and the panel's own CSS decides what it means: a
 * grid track (chats panel, terminal) or a flex basis (side panel), with each
 * minimum written there. When the window changes size the stylesheet alone lays
 * the panels out from their saved widths, squeezing them toward their minimums.
 *
 * A drag (or a key press) is one gesture with one rule, the way VS Code's sashes
 * work:
 *  - Every open panel is pinned at the width it is drawn at.
 *  - Widening a panel takes room from the page (the chat, when a side panel is
 *    open) down to its minimum, then from the other panels in a fixed order, each
 *    down to its own minimum (`TAKES_FROM`, `shareWidth`). Narrowing gives the room
 *    to the page, never to another panel.
 *  - On release only what moved is saved: the dragged panel and any panel that
 *    gave room. The others stay held where they were drawn, with their saved
 *    widths untouched, until the window or the set of open panels changes
 *    (`dropHolds`), when the stylesheet takes over again. Without the hold a panel
 *    the stylesheet had squeezed would take back the room the drag just made.
 *  - Escape puts every panel's width back as it was.
 *
 * The limits are measured, not restated: every panel at its minimum, then this
 * one as wide as the stylesheet lets it, then all of them, which leaves the page
 * at its minimum (`measure`). Widths are written straight
 * to the DOM while dragging, so React never re-renders on a pointer move.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { clamp, dragWidth, keyWidth, readWidth, roomIn, shareWidth, writeWidth, type Bounds, type Dock, type Give } from './panelResize'

/** Where a panel keeps its width: the CSS variable its stylesheet reads, and the saved copy. */
export interface PanelWidth { cssVar: string; storageKey: string }
// `initial` is the width with nothing saved: the @property initial values in shell.css.
export const CHATS_WIDTH = { cssVar: '--sh-panel-w', storageKey: 'totem.panel.chats.width', initial: 268 }
// The terminal's key predates the shared handle; kept so a saved width carries over.
export const TERMINAL_WIDTH = { cssVar: '--term-w', storageKey: 'totem.terminal.width', initial: 520 }
export const SIDE_PANEL_VAR = '--vc-side-w'
/** The side panel's saved width, published on the shell, which keeps the page wide enough for it (shell.css). */
const SIDE_SAVED_VAR = '--side-saved'

export type PanelRole = 'chats' | 'terminal' | 'side'

/** Who gives way, in order, once the page has nothing left to spare. */
const TAKES_FROM: Record<PanelRole, PanelRole[]> = {
  side: ['terminal', 'chats'],
  chats: ['side', 'terminal'],
  terminal: ['side', 'chats'],
}

/** Fired on the window when a drag ends (kept or put back) or holds drop, for work that waited. */
export const PANEL_RESIZE_END = 'totem:panel-resize-end'

// `initial` is absent for the side panel, whose default is proportional to the chat.
interface Docked extends PanelWidth { role: PanelRole; panel: HTMLElement; target: HTMLElement; initial?: number }

const SIDE_SPLIT = '.vc-split.has-artifact:not(.artifact-wide)'

/** The open docked panels, by role. A side panel shown full width is not docked beside anything. */
function dockedPanels(): Partial<Record<PanelRole, Docked>> {
  const shell = document.querySelector<HTMLElement>('.app.shell')
  if (!shell) return {}
  const found: Partial<Record<PanelRole, Docked>> = {}
  const chats = shell.querySelector<HTMLElement>(':scope > .sh-panel')
  const term = shell.querySelector<HTMLElement>(':scope > .term-panel')
  if (chats) found.chats = { role: 'chats', ...CHATS_WIDTH, panel: chats, target: shell }
  if (term) found.terminal = { role: 'terminal', ...TERMINAL_WIDTH, panel: term, target: shell }
  const sideHandle = shell.querySelector<HTMLElement>(`:scope > .main > ${SIDE_SPLIT} > .panel-resize.inline`)
  const side = sideHandle?.nextElementSibling
  const key = sideHandle?.dataset.widthKey
  if (side instanceof HTMLElement && side.classList.contains('vc-artifact') && key) {
    found.side = { role: 'side', cssVar: SIDE_PANEL_VAR, storageKey: key, panel: side, target: side }
  }
  return found
}

/** What gives room first: the chat beside a side panel, else the page column. */
function pageOf(role: PanelRole): HTMLElement | null {
  const shell = document.querySelector('.app.shell')
  const chat = shell?.querySelector<HTMLElement>(`:scope > .main > ${SIDE_SPLIT} > .vc:first-child`)
  if (chat) return chat
  return role === 'side' ? null : shell?.querySelector<HTMLElement>(':scope > .main') ?? null
}

/** Wider than any screen: with the variable at this, a panel takes its CSS maximum. */
const MEASURE_WIDE = '100000px'

const storage = (): Storage | undefined => {
  try { return window.localStorage } catch { return undefined }
}

const RESIZE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'])

const widthOf = (el: Element | null | undefined) => (el ? Math.round(el.getBoundingClientRect().width) : 0)
const dragging = () => document.body.classList.contains('panel-resizing')

function setVarOn(el: HTMLElement | null | undefined, cssVar: string, value: string | number | null) {
  if (!el) return
  if (value === null || value === '') el.style.removeProperty(cssVar)
  else el.style.setProperty(cssVar, typeof value === 'number' ? `${value}px` : value)
}

// --- holds: panels a gesture left where they were drawn ---------------------------

/** Each held panel's variable to restore when the hold drops (its saved width), by variable. */
const holds = new Map<string, { target: HTMLElement; prev: string }>()
let holdsListening = false
/** The window's width when the holds were made: only a change to it drops them. */
let holdsWidth = 0

/** Lets the stylesheet lay every held panel out from its saved width again. */
function dropHolds() {
  if (!holds.size) return
  for (const [cssVar, h] of holds) if (h.target.isConnected) setVarOn(h.target, cssVar, h.prev)
  holds.clear()
  window.dispatchEvent(new Event(PANEL_RESIZE_END))
}

// A narrower or wider window hands the layout back to the stylesheet. A height
// change (docked devtools, an infobar) does not, and nothing does mid-drag, which
// pinned everything itself.
const onWindowResize = () => { if (!dragging() && window.innerWidth !== holdsWidth) dropHolds() }

function hold(p: Docked, prev: string, replace = false) {
  if (!holds.size) holdsWidth = window.innerWidth
  // Already held from an earlier gesture: keep the value from before that one.
  if (replace || !holds.has(p.cssVar)) holds.set(p.cssVar, { target: p.target, prev })
  if (!holdsListening) {
    holdsListening = true
    window.addEventListener('resize', onWindowResize)
  }
}

function publishSideSaved(width: number | null) {
  setVarOn(document.querySelector<HTMLElement>('.app.shell'), SIDE_SAVED_VAR, width)
}

/** The value to restore when a hold drops: the saved one, not the held one. */
const beforeHold = (p: Found) => holds.get(p.cssVar)?.prev ?? p.prev

// --- one gesture ------------------------------------------------------------------

/** A panel as a gesture found it: its variable before, its width, its minimum and its saved width. */
interface Found extends Docked, Give { prev: string; saved: number }

interface Gesture {
  self: Found
  others: Found[] // in take order
  bounds: Bounds // the room this panel has from the page alone
  top: number // all the room there is, page and other panels together
}

/** Every open panel as drawn, its minimum, and what this one may reach. Leaves the widths as they were. */
function measure(role: PanelRole): Gesture | null {
  const docked = dockedPanels()
  if (!docked[role]) return null
  const all = Object.values(docked) as Docked[]
  const found = new Map<PanelRole, Found>(all.map((p) => {
    const start = widthOf(p.panel)
    // Saved, else the default; a side panel's proportional default is what it is drawn at.
    const saved = readWidth(storage(), p.storageKey) ?? p.initial ?? start
    return [p.role, { ...p, prev: p.target.style.getPropertyValue(p.cssVar), start, min: 0, saved }]
  }))
  const self = found.get(role)!
  const page = pageOf(role)
  const pageNow = widthOf(page)
  // Every panel at its minimum, then this one as wide as it can be (its own cap,
  // such as the chats panel's, may stop it first). Then every panel as wide as it
  // can be: what that leaves of the page is the page's minimum.
  for (const p of all) p.target.style.setProperty(p.cssVar, '0px')
  for (const f of found.values()) f.min = widthOf(f.panel)
  self.target.style.setProperty(self.cssVar, MEASURE_WIDE)
  const widest = widthOf(self.panel)
  for (const p of all) p.target.style.setProperty(p.cssVar, MEASURE_WIDE)
  const pageMin = widthOf(page)
  for (const f of found.values()) setVarOn(f.target, f.cssVar, f.prev)
  const others = TAKES_FROM[role].map((r) => found.get(r)).filter((f): f is Found => !!f)
  const own = Math.max(self.min, Math.min(widest, self.start + Math.max(0, pageNow - pageMin)))
  const bounds = { min: self.min, max: own }
  return { self, others, bounds, top: Math.max(self.min, Math.min(widest, own + roomIn(others))) }
}

const pin = (g: Gesture) => [g.self, ...g.others].forEach((p) => setVarOn(p.target, p.cssVar, p.start))

function show(g: Gesture, width: number, shares: number[] | null) {
  setVarOn(g.self.target, g.self.cssVar, width)
  g.others.forEach((o, i) => setVarOn(o.target, o.cssVar, shares ? shares[i] : o.start))
}

/**
 * Ends a gesture that changed something: saves what moved, holds the rest where
 * they are drawn. The dragged panel is saved at its new width. A panel that gave
 * is saved at its saved width less what it gave, not at the width it was drawn
 * at, which the window may have squeezed; it stays held where it is drawn until
 * the stylesheet takes over again.
 */
function keep(g: Gesture, width: number, shares: number[] | null) {
  show(g, width, shares)
  const save = (p: Found, value: number) => {
    writeWidth(storage(), p.storageKey, value)
    if (p.role === 'side') publishSideSaved(value)
  }
  if (width !== g.self.start) {
    save(g.self, width)
    holds.delete(g.self.cssVar)
  } else hold(g.self, beforeHold(g.self))
  g.others.forEach((o, i) => {
    const now = shares ? shares[i] : o.start
    if (now < o.start) {
      const value = Math.max(o.min, o.saved - (o.start - now))
      save(o, value)
      hold(o, `${value}px`, true)
    } else hold(o, beforeHold(o))
  })
}

/** Ends a gesture as if it never happened. */
const putBack = (g: Gesture) => [g.self, ...g.others].forEach((p) => setVarOn(p.target, p.cssVar, p.prev))

/** Where the handle stands: free, or at one or both ends (the cursor and the line say so). */
function limitOf(now: number, g: Gesture): 'both' | 'min' | 'max' | null {
  if (g.top - g.bounds.min < 1) return 'both'
  if (now >= g.top - 0.5) return 'max'
  if (now <= g.bounds.min + 0.5) return 'min'
  return null
}

interface Drag {
  pointerId: number; startX: number; g: Gesture; width: number; shares: number[] | null
  frame: number; onKey: (e: KeyboardEvent) => void
}

interface Props extends PanelWidth {
  /** Which panel this is: where its variable lives and who gives way to it. */
  role: PanelRole
  /** Accessible name, e.g. "Resize the files panel". */
  label: string
  /** Extra class: `inline` makes the handle a zero-width flex item between two columns. */
  className?: string
}

export default function ResizeHandle({ role, storageKey, cssVar, label, className }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const starting = useRef(false)
  // Whether the limits shown may be out of date: a pointer crossing a handle whose
  // limits are current costs nothing.
  const stale = useRef(true)
  const dock: Dock = role === 'chats' ? 'left' : 'right'
  // The side panel holds its own variable; the shell's grid holds the other two.
  const hostOf = (handle: HTMLElement | null) =>
    role === 'side' ? (handle?.nextElementSibling as HTMLElement | null) : handle?.closest<HTMLElement>('.app.shell') ?? null

  const announce = useCallback((given?: Gesture | null) => {
    const handle = ref.current
    const g = given === undefined ? measure(role) : given
    if (!handle || !g) return
    const now = widthOf(g.self.panel)
    handle.setAttribute('aria-valuemin', String(g.bounds.min))
    handle.setAttribute('aria-valuemax', String(g.top))
    handle.setAttribute('aria-valuenow', String(now))
    const limit = limitOf(now, g)
    if (limit) handle.dataset.limit = limit
    else delete handle.dataset.limit
    stale.current = false
  }, [role])

  // The saved width, before the first paint; forgotten when the panel goes. A
  // panel opening or closing changes the set the holds were made for, so they go.
  useLayoutEffect(() => {
    const el = hostOf(ref.current)
    dropHolds()
    const saved = readWidth(storage(), storageKey)
    setVarOn(el, cssVar, saved)
    if (role === 'side') publishSideSaved(saved)
    return () => {
      el?.style.removeProperty(cssVar)
      if (role === 'side') publishSideSaved(null)
      holds.delete(cssVar)
      dropHolds()
    }
  }, [storageKey, cssVar, role])

  // The aria values and the limit follow the panel's width and its room, whatever
  // changed them. Measuring the room forces three layouts of the whole page (the
  // chat reflows at each), so it happens only while someone can use the answer:
  // once a frame while the pointer is over the handle (the limit picks its
  // cursor) or a key moved it, and on focus. An idle handle carries cheap bounds
  // instead, 0 to the window's width, so a screen reader browsing past it reads a
  // value inside its range (with none, Chromium clamps the value into 0–100).
  // Measured on every resize, a window resize or the chats panel opening paid it
  // for every handle on screen, every frame. Never during any panel's drag; the
  // drag's end announces.
  const engaged = useRef({ hover: false, focus: false })
  const hovered = useRef(() => {})
  useEffect(() => {
    const handle = ref.current
    const box = role === 'side' ? handle?.nextElementSibling : handle?.parentElement
    if (!handle || !box) return
    let frame = 0
    const later = () => {
      stale.current = true
      if (engaged.current.hover || engaged.current.focus) {
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (!dragging() && stale.current) announce() })
        return
      }
      handle.setAttribute('aria-valuemin', '0')
      handle.setAttribute('aria-valuemax', String(window.innerWidth))
    }
    const update = () => {
      handle.setAttribute('aria-valuenow', String(widthOf(box)))
      if (!dragging()) later()
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(box)
    const page = pageOf(role)
    if (page) observer.observe(page)
    window.addEventListener(PANEL_RESIZE_END, later)
    hovered.current = () => { if (stale.current) later() }
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener(PANEL_RESIZE_END, later) }
  }, [storageKey, announce, role])

  const finish = useCallback((commit: boolean) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    cancelAnimationFrame(d.frame)
    const handle = ref.current
    if (handle?.hasPointerCapture(d.pointerId)) handle.releasePointerCapture(d.pointerId)
    handle?.classList.remove('dragging')
    document.body.classList.remove('panel-resizing')
    window.removeEventListener('keydown', d.onKey, true)
    if (commit && (d.width !== d.g.self.start || d.shares)) keep(d.g, d.width, d.shares)
    else putBack(d.g)
    window.dispatchEvent(new Event(PANEL_RESIZE_END))
    // A drag moves room between the panels and makes none, so the limits it
    // measured at the start still hold: the handle (usually still under the
    // pointer) need not measure again on the next frame.
    announce(d.g)
  }, [announce])

  useEffect(() => () => finish(false), [finish])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return
    const handle = e.currentTarget
    const g = measure(role)
    if (!g) return
    e.preventDefault()
    announce(g)
    pin(g)
    // Escape while dragging puts every width back, and closes nothing else.
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopImmediatePropagation()
      finish(false)
    }
    drag.current = { pointerId: e.pointerId, startX: e.clientX, g, width: g.self.start, shares: null, frame: 0, onKey }
    handle.setPointerCapture(e.pointerId)
    // preventDefault above keeps focus where it was; the keys belong to the handle now.
    // The focus line is for the keyboard, though, so it stays off until a key is used.
    handle.dataset.pointer = ''
    // The gesture has just been measured; focusing must not measure it again.
    starting.current = true
    handle.focus({ preventScroll: true })
    starting.current = false
    handle.classList.add('dragging')
    // Stops text selection and keeps iframes (the canvas, previews) and the
    // terminal's canvas from swallowing the pointer mid-drag.
    document.body.classList.add('panel-resizing')
    window.addEventListener('keydown', onKey, true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    const want = dragWidth(d.g.self.start, d.startX, e.clientX, dock, { min: d.g.bounds.min, max: d.g.top })
    const next = shareWidth(want, d.g.bounds, d.g.others)
    d.width = next.width
    d.shares = next.neighbours
    if (d.frame) return
    d.frame = requestAnimationFrame(() => {
      d.frame = 0
      if (drag.current === d) show(d.g, d.width, d.shares)
    })
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === e.pointerId) finish(true)
  }

  const reset = () => {
    holds.delete(cssVar)
    setVarOn(hostOf(ref.current), cssVar, null)
    writeWidth(storage(), storageKey, null)
    if (role === 'side') publishSideSaved(null)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const handle = e.currentTarget
    if (drag.current || !RESIZE_KEYS.has(e.key)) return
    engaged.current.focus = true
    const g = measure(role)
    if (!g) return
    const next = keyWidth(e.key, e.shiftKey, g.self.start, dock, { min: g.bounds.min, max: g.top })
    if (next === null) return
    e.preventDefault()
    e.stopPropagation()
    delete handle.dataset.pointer
    if (next === 'reset') return reset()
    // One key press is one gesture, under the same rule as a drag.
    const share = shareWidth(clamp(next, { min: g.bounds.min, max: g.top }), g.bounds, g.others)
    if (share.width !== g.self.start || share.neighbours) {
      pin(g)
      keep(g, share.width, share.neighbours)
    }
    // The limits are the same after the step (room moved, none was made), so no second measure.
    announce(g)
  }

  return (
    <div
      ref={ref}
      className={`panel-resize dock-${dock}${className ? ` ${className}` : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      data-width-key={storageKey}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => finish(true)}
      onLostPointerCapture={() => finish(true)}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
      onPointerEnter={() => { engaged.current.hover = true; if (!drag.current) hovered.current() }}
      onPointerLeave={() => { engaged.current.hover = false }}
      onFocus={() => {
        // Focus a drag gave the handle is not a reader on it: that one waits for a key.
        if (starting.current) return
        engaged.current.focus = true
        announce()
      }}
      onBlur={(e) => { engaged.current.focus = false; delete e.currentTarget.dataset.pointer }}
    />
  )
}

/**
 * Publishes a panel's real width on the root as `cssVar`, for fixed-position
 * things that must clear it (the terminal's `--term-width`: the utilities
 * launcher, the running-chats panel). Setting it on the root restyles the whole
 * page, so not on every frame of any panel's drag: once when the drag ends.
 */
export function usePublishedWidth(ref: React.RefObject<HTMLElement | null>, active: boolean, cssVar: string) {
  useEffect(() => {
    const panel = ref.current
    if (!active || !panel) return
    const root = document.documentElement
    const publish = () => root.style.setProperty(cssVar, `${widthOf(panel)}px`)
    publish()
    const observer = new ResizeObserver(() => { if (!dragging()) publish() })
    observer.observe(panel)
    window.addEventListener(PANEL_RESIZE_END, publish)
    return () => {
      observer.disconnect()
      window.removeEventListener(PANEL_RESIZE_END, publish)
      root.style.removeProperty(cssVar)
    }
  }, [ref, active, cssVar])
}
