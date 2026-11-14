/**
 * Landing on a thing: opening a search hit scrolls the destination to the item
 * that matched and flashes it for about a second (#261).
 *
 * The opener says where it wants to land (`requestLanding('task', id)`) and then
 * navigates. The destination view calls `useLandOn('task', …)`: once it is ready
 * it waits for the item's element (rows carry `data-land="task:<id>"`), scrolls it
 * into view and flashes it. A view still loading is waited for; after
 * LANDING_TIMEOUT_MS from the request the landing is dropped without a word.
 *
 * The request lives in memory, not the URL: a reload, Back or a shared link
 * should not flash anything again.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'

export interface Landing {
  /** What kind of item: `msg`, `task`, `goal`, `list`, `journal`, `note`, `project`, `totem`. */
  kind: string
  id: string
  /** Anything else the destination needs to find it (a list's item, a goal's period). */
  extra: Record<string, string>
  /** When it was asked for (ms), for the timeout. */
  at: number
}

export const LANDING_TIMEOUT_MS = 6000
/** How long the flash shows; the CSS animation runs for the same time. */
export const FLASH_MS = 1200

let current: Landing | null = null
const subs = new Set<() => void>()
const emit = () => { for (const fn of subs) fn() }

export function requestLanding(kind: string, id: string | null | undefined, extra: Record<string, string | null | undefined> = {}, now = Date.now()) {
  if (!id) { current = null; emit(); return }
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') clean[k] = String(v)
  const landing = { kind, id: String(id), extra: clean, at: now }
  current = landing
  emit()
  // A screen that was hidden or left mid-landing stops waiting without finishing it;
  // drop it once it times out and tell the subscribers, so nothing waits on it for good.
  const timer: any = setTimeout(() => { if (current === landing) { current = null; emit() } }, LANDING_TIMEOUT_MS + 50)
  timer?.unref?.()
}

/** The landing waiting for `kind`, unless it has timed out. */
export function pendingLanding(kind: string, now = Date.now()): Landing | null {
  if (!current || current.kind !== kind) return null
  return now - current.at > LANDING_TIMEOUT_MS ? null : current
}

/** Done with it (landed, or gave up). A newer request is left alone. */
export function finishLanding(landing: Landing) {
  if (current !== landing) return
  current = null
  emit()
}

export function subscribeLanding(fn: () => void) {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

export const landKey = (kind: string, id: string) => `${kind}:${id}`

/** The element a view marked with `data-land={landKey(kind, id)}`. */
export function findLanding(key: string, root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-land="${CSS.escape(key)}"]`)
}

/** The owner asked for less motion (Settings → Appearance), or the system did. */
export function prefersStill(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.classList.contains('reduce-motion')
    || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** Each element's pending flash removal, so a second flash is not cut short by the first's timer. */
const flashTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

/**
 * Flash an element once: a soft accent wash that fades, or with less motion a
 * static outline that clears. Restarting on an element already flashing starts it
 * over, for the full time. Never cancelled by the caller, so a class is never left behind.
 */
export function flashElement(el: HTMLElement, still = prefersStill()) {
  const earlier = flashTimers.get(el)
  if (earlier) clearTimeout(earlier)
  el.classList.remove('land-flash', 'land-flash-still')
  void el.offsetWidth
  const cls = still ? 'land-flash-still' : 'land-flash'
  el.classList.add(cls)
  flashTimers.set(el, setTimeout(() => { el.classList.remove(cls); flashTimers.delete(el) }, FLASH_MS))
}

/**
 * Whether an element is more than about two screens from the middle of the
 * viewport. A smooth scroll that far is a long pan (1.6 s through a 33,000 px
 * chat), so a far target jumps there instead and only a near one glides.
 */
export function isFar(rect: { top: number; height: number }, viewport: number): boolean {
  return Math.abs(rect.top + rect.height / 2 - viewport / 2) > 2 * viewport
}

/** A near target's smooth scroll is well under a second; this only bounds a stuck one. */
const SETTLE_MAX_MS = 1500

/**
 * Wait for `find()` to return an element, then scroll it to the middle of its
 * scroller (a jump when it is far, a smooth scroll when near, see isFar) and,
 * once it has stopped moving, flash it, so the scroll does not use up the flash. `onDone(found)` runs once, on landing or
 * at `until`. The returned function stops the waiting, not a flash under way.
 */
export function revealWhenReady(
  find: () => HTMLElement | null,
  { until, onDone, still = prefersStill() }: { until: number; onDone?: (found: boolean) => void; still?: boolean },
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  // Settled: the element has not moved for three reads in a row (a smooth scroll can
  // take a frame or two to start, so one still read is not enough).
  const settle = (el: HTMLElement, lastTop: number, stillReads: number, deadline: number) => {
    const top = el.getBoundingClientRect().top
    const reads = top === lastTop ? stillReads + 1 : 0
    if (reads >= 3 || Date.now() >= deadline) {
      flashElement(el, still)
      onDone?.(true)
      return
    }
    timer = setTimeout(() => settle(el, top, reads, deadline), 50)
  }
  const step = () => {
    if (stopped) return
    const el = find()
    if (el) {
      stopped = true
      const rect = el.getBoundingClientRect()
      const jump = still || isFar(rect, window.innerHeight || 800)
      el.scrollIntoView?.({ block: 'center', behavior: jump ? 'auto' : 'smooth' })
      const top = el.getBoundingClientRect().top
      timer = setTimeout(() => settle(el, top, 0, Date.now() + SETTLE_MAX_MS), 50)
      return
    }
    if (Date.now() >= until) { stopped = true; onDone?.(false); return }
    // A timer, not frames: a hidden tab gets no frames and would never give up.
    timer = setTimeout(step, 50)
  }
  timer = setTimeout(step, 0)
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}

/** The landing waiting for `kind`, as React state. */
export function useLanding(kind: string): Landing | null {
  return useSyncExternalStore(subscribeLanding, () => pendingLanding(kind), () => null)
}

/**
 * The destination's side. While a landing for `kind` waits and the view is
 * `ready`, `prepare` runs once (switch the tab, unfold a group, pick the list),
 * then the element is waited for, scrolled to and flashed. `find` overrides the
 * `data-land` lookup; `onMiss` runs when it never turned up.
 */
export function useLandOn(kind: string, opts: {
  ready?: boolean
  prepare?: (landing: Landing) => void
  find?: (landing: Landing) => HTMLElement | null
  onLanded?: (landing: Landing) => void
  onMiss?: (landing: Landing) => void
} = {}) {
  const landing = useLanding(kind)
  const latest = useRef(opts)
  latest.current = opts
  const ready = opts.ready ?? true
  useEffect(() => {
    if (!landing || !ready) return undefined
    latest.current.prepare?.(landing)
    return revealWhenReady(
      () => (latest.current.find ? latest.current.find(landing) : findLanding(landKey(kind, landing.id))),
      {
        until: landing.at + LANDING_TIMEOUT_MS,
        onDone: (found) => {
          finishLanding(landing)
          if (found) latest.current.onLanded?.(landing)
          else latest.current.onMiss?.(landing)
        },
      },
    )
  }, [kind, landing, ready])
  return landing
}

const APP_KINDS: Record<string, string> = { todos: 'task', goals: 'goal', lists: 'list', journal: 'journal' }

/**
 * Where a search hit's target (search/sources.mjs) lands: the kind and id a
 * destination view looks for, plus what it needs to find it. Null for a target
 * that names no item.
 */
export function hitLanding(target: Record<string, any> | null | undefined): { kind: string; id: string; extra: Record<string, string> } | null {
  const t = target || {}
  const str = (v: unknown) => (v == null || v === '' ? undefined : String(v))
  const pick = (keys: string[]) => {
    const out: Record<string, string> = {}
    for (const k of keys) { const v = str(t[k]); if (v !== undefined) out[k] = v }
    return out
  }
  if (t.tab === 'chat' && t.thread) return t.message ? { kind: 'msg', id: String(t.message), extra: {} } : null
  if (t.tab === 'chat' && t.project) return { kind: 'project', id: String(t.project), extra: pick(['section']) }
  if (t.tab === 'totems' && t.totem) return { kind: 'totem', id: String(t.totem), extra: pick(['section']) }
  if (t.tab === 'brain' && t.path) return { kind: 'note', id: String(t.path), extra: pick(['line']) }
  const kind = APP_KINDS[t.app]
  return kind && t.id ? { kind, id: String(t.id), extra: pick(['item', 'parent', 'period', 'start', 'end']) } : null
}

/**
 * The goal period window to show for a landing on a goal filed under
 * `start`…`end` (day keys): null when that is the current one (today inside it),
 * else an anchor on its start. Day keys compare as strings.
 */
export function goalAnchor(extra: Record<string, string>, today: string): { type: string; start: string } | null {
  const { period, start, end } = extra
  if (!period || !start) return null
  if (end && start <= today && today <= end) return null
  return { type: period, start }
}

/**
 * Which heading of a Markdown text starts at 1-based `line`, counting from 0 the
 * way the rendered note's h1–h6 elements are ordered; null when that line is not
 * a heading (the text before the first one). Fenced code is skipped, as
 * search/sources.mjs's markdownSections() skips it.
 */
export function headingIndexAtLine(markdown: string, line: number): number | null {
  const lines = String(markdown || '').split('\n')
  let fenced = false
  let n = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced
    const heading = !fenced && /^(#{1,6})\s+(.*)$/.test(lines[i])
    if (i + 1 === line) return heading ? n : null
    if (heading) n += 1
  }
  return null
}
