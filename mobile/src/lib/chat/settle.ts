// Settled and snoozed chats, the way T3 Code parks threads.
//
// Settled: done with for now. The chat drops to a dimmed "Settled" shelf at the
// bottom of its list (Home, a project, or a folder: every list has its own), and
// comes back the moment the owner writes in it. A chat also settles on its own
// after `autoSettleDays` without activity, unless it is pinned, running, or the
// owner took it off the shelf by hand (settledOverride 'active'). Auto-settling
// is worked out here on read, never written, so changing the setting re-sorts
// every list at once and nothing is lost by turning it off.
//
// Snoozed: out of the way until a time. Waking is also worked out on read: a
// chat whose `snoozedUntil` has passed is back in the list, marked "Woke" until
// it is opened (opening clears the fields). A reply that finishes while the chat
// is snoozed wakes it early (the bridge sets `snoozedUntil` to that moment).
//
// The bridge stores the fields (chat/store.mjs) and clears them when a message
// is sent; everything else about them lives in this file.
import type { ChatThread } from './types'

export const HOUR_MS = 3_600_000
export const DAY_MS = 24 * HOUR_MS
const EVENING_HOUR = 18
const MORNING_HOUR = 9

export type Shelf = 'active' | 'snoozed' | 'settled'

export const isSnoozed = (t: ChatThread, now: number) => !!t.snoozedUntil && t.snoozedUntil > now

/** When a snooze ran out (or a reply woke it), while the chat hasn't been opened since; 0 otherwise. */
export const wokeAt = (t: ChatThread, now: number) => (t.snoozedUntil && t.snoozedUntil <= now ? t.snoozedUntil : 0)

/** The chat's last activity: a message, coming off the shelf, or waking up. */
export const activeAt = (t: ChatThread, now: number) => Math.max(t.updatedAt || 0, t.unsettledAt || 0, wokeAt(t, now))

/** When the chat settled (by hand, or the activity it auto-settled after); 0 if it isn't settled. */
export function settledAt(t: ChatThread, now: number, autoDays: number, live = false): number {
  if (t.settledOverride === 'settled') return t.settledAt || t.updatedAt || 1
  if (t.settledOverride === 'active' || t.pinned || live || !autoDays || isSnoozed(t, now)) return 0
  const at = activeAt(t, now)
  return now - at >= autoDays * DAY_MS ? at : 0
}

/** Snoozed wins over settled, as in T3. */
export function shelfOf(t: ChatThread, now: number, autoDays: number, live = false): Shelf {
  if (isSnoozed(t, now)) return 'snoozed'
  return settledAt(t, now, autoDays, live) ? 'settled' : 'active'
}

/** A list split into its three shelves: active newest first, snoozed soonest first, settled most recent first. */
export function shelve(threads: ChatThread[], now: number, autoDays: number, live: (id: string) => boolean = () => false) {
  const active: ChatThread[] = []
  const snoozed: ChatThread[] = []
  const settled: { t: ChatThread; at: number }[] = []
  for (const t of threads) {
    if (isSnoozed(t, now)) { snoozed.push(t); continue }
    const at = settledAt(t, now, autoDays, live(t.id))
    if (at) settled.push({ t, at })
    else active.push(t)
  }
  active.sort((a, b) => activeAt(b, now) - activeAt(a, now))
  snoozed.sort((a, b) => (a.snoozedUntil || 0) - (b.snoozedUntil || 0))
  settled.sort((a, b) => b.at - a.at || a.t.id.localeCompare(b.t.id))
  return { active, snoozed, settled: settled.map((s) => s.t) }
}

/** The earliest snooze still to run out, so a list can re-sort exactly then. */
export function nextWake(threads: ChatThread[], now: number) {
  let next = 0
  for (const t of threads) if (isSnoozed(t, now) && (!next || t.snoozedUntil! < next)) next = t.snoozedUntil!
  return next
}

// --- what a change writes -------------------------------------------------------
// Every field a change touches, so the bridge stores exactly this and an undo can
// send the old values back.

export type SettleFields = Pick<ChatThread, 'settledOverride' | 'settledAt' | 'unsettledAt' | 'snoozedUntil' | 'snoozedAt' | 'pinned' | 'needsReply' | 'keepUnread'>
const FIELDS = ['settledOverride', 'settledAt', 'unsettledAt', 'snoozedUntil', 'snoozedAt', 'pinned', 'needsReply', 'keepUnread'] as const

export const settleFieldsOf = (t: ChatThread): SettleFields => Object.fromEntries(FIELDS.map((k) => [k, t[k]])) as SettleFields

/** Settling unpins, ends any snooze, and clears "waiting on you": it's done with. */
export const settleChange = (now: number): SettleFields => ({ settledOverride: 'settled', settledAt: now, unsettledAt: undefined, snoozedUntil: undefined, snoozedAt: undefined, pinned: false, needsReply: undefined, keepUnread: undefined })

/** Off the shelf, to the top of the list, and kept there until he next writes in it. */
export const unsettleChange = (now: number): SettleFields => ({ settledOverride: 'active', settledAt: undefined, unsettledAt: now })

export const snoozeChange = (until: number, now: number): SettleFields => ({ snoozedUntil: until, snoozedAt: now })

/** Wake now (or acknowledge a wake): back in the list, at the top if it was still asleep. */
export const wakeChange = (t: ChatThread, now: number): SettleFields => ({ snoozedUntil: undefined, snoozedAt: undefined, ...(isSnoozed(t, now) ? { unsettledAt: now } : {}) })

// --- snooze presets -----------------------------------------------------------------

export interface SnoozePreset { id: string; label: string; when: string; until: number }

const atHour = (base: Date, hour: number) => { const d = new Date(base); d.setHours(hour, 0, 0, 0); return d }
// Calendar days, not 24-hour steps, so a DST change doesn't land at 8:00 or 10:00.
const addDays = (base: Date, days: number) => { const d = new Date(base); d.setDate(d.getDate() + days); return d }
export const timeLabel = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/**
 * T3's presets: in an hour, in three, this evening at 18:00 (only while that is
 * over an hour away), tomorrow at 9:00, and next Monday at 9:00 (left out on a
 * Sunday, when it would be the same as tomorrow).
 */
export function snoozePresets(now: Date): SnoozePreset[] {
  const hour = new Date(now.getTime() + HOUR_MS)
  const three = new Date(now.getTime() + 3 * HOUR_MS)
  const out: SnoozePreset[] = [
    { id: 'hour', label: 'In 1 hour', when: timeLabel(hour), until: hour.getTime() },
    { id: 'three-hours', label: 'In 3 hours', when: timeLabel(three), until: three.getTime() },
  ]
  const evening = atHour(now, EVENING_HOUR)
  if (evening.getTime() - now.getTime() > HOUR_MS) out.push({ id: 'evening', label: 'This evening', when: timeLabel(evening), until: evening.getTime() })
  const tomorrow = atHour(addDays(now, 1), MORNING_HOUR)
  out.push({ id: 'tomorrow', label: 'Tomorrow', when: timeLabel(tomorrow), until: tomorrow.getTime() })
  const nextWeek = atHour(addDays(now, (1 - now.getDay() + 7) % 7 || 7), MORNING_HOUR)
  if (nextWeek.getTime() !== tomorrow.getTime()) {
    out.push({ id: 'next-week', label: 'Next week', when: `${nextWeek.toLocaleDateString(undefined, { weekday: 'short' })} ${timeLabel(nextWeek)}`, until: nextWeek.getTime() })
  }
  return out
}

/**
 * The custom snooze form: a date and time ("2026-10-07", "14:30"), or a duration.
 * Returns the wake time, or an error to show under the form.
 */
export function customSnooze(
  input: { mode: 'date'; date: string; time: string } | { mode: 'duration'; amount: number; unit: 'minutes' | 'hours' | 'days' },
  now: number,
): { until: number } | { error: string } {
  if (input.mode === 'duration') {
    if (!Number.isFinite(input.amount) || input.amount <= 0) return { error: 'Enter a positive duration.' }
    if (input.unit === 'days') return { until: addDays(new Date(now), input.amount).getTime() }
    return { until: now + input.amount * (input.unit === 'hours' ? HOUR_MS : 60_000) }
  }
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.date)
  const t = /^(\d{1,2}):(\d{2})$/.exec(input.time)
  const bad = { error: 'Choose a valid date and time in the future.' }
  if (!d || !t) return bad
  const [y, mo, da, h, mi] = [+d[1], +d[2] - 1, +d[3], +t[1], +t[2]]
  const at = new Date(y, mo, da, h, mi, 0, 0)
  // A date that rolled over (Feb 30) or a local time a DST jump skipped.
  if (at.getFullYear() !== y || at.getMonth() !== mo || at.getDate() !== da || at.getHours() !== h || at.getMinutes() !== mi) return bad
  return at.getTime() > now ? { until: at.getTime() } : bad
}

// --- labels --------------------------------------------------------------------------

/** Time left on a snooze, rounded up: 45m, 3h, 2d. */
export function countdown(until: number, now: number) {
  const left = until - now
  if (left <= 0) return 'now'
  if (left < HOUR_MS) return `${Math.max(1, Math.ceil(left / 60_000))}m`
  if (left < DAY_MS) return `${Math.ceil(left / HOUR_MS)}h`
  return `${Math.ceil(left / DAY_MS)}d`
}

/** How long ago, compactly: now, 12m, 5h, 3d, 2w, 4mo, 1y. */
export function ago(ts: number, now: number) {
  const d = Math.max(0, now - ts)
  if (d < 60_000) return 'now'
  if (d < HOUR_MS) return `${Math.floor(d / 60_000)}m`
  if (d < DAY_MS) return `${Math.floor(d / HOUR_MS)}h`
  if (d < 14 * DAY_MS) return `${Math.floor(d / DAY_MS)}d`
  if (d < 60 * DAY_MS) return `${Math.floor(d / (7 * DAY_MS))}w`
  if (d < 365 * DAY_MS) return `${Math.floor(d / (30 * DAY_MS))}mo`
  return `${Math.floor(d / (365 * DAY_MS))}y`
}

/** A wake time for a toast or tooltip: "5:30 PM", "tomorrow 9:00 AM", "Mon 9:00 AM", "Oct 20, 9:00 AM". */
export function wakeDescription(until: number, now: number) {
  const wake = new Date(until)
  const time = timeLabel(wake)
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const days = Math.floor((until - today.getTime()) / DAY_MS)
  if (days <= 0) return time
  if (days === 1) return `tomorrow ${time}`
  if (days < 7) return `${wake.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return `${wake.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}
