// notify/schedule.mjs — when should a notification actually arrive?
//
// Pure functions, no I/O, no clock of their own, for the same reason
// jobs/schedule.mjs is: every entry point takes the "now" it reasons from, so the
// awkward cases (a nudge planned at 07:15 for 18:00, quiet hours, a box that was
// asleep) are testable instead of hopeful.
//
// The timezone maths is imported rather than rewritten. There is exactly one
// correct way to turn "18:00 where the owner is" into an instant, and jobs/schedule
// already has it, DST switches and all.
import { zonedToUtc, localParts, normalizeTime } from '../jobs/schedule.mjs'

const MINUTE = 60_000
const MINUTES_PER_DAY = 24 * 60

// A fact's "natural slot" is when it can still change what the owner does. A birthday
// is useless at 9pm; a weekly-target nudge is useless at 7am when the day is
// already committed, and lands at 18:00 when the evening is still salvageable.
//
// These are defaults. Every one is a wall-clock time in the user's zone and is
// meant to be editable in Settings — they are not constants because the right
// evening slot is a personal fact, not a technical one.
export const DEFAULT_SLOTS = {
  morning: '07:15',
  midday: '12:30',
  afternoon: '15:30',
  evening: '18:00',
  night: '20:30',
}

export const SLOT_NAMES = Object.keys(DEFAULT_SLOTS)

export const DEFAULT_PLAN_SETTINGS = {
  // The setting that decides whether Totem is trusted or muted.
  //
  // It started at four, which errs quiet. It now errs loud, which is the right
  // order for a new install: the feedback log needs volume before the
  // learned weights have anything to learn from. Turn it back down once the
  // weights have opinions.
  cap: 14,
  minGapMinutes: 30,
  quietHours: { start: '22:00', end: '07:00' },
  slots: { ...DEFAULT_SLOTS },
}

export function normalizeSlots(raw) {
  const out = { ...DEFAULT_SLOTS }
  for (const name of SLOT_NAMES) {
    if (raw && raw[name] != null) out[name] = normalizeTime(raw[name], DEFAULT_SLOTS[name])
  }
  return out
}

// Quiet hours normally cross midnight (22:00 to 07:00). start === end is read as
// "no quiet hours" rather than "quiet for 24 hours", because a schedule that can
// never deliver is a trap dressed as a setting — the same reasoning that makes an
// empty day set in jobs/schedule widen to every day instead of meaning never.
export function normalizeQuietHours(raw) {
  if (raw === null || raw === false) return null
  const start = normalizeTime(raw?.start, DEFAULT_PLAN_SETTINGS.quietHours.start)
  const end = normalizeTime(raw?.end, DEFAULT_PLAN_SETTINGS.quietHours.end)
  if (start === end) return null
  return { start, end }
}

export function normalizePlanSettings(raw) {
  const cap = Math.round(Number(raw?.cap))
  const gap = Math.round(Number(raw?.minGapMinutes))
  return {
    cap: Number.isFinite(cap) ? Math.min(Math.max(cap, 0), 20) : DEFAULT_PLAN_SETTINGS.cap,
    minGapMinutes: Number.isFinite(gap) ? Math.min(Math.max(gap, 0), 12 * 60) : DEFAULT_PLAN_SETTINGS.minGapMinutes,
    quietHours: raw && 'quietHours' in raw ? normalizeQuietHours(raw.quietHours) : { ...DEFAULT_PLAN_SETTINGS.quietHours },
    slots: normalizeSlots(raw?.slots),
  }
}

const hhmmToMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

// Resolve a wall-clock time on the calendar day containing `ts`, in `tz`. Offset
// by `dayOffset` days to reach tomorrow's slot. Resolved through zonedToUtc so a
// slot on a DST switch day keeps its posted time.
export function resolveTimeOn(ts, hhmm, tz, dayOffset = 0) {
  const p = localParts(ts, tz)
  const [hour, minute] = hhmm.split(':').map(Number)
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset))
  return zonedToUtc(
    { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour, minute },
    tz,
  )
}

// The last useful instant of a local day. Facts that stop being true at midnight
// — a streak that ends tonight — expire here rather than being deferred into a
// morning where they are simply wrong.
export function endOfDay(ts, tz, dayOffset = 0) {
  return resolveTimeOn(ts, '23:59', tz, dayOffset)
}

export function slotTimeOn(ts, slot, tz, slots = DEFAULT_SLOTS, dayOffset = 0) {
  const hhmm = slots[slot] || DEFAULT_SLOTS[slot] || DEFAULT_SLOTS.morning
  return resolveTimeOn(ts, hhmm, tz, dayOffset)
}

export function inQuietHours(ts, quiet, tz) {
  if (!quiet) return false
  const p = localParts(ts, tz)
  const now = p.hour * 60 + p.minute
  const start = hhmmToMinutes(quiet.start)
  const end = hhmmToMinutes(quiet.end)
  // A window that ends before it starts crosses midnight, which is the usual case.
  return start < end ? now >= start && now < end : now >= start || now < end
}

// The first instant at or after `ts` that is not inside quiet hours. Only ever
// moves forward, which the planner depends on when it re-applies spacing.
export function nextAllowedTime(ts, quiet, tz) {
  if (!inQuietHours(ts, quiet, tz)) return ts
  // Quiet hours end at a wall-clock time today or tomorrow; try today first.
  for (const offset of [0, 1, 2]) {
    const cand = resolveTimeOn(ts, quiet.end, tz, offset)
    if (cand >= ts && !inQuietHours(cand, quiet, tz)) return cand
  }
  return ts + MINUTES_PER_DAY * MINUTE
}

// What quiet hours do to one entry. `override` is reserved for categories the owner
// chose to be interrupted by, plus the approval code, which is worthless in the morning.
export function applyQuietHours(ts, policy, quiet, tz) {
  if (!quiet || !inQuietHours(ts, quiet, tz)) return { deliverAt: ts, action: 'send' }
  if (policy === 'override') return { deliverAt: ts, action: 'send' }
  if (policy === 'suppress') return { deliverAt: ts, action: 'suppress' }
  return { deliverAt: nextAllowedTime(ts, quiet, tz), action: 'defer' }
}

// Space a set of desired instants out so several facts found in one collection
// don't arrive as a burst. Sequential and forward-only: each entry takes the later
// of what it wanted and the last one plus the gap, then is pushed clear of quiet
// hours. Because nextAllowedTime only moves forward, one pass is enough — an entry
// deferred to 07:00 can never land before the entry that preceded it.
export function spaceOut(desired, { minGapMinutes, quietHours, tz, now }) {
  const gap = Math.max(0, minGapMinutes) * MINUTE
  const out = []
  let prev = null
  // A slot already past (an evening run planning a morning fact) becomes "as soon
  // as the next drain", not a delivery dated in the past — and it is clamped
  // *before* the sort, otherwise a stale 07:15 sorts ahead of a fact whose slot is
  // genuinely now and takes the good time off it.
  const queue = desired
    .map((item) => ({ ...item, deliverAt: Math.max(item.deliverAt, now) }))
    .sort((a, b) => a.deliverAt - b.deliverAt)
  for (const item of queue) {
    let t = item.deliverAt
    if (prev != null) t = Math.max(t, prev + gap)
    const { deliverAt, action } = applyQuietHours(t, item.quietHours, quietHours, tz)
    if (action === 'suppress') {
      out.push({ ...item, deliverAt: null, action, dropped: 'quiet-hours' })
      continue
    }
    out.push({ ...item, deliverAt, action })
    prev = deliverAt
  }
  return out
}

// How stale is too stale. A reminder the box was down for is delivered late and
// says so; past the grace window it is dropped to the ledger only, because a
// six-hour-old "leave now" is worse than silence. Mirrors dueState in
// jobs/schedule.mjs deliberately — same problem, same vocabulary.
export const DEFAULT_CATCH_UP_MINUTES = 30

export function deliveryState(deliverAt, now, graceMs = DEFAULT_CATCH_UP_MINUTES * MINUTE) {
  if (!Number.isFinite(deliverAt)) return 'unscheduled'
  if (now < deliverAt) return 'pending'
  if (now - deliverAt <= graceMs) return 'due'
  return 'missed'
}

// "was due 2:00 PM" — appended to a late delivery so a nudge that arrives an hour
// after its moment doesn't read as a nudge about now.
export function lateSuffix(deliverAt, now, tz) {
  const minutes = Math.round((now - deliverAt) / MINUTE)
  if (minutes < 5) return ''
  const p = localParts(deliverAt, tz)
  const suffix = p.hour < 12 ? 'AM' : 'PM'
  const hour = p.hour % 12 === 0 ? 12 : p.hour % 12
  return `was due ${hour}:${String(p.minute).padStart(2, '0')} ${suffix}`
}

// Dedupe keys collapse "the same thing said again" without collapsing "the same
// kind of thing about something else". The window is per-category and lives with
// the categories, not here.
export function dedupeKey({ category, factKind = '', subject = '', date = '' }) {
  return [category, factKind, subject, date].filter(Boolean).join(':')
}

export const dayKey = (ts, tz) => {
  const p = localParts(ts, tz)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}
