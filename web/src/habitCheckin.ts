// The morning check-in, as WHOOP's journal does it: on the first open of the day
// (after 4am, so a late night is still "today"), ask about the habits that were
// not answered yesterday, which includes the night ones done late and answered
// now, and today's morning ones. Pure, so the web and the app
// (mobile/src/lib/habitCheckin.ts) share it.

export const CHECKIN_FROM_HOUR = 4

export interface CheckinItem {
  habit: any
  /** The day the answer is logged against. */
  date: string
  part: 'yesterday' | 'today'
  /** The group a sub-habit sits in, so the sheet can say "Nightly routine · Stretch". */
  group?: string
}

export function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Ticked or answered "no" in an earlier check-in. */
export function answered(entries: any, date: string, habitId: string): boolean {
  const e = entries?.[date]?.[habitId]
  return !!e && (e.count > 0 || e.skipped === true)
}

/** Monday of the week holding `iso` (weeks run Monday to Sunday, as on the Habits tab). */
function weekStart(iso: string): string {
  const dow = (new Date(`${iso}T12:00:00`).getDay() + 6) % 7
  return shiftDate(iso, -dow)
}

/**
 * A habit's count over the period holding `date` (its week, Monday to Sunday,
 * or its calendar month), leaving out `skip` if given.
 */
export function periodCount(h: any, entries: any, date: string, skip = ''): number {
  const on = (d: string) => (d === skip ? 0 : entries?.[d]?.[h.id]?.count || 0)
  if (h.cadence === 'weekly') {
    const start = weekStart(date)
    let total = 0
    for (let i = 0; i < 7; i++) total += on(shiftDate(start, i))
    return total
  }
  if (h.cadence === 'monthly') {
    const ym = date.slice(0, 7)
    let total = 0
    for (const d of Object.keys(entries || {})) if (d.startsWith(ym)) total += on(d)
    return total
  }
  return on(date)
}

/**
 * Whether a weekly or monthly habit still owes anything in the period holding
 * `date`: once the quota is met there is nothing to ask, but the day being
 * answered never hides its own row.
 */
export function stillOwed(h: any, entries: any, date: string): boolean {
  if (h.cadence !== 'weekly' && h.cadence !== 'monthly') return true
  return periodCount(h, entries, date, date) < (h.target || 1)
}

/** A weekly or monthly row's progress, "2/4 this week", so it is not read as a daily one. */
export function periodNote(item: CheckinItem, entries: any): string {
  const h = item.habit
  if (h.cadence !== 'weekly' && h.cadence !== 'monthly') return ''
  const weekly = h.cadence === 'weekly'
  // Yesterday may close its period (Sunday's week seen on Monday, the 31st on the 1st).
  const next = shiftDate(item.date, 1)
  const ended = item.part === 'yesterday' && (weekly ? weekStart(next) !== weekStart(item.date) : next.slice(0, 7) !== item.date.slice(0, 7))
  return `${periodCount(h, entries, item.date)}/${h.target || 1} ${ended ? 'last' : 'this'} ${weekly ? 'week' : 'month'}`
}

/** Habits the owner answers by hand: not filled by an app, not by a WHOOP-style sync. */
export function askable(h: any): boolean {
  if (h.archived || h.linkedApp) return false
  if (h.metric?.source && h.metric.source !== 'manual') return false
  return true
}

/**
 * What the check-in asks about. `includeAnswered` keeps rows already answered
 * (the open sheet shows them ticked rather than having them vanish under a thumb).
 */
export function checkinItems(payload: any, includeAnswered = false): { today: string; yesterday: string; items: CheckinItem[] } {
  const today: string = payload?.today || ''
  const yesterday = today ? shiftDate(today, -1) : ''
  const all: any[] = payload?.habits || []
  // A group (a habit with active sub-habits) has no check of its own: its sub-habits are asked.
  const groupIds = new Set(all.filter((h) => !h.archived && h.parentId).map((h) => h.parentId))
  const names = new Map(all.map((h) => [h.id, h.name]))
  const habits: any[] = all.filter((h) => askable(h) && !groupIds.has(h.id))
  const entries = payload?.entries || {}
  const items: CheckinItem[] = []
  if (!today) return { today, yesterday, items }
  const item = (h: any, date: string, part: 'yesterday' | 'today'): CheckinItem => (
    h.parentId && names.has(h.parentId) ? { habit: h, date, part, group: names.get(h.parentId) } : { habit: h, date, part }
  )
  for (const h of habits) {
    // A morning habit belongs to its own morning, asked below; yesterday's was yesterday's question.
    if (h.when === 'morning') continue
    if (String(h.createdAt || '').slice(0, 10) > yesterday) continue
    // A weekly or monthly habit is asked about until its quota for the period is met.
    if (!stillOwed(h, entries, yesterday)) continue
    if (includeAnswered || !answered(entries, yesterday, h.id)) items.push(item(h, yesterday, 'yesterday'))
  }
  for (const h of habits) {
    if (h.when !== 'morning') continue
    if (!stillOwed(h, entries, today)) continue
    if (includeAnswered || !answered(entries, today, h.id)) items.push(item(h, today, 'today'))
  }
  return { today, yesterday, items }
}

/** Pop the check-in up: past 4am, not yet shown today on any device, and something to ask. */
export function shouldOpenCheckin(payload: any, now = new Date()): boolean {
  if (!payload?.today || now.getHours() < CHECKIN_FROM_HOUR) return false
  if (payload.checkin?.lastShown === payload.today) return false
  return checkinItems(payload).items.length > 0
}
