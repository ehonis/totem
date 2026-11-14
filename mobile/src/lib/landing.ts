/**
 * Landing on a thing: opening a search hit scrolls the destination to the item
 * that matched and flashes it for about a second (#261). The store and the pure
 * mapping are ported from web/src/landing.ts (same names); the scrolling and the
 * flash are the app's own, in src/ui/landing.tsx.
 *
 * The opener asks (`requestLanding('task', id)`) and navigates; the destination
 * screen's useLandOn() waits until it can show the item, scrolls to it and flashes
 * it. After LANDING_TIMEOUT_MS the request is dropped without a word. It lives in
 * memory only, so nothing flashes again after the app restarts.
 */

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
/** How long the flash shows. */
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

const APP_KINDS: Record<string, string> = { todos: 'task', goals: 'goal', lists: 'list', journal: 'journal' }

/**
 * Where a search hit's target (search/sources.mjs) lands: the kind and id a
 * destination looks for, plus what it needs to find it. Null for a target that
 * names no item.
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
 * else an anchor on its start.
 */
export function goalAnchor(extra: Record<string, string>, today: string): { type: string; start: string } | null {
  const { period, start, end } = extra
  if (!period || !start) return null
  if (end && start <= today && today <= end) return null
  return { type: period, start }
}

/**
 * Whether a row `to` is too far from row `from` for a smooth scroll: more than
 * about two screens at `perScreen` rows a screen. A far target jumps there (a
 * long animated pan uses up the flash, #266 review); a near one glides.
 */
export function farIndex(from: number, to: number, perScreen: number): boolean {
  return Math.abs(to - from) > 2 * perScreen
}

/**
 * Keep asking `locate` (which scrolls the screen to the item and returns the key
 * to flash, or null while it is not there yet) until it answers or the request
 * times out; then finish the landing and tell `onDone` (null: gave up). The
 * returned function stops asking.
 */
export function pollLanding(
  landing: Landing,
  locate: (landing: Landing) => string | null,
  onDone: (key: string | null) => void,
  { firstMs = 150, everyMs = 120, now = () => Date.now() }: { firstMs?: number; everyMs?: number; now?: () => number } = {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const step = () => {
    if (stopped) return
    const key = locate(landing)
    if (key || now() >= landing.at + LANDING_TIMEOUT_MS) {
      stopped = true
      finishLanding(landing)
      onDone(key || null)
      return
    }
    timer = setTimeout(step, everyMs)
  }
  // A beat first, so a navigation and the list's first layout have happened.
  timer = setTimeout(step, firstMs)
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}
