// The morning check-in, as WHOOP's journal does it: on the first open of the day
// (after 4am, so a late night is still "today"), ask about the habits that were
// not answered yesterday, which includes the night ones done late and answered
// now, and today's morning ones. Pure; a copy of web/src/habitCheckin.ts.

export const CHECKIN_FROM_HOUR = 4

export interface CheckinItem {
  habit: any
  /** The day the answer is logged against. */
  date: string
  part: 'yesterday' | 'today'
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
  const habits: any[] = (payload?.habits || []).filter(askable)
  const entries = payload?.entries || {}
  const items: CheckinItem[] = []
  if (!today) return { today, yesterday, items }
  for (const h of habits) {
    // Daily habits are owed every day; a weekly or monthly one only when it has a time of day.
    if (h.cadence !== 'daily' && (h.when || 'any') === 'any') continue
    // A morning habit belongs to its own morning, asked below; yesterday's was yesterday's question.
    if (h.when === 'morning') continue
    if (String(h.createdAt || '').slice(0, 10) > yesterday) continue
    if (includeAnswered || !answered(entries, yesterday, h.id)) items.push({ habit: h, date: yesterday, part: 'yesterday' })
  }
  for (const h of habits) {
    if (h.when !== 'morning') continue
    if (includeAnswered || !answered(entries, today, h.id)) items.push({ habit: h, date: today, part: 'today' })
  }
  return { today, yesterday, items }
}

/** Pop the check-in up: past 4am, not yet shown today on any device, and something to ask. */
export function shouldOpenCheckin(payload: any, now = new Date()): boolean {
  if (!payload?.today || now.getHours() < CHECKIN_FROM_HOUR) return false
  if (payload.checkin?.lastShown === payload.today) return false
  return checkinItems(payload).items.length > 0
}
