// Sub-habits: one copy for the web and the iPhone app. This file is mirrored byte
// for byte to mobile/src/lib/habits/groups.ts (mobile/src/lib/habits/groups.test.mjs
// checks it), so it imports nothing and touches no DOM or React Native.
//
// A habit may sit under one other habit (`parentId`, one level deep, checked by the
// bridge). A habit with sub-habits is a group: it has no check of its own, and its
// day is done when every sub-habit's is. Rather than teach every streak, strip,
// grid and progress bar about groups, `foldGroups` hands each group a made-up entry
// per day (`count` = sub-habits done that day) and a daily target of its sub-habit
// count, so a group reads as an ordinary daily habit everywhere it is drawn:
// full when all are done, shaded by how many, a streak of complete days. Only the
// writes differ: a group is logged with `complete` or `counts`, never a delta
// (bridge doLogHabitRecord), and the check-in asks its sub-habits, not it.

export interface GroupableHabit {
  id: string
  parentId?: string | null
  archived: boolean
  cadence: 'daily' | 'weekly' | 'monthly'
  target: number
  linkedApp?: string | null
  metric?: { source?: string } | null
  /** Set by the bridge on a habit an app or the WHOOP sync fills (its fallback id included). */
  autoFilled?: boolean
}

export interface GroupableEntry { count: number; skipped?: boolean }
export type GroupableEntries = Record<string, Record<string, GroupableEntry>>

/** A row as lists draw it: a habit and, for a group, its sub-habits in order. */
export interface HabitNode<H> { habit: H; children: H[] }

const toDate = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const toISO = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const addDays = (iso: string, n: number): string => {
  const d = toDate(iso)
  d.setDate(d.getDate() + n)
  return toISO(d)
}
// Weeks run Monday–Sunday, as everywhere else in the habit tracker.
const weekStartOf = (iso: string): string => addDays(iso, -((toDate(iso).getDay() + 6) % 7))

/** The active sub-habits of `id`, in list order. */
export function subHabitsOf<H extends GroupableHabit>(habits: H[], id: string): H[] {
  return habits.filter((h) => !h.archived && h.parentId === id)
}

/** Whether `habit` is a group: it has at least one active sub-habit. */
export function isGroup<H extends GroupableHabit>(habits: H[], habit: H | string): boolean {
  const id = typeof habit === 'string' ? habit : habit.id
  return habits.some((h) => !h.archived && h.parentId === id)
}

/**
 * The active habits as rows, in list order: each group with its sub-habits under it,
 * ungrouped habits on their own. A sub-habit whose group is missing or archived is a
 * row of its own (the bridge already sends those with no parent).
 */
export function habitTree<H extends GroupableHabit>(habits: H[]): HabitNode<H>[] {
  const active = habits.filter((h) => !h.archived)
  const ids = new Set(active.map((h) => h.id))
  const rows: HabitNode<H>[] = []
  for (const h of active) {
    if (h.parentId && ids.has(h.parentId)) continue
    rows.push({ habit: h, children: active.filter((c) => c.parentId === h.id) })
  }
  return rows
}

/** The ids to send to POST /api/habits/reorder after moving top-level rows: each group's sub-habits follow it. */
export function flattenTree<H extends GroupableHabit>(rows: HabitNode<H>[]): string[] {
  return rows.flatMap((r) => [r.habit.id, ...r.children.map((c) => c.id)])
}

function periodTotal(h: GroupableHabit, entries: GroupableEntries, date: string): number {
  if (h.cadence === 'weekly') {
    const start = weekStartOf(date)
    let t = 0
    for (let i = 0; i < 7; i++) t += entries[addDays(start, i)]?.[h.id]?.count || 0
    return t
  }
  if (h.cadence === 'monthly') {
    const ym = date.slice(0, 7)
    let t = 0
    for (const [d, day] of Object.entries(entries)) if (d.startsWith(ym)) t += day[h.id]?.count || 0
    return t
  }
  return entries[date]?.[h.id]?.count || 0
}

/**
 * Whether a sub-habit counts as done on `date`: a daily one at its target that day;
 * a weekly or monthly one on a day it was logged, or once its period's quota is met.
 */
export function subHabitDone(h: GroupableHabit, entries: GroupableEntries, date: string): boolean {
  const count = entries[date]?.[h.id]?.count || 0
  if (h.cadence === 'daily') return count >= Math.max(1, h.target)
  return count > 0 || periodTotal(h, entries, date) >= Math.max(1, h.target)
}

/** Ticked by hand: not filled in by an app or by the WHOOP sleep sync, so a group's check may write it. */
export function handLogged(h: GroupableHabit): boolean {
  return !h.autoFilled && !h.linkedApp && h.metric?.source !== 'whoop-sleep'
}

/**
 * Whether a row is done on `date`: a group once every sub-habit is, any other
 * habit as subHabitDone says. Every count of "N of M done" uses this, so the
 * Habits page, the Overview and the app's hub tile agree.
 */
export function rowDone<H extends GroupableHabit>(habits: H[], row: HabitNode<H>, entries: GroupableEntries, date: string): boolean {
  if (!row.children.length) return subHabitDone(row.habit, entries, date)
  const { done, total } = groupProgress(habits, row.habit.id, entries, date)
  return total > 0 && done >= total
}

/** How many of a group's sub-habits are done on `date`, of how many. */
export function groupProgress<H extends GroupableHabit>(habits: H[], groupId: string, entries: GroupableEntries, date: string): { done: number; total: number } {
  const subs = subHabitsOf(habits, groupId)
  return { done: subs.filter((s) => subHabitDone(s, entries, date)).length, total: subs.length }
}

/**
 * The payload as every view reads it. Each group becomes a daily habit whose target
 * is its sub-habit count, and gets one entry per day it has anything to show: `count`
 * sub-habits done (subHabitDone, so a weekly one counts on every day its quota is
 * met), `skipped` when every sub-habit was answered and none was done. Pass the
 * bridge's `today` as `through` so a day done only by a met quota, with no entry of
 * its own, still shows. A group's own entries in the file (from before it had
 * sub-habits) are replaced. Returns the same objects when there are no groups.
 */
export function foldGroups<H extends GroupableHabit, E extends GroupableEntries>(habits: H[], entries: E, through?: string): { habits: H[]; entries: E } {
  const groups = habits.filter((h) => !h.archived && isGroup(habits, h))
  if (!groups.length) return { habits, entries }
  const subsOf = new Map(groups.map((g) => [g.id, subHabitsOf(habits, g.id)]))
  const folded = habits.map((h) => {
    const subs = subsOf.get(h.id)
    return subs ? { ...h, cadence: 'daily' as const, target: subs.length } : h
  })
  // Days a met weekly or monthly quota can complete without an entry: from the period
  // holding the first entry of such a sub-habit to `through`.
  const dates = new Set(Object.keys(entries))
  const periodic = new Set(groups.flatMap((g) => subsOf.get(g.id)!.filter((s) => s.cadence !== 'daily').map((s) => s.id)))
  const firsts = Object.keys(entries).filter((d) => Object.keys(entries[d]).some((id) => periodic.has(id))).sort()
  // From the start of that entry's week or month, whichever is earlier: a quota met
  // on Wednesday completes the Monday and Tuesday before it too.
  const from = firsts.length ? [weekStartOf(firsts[0]), `${firsts[0].slice(0, 7)}-01`].sort()[0] : ''
  if (through && from) for (let d = from; d <= through; d = addDays(d, 1)) dates.add(d)
  // subHabitDone, with each week's or month's total worked out once: a year of days
  // otherwise re-adds the same period for every day of it.
  const totals = new Map<string, number>()
  const doneThen = (s: GroupableHabit, date: string): boolean => {
    const count = entries[date]?.[s.id]?.count || 0
    if (s.cadence === 'daily') return count >= Math.max(1, s.target)
    if (count > 0) return true
    const key = `${s.id}|${s.cadence === 'weekly' ? weekStartOf(date) : date.slice(0, 7)}`
    if (!totals.has(key)) totals.set(key, periodTotal(s, entries, date))
    return totals.get(key)! >= Math.max(1, s.target)
  }
  const out: GroupableEntries = {}
  for (const date of dates) {
    const day = entries[date] || {}
    const next: Record<string, GroupableEntry> = { ...day }
    for (const g of groups) {
      delete next[g.id]
      const subs = subsOf.get(g.id)!
      const done = subs.filter((s) => doneThen(s, date)).length
      if (!done && !subs.some((s) => day[s.id])) continue
      const allNo = !done && subs.every((s) => day[s.id]?.skipped)
      next[g.id] = allNo ? { count: 0, skipped: true } : { count: done }
    }
    if (Object.keys(next).length) out[date] = next
  }
  return { habits: folded, entries: out as E }
}

/**
 * What logging a group's check does on `date`: mark every hand-logged sub-habit done
 * when any is still open, else clear what they logged that day. `complete` is also
 * what the check says it will do, so its label and its tap never disagree. A weekly or monthly
 * sub-habit whose quota is already met is left as it is (the bridge does the same).
 * `undo` is the body that puts the day back; `changes` is false when the tap would
 * write nothing, and `loggable` false when no sub-habit is ticked by hand.
 */
export function groupToggle<H extends GroupableHabit>(habits: H[], groupId: string, entries: GroupableEntries, date: string): {
  complete: boolean
  /** POST /api/habits/log body that undoes this tap, a check-in "No" included. */
  undo: { id: string; date: string; counts: Record<string, number>; skips?: string[] }
  /** The counts the tap leaves, per hand-logged sub-habit, for drawing it at once. */
  next: Record<string, number>
  changes: boolean
  loggable: boolean
  /** Sub-habits an app or the WHOOP sync fills, which the tap leaves alone. */
  others: number
} {
  const subs = subHabitsOf(habits, groupId).filter(handLogged)
  const complete = subs.some((s) => !subHabitDone(s, entries, date))
  const counts: Record<string, number> = {}
  const next: Record<string, number> = {}
  for (const s of subs) {
    const have = entries[date]?.[s.id]?.count || 0
    const met = s.cadence !== 'daily' && periodTotal(s, entries, date) >= Math.max(1, s.target)
    counts[s.id] = have
    next[s.id] = complete ? Math.max(have, s.cadence === 'daily' ? Math.max(1, s.target) : met ? have : 1) : 0
  }
  const changes = subs.some((s) => next[s.id] !== counts[s.id])
  const skips = subs.filter((s) => !counts[s.id] && entries[date]?.[s.id]?.skipped).map((s) => s.id)
  const undo = skips.length ? { id: groupId, date, counts, skips } : { id: groupId, date, counts }
  const others = subHabitsOf(habits, groupId).length - subs.length
  return { complete, undo, next, changes, loggable: subs.length > 0, others }
}

/**
 * The words for a group's check, one copy for every screen: what a tap will do, and
 * what it did. When some sub-habits fill in from their apps, both say so, so a tap
 * that leaves the group at 1 of 2 never claims it was marked done.
 */
export function groupWords(name: string, t: { complete: boolean; others: number; loggable?: boolean; changes?: boolean }, done: number, total: number): { action: string; result: string } {
  const apps = t.others === 1 ? 'its app' : 'their apps'
  if (t.loggable === false) return { action: `${name}: ${done} of ${total} done, filled in by ${apps}`, result: '' }
  // Done by quotas met on other days: nothing of that day's to clear.
  if (!t.complete && t.changes === false) {
    return { action: done >= total ? `${name}: all ${total} done` : `${name}: ${done} of ${total} done; ${t.others} fill${t.others === 1 ? 's' : ''} in from ${apps}`, result: '' }
  }
  if (!t.complete) return { action: `${name}: ${done} of ${total} done. Clear what was ticked`, result: `Cleared ${name}.` }
  if (!t.others) return { action: `Mark all of ${name} done, ${done} of ${total} so far`, result: `Marked ${name} done.` }
  return {
    action: `Tick the rest of ${name}, ${done} of ${total} so far; ${t.others} fill${t.others === 1 ? 's' : ''} in from ${apps}`,
    result: `Ticked ${name}; ${t.others} still fill${t.others === 1 ? 's' : ''} in from ${apps}.`,
  }
}
