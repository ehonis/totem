// notify/signals.mjs — the facts a digest is allowed to talk about.
//
// Every collector is a pure function over state Totem already holds, returning
// typed facts with a salience, a natural slot, and a revalidation key. Nothing
// here is inferred by a model. That is what makes "remember it's your mom's
// birthday" a guarantee rather than a hope: the model's only job is to write the
// sentence, and it is handed the fact.
//
// A fact:
//   { kind, category, salience, slot, subject, title, body, url,
//     revalidate: { collector, identity, factKey }, resolvedTitle? }
//
// The two revalidation keys do different jobs, and keeping them apart is what
// stops a planned notification going out of date. `identity` says WHICH
// notification this is ("the near-complete nudge for this goal today") and holds
// no numbers. `factKey` says what was true when it was planned, numbers and all.
// At delivery, identity matching with a different factKey means the fact moved —
// re-worded and sent, rather than sent stale. See notify/revalidate.mjs.
import { localParts } from '../jobs/schedule.mjs'
import { dayKey, endOfDay } from './schedule.mjs'
import { fitTitle, bodyOf } from './text.mjs'

// ---------------------------------------------------------------------------
// Birthdays — data/brain/people/people.md
// ---------------------------------------------------------------------------

// People lines look like:
//   - 2026-06-18 | Marion Keller | mother | Lives nearby. ... Birthday 1961-09-11.
// The same person can appear on several lines as memory accumulates; only some
// carry a birthday, so the parse keeps the first birthday seen per name rather
// than the last line seen.
export function parsePeople(markdown) {
  const byName = new Map()
  for (const raw of String(markdown || '').split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('- ')) continue
    const parts = line.slice(2).split('|').map((p) => p.trim())
    if (parts.length < 3) continue
    const [, name, relation, ...rest] = parts
    if (!name) continue
    const body = rest.join(' | ')
    const m = body.match(/\bBirthday\s+(\d{4})-(\d{2})-(\d{2})\b/i)
    const existing = byName.get(name)
    if (existing?.birthday) continue
    byName.set(name, {
      name,
      relation: relation || '',
      birthday: m ? { year: +m[1], month: +m[2], day: +m[3] } : existing?.birthday || null,
    })
  }
  return [...byName.values()]
}

// "your mom" reads like a person talking; "your mother (relation: mother)" does
// not. Anything unmapped falls back to the relation as written, which is already
// human text.
const RELATION_WORDS = {
  mother: 'your mom',
  father: 'your dad',
  brother: 'your brother',
  sister: 'your sister',
  partner: null, // Robin is "Robin", not "your partner"
}

function describePerson(person) {
  const word = RELATION_WORDS[person.relation.toLowerCase()]
  if (word === null) return person.name
  if (word) return `${word}, ${person.name.split(' ')[0]},`
  return person.name
}

export function birthdayFacts({ people = [], now, tz, leadDays = [7] }) {
  const today = localParts(now, tz)
  const out = []
  for (const person of people) {
    if (!person.birthday) continue
    const days = daysUntilAnniversary(person.birthday, today)
    if (days === 0) {
      const age = today.year - person.birthday.year
      out.push({
        kind: 'birthday.today',
        category: 'person.birthday',
        salience: 100,
        slot: 'morning',
        subject: person.name,
        // Short label, detail in the body: iOS truncates a title around 34
        // characters and always cuts the end. See notify/text.mjs.
        title: fitTitle(`${person.name.split(' ')[0]} turns ${age} today`),
        body: bodyOf(`${describePerson(person)} turns ${age} today.`),
        url: '/brain',
        expiresAt: endOfDay(now, tz),
        revalidate: {
          collector: 'birthdays',
          // Identity and fact key are the same string here: a birthday has no
          // number that can move under it. See notify/revalidate.mjs.
          identity: `birthday:${person.name}:${dayKey(now, tz)}`,
          factKey: `birthday:${person.name}:${dayKey(now, tz)}`,
        },
      })
    } else if (leadDays.includes(days)) {
      out.push({
        kind: 'birthday.upcoming',
        category: 'person.birthday',
        salience: 70,
        slot: 'morning',
        subject: person.name,
        title: fitTitle(`${person.name.split(' ')[0]}'s birthday in ${days} days`),
        body: bodyOf(`${describePerson(person)} birthday is ${days} days out — enough time to get something.`),
        url: '/brain',
        expiresAt: endOfDay(now, tz),
        revalidate: {
          collector: 'birthdays',
          identity: `birthday-lead:${person.name}:${dayKey(now, tz)}`,
          factKey: `birthday-lead:${person.name}:${dayKey(now, tz)}`,
        },
      })
    }
  }
  return out
}

// Days from today to the next occurrence of a month/day. Feb 29 falls back to
// Mar 1 in a common year rather than silently never occurring.
export function daysUntilAnniversary(birthday, today) {
  const thisYear = anniversaryInYear(birthday, today.year)
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day)
  const diff = Math.round((thisYear - todayUtc) / 86_400_000)
  if (diff >= 0) return diff
  const next = anniversaryInYear(birthday, today.year + 1)
  return Math.round((next - todayUtc) / 86_400_000)
}

function anniversaryInYear(birthday, year) {
  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  if (birthday.month === 2 && birthday.day === 29 && !isLeap(year)) return Date.UTC(year, 2, 1)
  return Date.UTC(year, birthday.month - 1, birthday.day)
}

// ---------------------------------------------------------------------------
// Habits — data/habits.json
// ---------------------------------------------------------------------------

const dateKeyUtc = (ms) => new Date(ms).toISOString().slice(0, 10)

function metTarget(entry, target) {
  return Number(entry?.count || 0) >= Math.max(1, Number(target) || 1)
}

// Consecutive days met, counting back from (and excluding) `fromDay`.
export function streakBefore(entries, habitId, target, fromDayMs) {
  let streak = 0
  for (let i = 1; i <= 400; i++) {
    const key = dateKeyUtc(fromDayMs - i * 86_400_000)
    if (!metTarget(entries?.[key]?.[habitId], target)) break
    streak++
  }
  return streak
}

// The week runs Monday to Sunday — the same week goals/periods.mjs cuts, the habit
// grid draws, and Bushido's quotas have always used. (It ran Sunday to Saturday until
// 2026-09-20; the scheduler's 0-6 weekday convention is unchanged, only what counts
// as "this week" moved.) Returns { count, daysLeft } where daysLeft includes today —
// "one more, and you have tonight" is a different message from "one more, and the
// week is over".
export function weekProgress(entries, habitId, target, now, tz) {
  const p = localParts(now, tz)
  const todayUtc = Date.UTC(p.year, p.month - 1, p.day)
  const dayOfWeek = (p.weekday + 6) % 7 // 0 = Monday … 6 = Sunday
  const weekStart = todayUtc - dayOfWeek * 86_400_000
  // "4 per week" counts occurrences, so a day logged twice counts twice.
  let count = 0
  for (let i = 0; i <= dayOfWeek; i++) {
    const entry = entries?.[dateKeyUtc(weekStart + i * 86_400_000)]?.[habitId]
    count += Math.max(0, Number(entry?.count || 0))
  }
  return { count, daysLeft: 7 - dayOfWeek, weekStart: dateKeyUtc(weekStart) }
}

export function habitFacts({ habits = [], entries = {}, now, tz }) {
  const p = localParts(now, tz)
  const today = dayKey(now, tz)
  const todayUtc = Date.UTC(p.year, p.month - 1, p.day)
  const out = []

  for (const habit of habits) {
    const target = Math.max(1, Number(habit.target) || 1)
    const loggedToday = metTarget(entries?.[today]?.[habit.id], habit.cadence === 'daily' ? target : 1)

    if (habit.cadence === 'daily') {
      if (loggedToday) continue
      const streak = streakBefore(entries, habit.id, target, todayUtc)
      // A one-day streak is not a streak, and nobody needs telling about it.
      if (streak < 2) continue
      out.push({
        kind: 'habit.streak-ending',
        category: 'habit.slipping',
        salience: Math.min(40 + streak * 3, 85),
        slot: 'evening',
        subject: habit.id,
        title: fitTitle('Streak ends tonight', habit.name),
        body: `${habit.name} — ${streak} days running, and not logged yet today.`,
        url: '/productivity/habits',
        // Worthless after midnight: by then the streak has already broken.
        expiresAt: endOfDay(now, tz),
        revalidate: {
          collector: 'habits',
          identity: `daily:${habit.id}:${today}`,
          factKey: `daily:${habit.id}:${today}`,
        },
        resolvedTitle: fitTitle('Streak intact', habit.name),
      })
      continue
    }

    if (habit.cadence === 'weekly' && target > 1) {
      const { count, daysLeft, weekStart } = weekProgress(entries, habit.id, target, now, tz)
      const remaining = target - count
      if (remaining <= 0) continue

      // Within reach, with time to act: the nudge that pushes toward a finish
      // rather than reporting a slip.
      if (remaining <= 2 && remaining <= daysLeft) {
        out.push({
          kind: 'habit.near-target',
          category: 'goal.nearcomplete',
          salience: 55 + (2 - remaining) * 10 + (remaining === daysLeft ? 15 : 0),
          slot: 'evening',
          subject: habit.id,
          title: fitTitle(remaining === 1 ? 'One more to finish' : `${remaining} more to finish`, habit.name),
          body: `${habit.name} — ${count} of ${target} so far, ${daysLeft} day${daysLeft === 1 ? '' : 's'} left including today.`,
          url: '/productivity/habits',
          // Still useful tomorrow, useless once the week is over.
          expiresAt: endOfDay(now, tz, daysLeft - 1),
          // Identity is the nudge ("this habit, this week"); the count lives in
          // the fact key, so logging a third of four re-words this rather than
          // silencing it.
          revalidate: {
            collector: 'habits',
            identity: `weekly:${habit.id}:${weekStart}`,
            factKey: `weekly:${habit.id}:${weekStart}:${count}`,
          },
          resolvedTitle: fitTitle('Done for the week', habit.name),
        })
        continue
      }

      // Behind pace and not within reach: worth saying once, without pretending
      // it is still achievable.
      if (remaining > daysLeft) {
        out.push({
          kind: 'habit.behind-pace',
          category: 'habit.slipping',
          salience: 45,
          slot: 'night',
          subject: habit.id,
          title: fitTitle('Short this week', habit.name),
          body: `${habit.name} — ${count} of ${target}, with ${daysLeft} day${daysLeft === 1 ? '' : 's'} left.`,
          url: '/productivity/habits',
          expiresAt: endOfDay(now, tz, daysLeft - 1),
          revalidate: {
            collector: 'habits',
            identity: `weekly-behind:${habit.id}:${weekStart}`,
            factKey: `weekly-behind:${habit.id}:${weekStart}:${count}`,
          },
        })
      }
    }
  }

  return out
}

// A metric habit trending away from its goal. Deliberately requires a run of days
// rather than one bad night — a single low sleep score is weather, not a trend,
// and being told about it is the fastest way to have notifications switched off.
export function metricFacts({ habits = [], entries = {}, now, tz, days = 7, minBad = 4 }) {
  const p = localParts(now, tz)
  const todayUtc = Date.UTC(p.year, p.month - 1, p.day)
  const out = []

  for (const habit of habits) {
    const goal = Number(habit.metric?.goal)
    if (!Number.isFinite(goal)) continue
    const higherIsBetter = (habit.metric?.direction || 'higher') === 'higher'

    const values = []
    for (let i = 0; i < days; i++) {
      const v = Number(entries?.[dateKeyUtc(todayUtc - i * 86_400_000)]?.[habit.id]?.value)
      if (Number.isFinite(v)) values.push(v)
    }
    if (values.length < minBad) continue

    const bad = values.filter((v) => (higherIsBetter ? v < goal : v > goal))
    if (bad.length < minBad) continue

    const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length)
    out.push({
      kind: 'metric.off-goal',
      category: 'goal.slipping',
      salience: 50 + Math.min(bad.length * 3, 20),
      slot: 'night',
      subject: habit.id,
      title: fitTitle('Under goal', habit.name),
      body: `${habit.name} — ${bad.length} of the last ${values.length} days below ${goal}${habit.metric?.unit || ''}, averaging ${avg}.`,
      url: '/productivity/habits',
      expiresAt: endOfDay(now, tz),
      revalidate: {
        collector: 'metrics',
        identity: `metric:${habit.id}:${dayKey(now, tz)}`,
        factKey: `metric:${habit.id}:${dayKey(now, tz)}:${bad.length}:${avg}`,
      },
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// Goals — data/todos.db, via goals/service.mjs
// ---------------------------------------------------------------------------

// Facts about the week's goals, from the DTOs the goal service already builds. Pure
// over what it is handed, like every collector here — the caller does the reading.
//
// Four things are worth interrupting for, and nothing else is:
//
//   1. Nearly there, with time left. The nudge that finishes something.
//   2. Out of time today. Worthless tomorrow, so it expires tonight.
//   3. The window closed and it is still sitting there. Nothing rolls a goal over on
//      its own, which is exactly why this has to be said out loud.
//   4. Moved three or more times. The most important one: a goal pushed four weeks
//      running is a decision nobody has said aloud, and `postponedCount` is the only
//      record that it happened.
//
// A goal with an unreadable connector-fed metric raises nothing at all. Its progress
// is unknown, not bad, and a nudge built on a number nobody could read would be noise
// dressed up as a fact.
export function goalFacts({ goals = null, now, tz }) {
  if (!goals) return []
  const out = []
  const today = dayKey(now, tz)

  for (const goal of goals) {
    if (goal.complete) continue
    // Unknown is not behind. See the header.
    if (goal.progress?.fraction === null || goal.progress?.fraction === undefined) continue

    const percent = goal.progress.percent ?? 0

    if (goal.postponedCount >= 3) {
      out.push({
        kind: 'goal.repeatedly-postponed',
        category: 'goal.slipping',
        // Rises with each move, because each one makes the question more overdue.
        salience: Math.min(60 + goal.postponedCount * 5, 90),
        slot: 'night',
        subject: goal.id,
        title: `"${goal.title}" has moved ${goal.postponedCount} times`,
        body: `You have pushed this to a later ${goal.period.type} ${goal.postponedCount} times. Is it still a goal?`,
        url: '/productivity/goals',
        revalidate: {
          collector: 'goals',
          identity: `postponed:${goal.id}`,
          factKey: `postponed:${goal.id}:${goal.postponedCount}`,
        },
      })
      continue
    }

    if (goal.periodState === 'expired') {
      out.push({
        kind: 'goal.expired',
        category: 'goal.slipping',
        salience: 65,
        slot: 'night',
        subject: goal.id,
        title: `"${goal.title}" ran out of ${goal.period.type}`,
        body: `${goal.period.label} is over and this is still open at ${percent}%. Nothing moves it for you.`,
        url: '/productivity/goals',
        revalidate: {
          collector: 'goals',
          identity: `expired:${goal.id}:${goal.period.key}`,
          factKey: `expired:${goal.id}:${goal.period.key}:${percent}`,
        },
      })
      continue
    }

    if (goal.periodState !== 'active') continue

    // Close enough that one more session finishes it, with the time to do it.
    if (percent >= 70 && goal.daysLeft <= 3) {
      out.push({
        kind: 'goal.near-complete',
        category: 'goal.nearcomplete',
        salience: 55 + Math.round((percent - 70) / 2) + (goal.daysLeft <= 1 ? 15 : 0),
        slot: 'evening',
        subject: goal.id,
        title: `"${goal.title}" is at ${percent}%`,
        body: `${goal.daysLeft} day${goal.daysLeft === 1 ? '' : 's'} left on ${goal.period.label}. One more push finishes it.`,
        url: '/productivity/goals',
        expiresAt: endOfDay(now, tz),
        // The percentage is in the fact key, not just the sentence. Planned at
        // 07:15 for 18:00, this is the entry a ride at lunchtime used to leave
        // stating the morning's number.
        revalidate: {
          collector: 'goals',
          identity: `near:${goal.id}:${today}`,
          factKey: `near:${goal.id}:${today}:${percent}`,
        },
        resolvedTitle: `"${goal.title}" done`,
      })
      continue
    }

    // Last day, and not close. Said tonight or not at all.
    if (goal.daysLeft <= 1) {
      out.push({
        kind: 'goal.last-day',
        category: 'goal.slipping',
        salience: 50,
        slot: 'evening',
        subject: goal.id,
        title: `Last day for "${goal.title}"`,
        body: `${goal.period.label} ends today and this is at ${percent}%.`,
        url: '/productivity/goals',
        expiresAt: endOfDay(now, tz),
        revalidate: {
          collector: 'goals',
          identity: `lastday:${goal.id}:${today}`,
          factKey: `lastday:${goal.id}:${today}:${percent}`,
        },
      })
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Tasks — todos/service.mjs
// ---------------------------------------------------------------------------

// Takes the DTOs `todoService.list()` returns rather than the service itself, so
// this stays pure and testable: the caller does the query, the rules live here.
//
// Deliberately one fact per situation, not one per task. A board with nine things
// due is a board; a phone that buzzes nine times is a phone whose notifications
// get turned off.
export function taskFacts({ tasks = null, now, tz }) {
  if (!tasks) return []
  const today = dayKey(now, tz)
  const out = []

  const open = tasks.filter(
    (t) => t.status !== 'done' && !t.completedAt && !t.archivedAt && !t.deletedAt,
  )
  // A snoozed task is one the owner has already said "not now" to. Nudging about it is
  // overruling him with a timer.
  const active = open.filter((t) => !t.snoozedUntil || Date.parse(t.snoozedUntil) <= now)

  const dueToday = active.filter((t) => t.dueDate === today)
  if (dueToday.length) {
    const named = dueToday.slice(0, 3).map((t) => t.title)
    out.push({
      kind: 'task.due-today',
      category: 'task.due',
      salience: 60 + Math.min(dueToday.length * 5, 20),
      slot: 'morning',
      subject: today,
      title: dueToday.length === 1
        ? fitTitle('Due today', dueToday[0].title)
        : `${dueToday.length} tasks due today`,
      body: dueToday.length === 1
        ? bodyOf(dueToday[0].title, dueToday[0].area === 'Ventures' ? `· ${dueToday[0].ventureTag}` : '')
        : `${named.join(', ')}${dueToday.length > named.length ? `, +${dueToday.length - named.length} more` : ''}`,
      url: '/productivity/todos',
      // Tomorrow this is either done or overdue. Either way it is a different fact.
      expiresAt: endOfDay(now, tz),
      revalidate: {
        collector: 'tasks',
        identity: `due:${today}`,
        factKey: `due:${today}:${dueToday.length}`,
      },
      resolvedTitle: 'Everything due today is done',
    })
  }

  // Overdue moves slower and is said separately. Two days is the threshold because
  // one day late is ordinary life, and being told about it is nagging.
  const stale = active.filter((t) => t.dueDate && t.dueDate < today && daysBetween(t.dueDate, today) >= 2)
  if (stale.length) {
    const oldest = stale.reduce((a, b) => (a.dueDate < b.dueDate ? a : b))
    out.push({
      kind: 'task.overdue',
      category: 'task.overdue',
      salience: 55 + Math.min(stale.length * 4, 20),
      slot: 'morning',
      subject: 'overdue',
      title: stale.length === 1 ? fitTitle('Overdue', oldest.title) : `${stale.length} tasks are overdue`,
      body: bodyOf(stale.length === 1 ? oldest.title : '', `Oldest is ${daysBetween(oldest.dueDate, today)} days past due.`),
      url: '/productivity/todos',
      expiresAt: endOfDay(now, tz),
      revalidate: {
        collector: 'tasks',
        identity: `overdue:${today}`,
        factKey: `overdue:${today}:${stale.length}`,
      },
    })
  }

  return out
}

function daysBetween(fromKey, toKey) {
  const a = Date.parse(`${fromKey}T00:00:00Z`)
  const b = Date.parse(`${toKey}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

export const COLLECTORS = { birthdayFacts, habitFacts, metricFacts, goalFacts, taskFacts }
