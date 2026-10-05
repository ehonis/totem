// Run with: node --test notify/
//
// The planner is where "the AI found five things today" becomes either a day of
// well-timed nudges or a wall of push notifications that gets the app muted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { localParts, zonedToUtc } from '../jobs/schedule.mjs'
import { planDay, supersede, WEIGHT_FLOOR } from './plan.mjs'

const TZ = 'America/New_York'
const wall = (ts) => {
  const p = localParts(ts, TZ)
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}
const day = (ts) => {
  const p = localParts(ts, TZ)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}
const at = (s) => {
  const m = s.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/)
  return zonedToUtc({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] }, TZ)
}

const fact = (over) => ({
  kind: 'test.kind',
  category: 'habit.slipping',
  salience: 50,
  title: 'a thing',
  revalidate: { collector: 'test', factKey: 'k' },
  ...over,
})

const NOW = at('2026-09-11 07:15')
const base = { now: NOW, tz: TZ, settings: {} }

test('facts land in their natural slot, not all at the digest time', () => {
  const plan = planDay({
    ...base,
    facts: [
      fact({ kind: 'birthday.today', category: 'person.birthday', salience: 100, slot: 'morning', title: 'birthday' }),
      fact({ kind: 'habit.near-target', category: 'goal.nearcomplete', slot: 'evening', title: 'one more' }),
    ],
  })
  assert.deepEqual(plan.entries.map((e) => [wall(e.deliverAt), e.title]), [
    ['07:15', 'birthday'],
    ['18:00', 'one more'],
  ])
})

test('the daily cap drops the least salient and says so', () => {
  const facts = [1, 2, 3, 4, 5, 6].map((n) => fact({ salience: n * 10, title: `t${n}`, slot: 'morning' }))
  const plan = planDay({ ...base, facts, settings: { cap: 3 } })
  assert.equal(plan.entries.length, 3)
  assert.deepEqual(plan.entries.map((e) => e.title).sort(), ['t4', 't5', 't6'])
  assert.equal(plan.dropped.length, 3)
  assert.ok(plan.dropped.every((d) => d.reason === 'cap'))
})

test('several facts in one slot are spread out rather than stacked', () => {
  const facts = [1, 2, 3].map((n) => fact({ salience: n * 10, title: `t${n}`, slot: 'morning' }))
  const plan = planDay({ ...base, facts, settings: { cap: 4, minGapMinutes: 90 } })
  assert.deepEqual(plan.entries.map((e) => wall(e.deliverAt)), ['07:15', '08:45', '10:15'])
})

test('a pinned fact beats a higher-scoring one and survives the cap', () => {
  const facts = [
    fact({ kind: 'birthday.today', category: 'person.birthday', salience: 1, title: 'birthday', slot: 'morning' }),
    ...[1, 2, 3].map((n) => fact({ salience: 90 + n, title: `t${n}`, slot: 'morning' })),
  ]
  const plan = planDay({ ...base, facts, settings: { cap: 2 } })
  assert.equal(plan.entries.length, 2)
  assert.ok(plan.entries.some((e) => e.title === 'birthday'))
})

test('learned weights reorder what gets sent but never silence a pinned fact', () => {
  const facts = [
    fact({ kind: 'noisy', salience: 90, title: 'noisy', slot: 'morning' }),
    fact({ kind: 'useful', salience: 50, title: 'useful', slot: 'morning' }),
    fact({ kind: 'birthday.today', category: 'person.birthday', salience: 10, title: 'birthday', slot: 'morning' }),
  ]
  const plan = planDay({ ...base, facts, settings: { cap: 2 }, weights: { noisy: WEIGHT_FLOOR, useful: 2 } })
  assert.deepEqual(plan.entries.map((e) => e.title), ['birthday', 'useful'])
  // The downvoted kind is rarer, not banned: with room, it still goes.
  const roomy = planDay({ ...base, facts, settings: { cap: 3 }, weights: { noisy: WEIGHT_FLOOR } })
  assert.equal(roomy.entries.length, 3)
})

test('a weight is clamped, so no amount of feedback can zero a category out', () => {
  const facts = [fact({ kind: 'hated', salience: 80, title: 'hated', slot: 'morning' })]
  const plan = planDay({ ...base, facts, weights: { hated: 0.000001 } })
  assert.equal(plan.entries.length, 1)
  assert.equal(plan.entries[0].weight, WEIGHT_FLOOR)
})

test('an unknown or missing weight is exactly neutral', () => {
  const facts = [fact({ kind: 'fresh', salience: 80, title: 'fresh', slot: 'morning' })]
  assert.equal(planDay({ ...base, facts }).entries[0].weight, 1)
  assert.equal(planDay({ ...base, facts, weights: { fresh: 'nonsense' } }).entries[0].weight, 1)
})

test('an evening run schedules into tonight and tomorrow, never into the past', () => {
  const evening = at('2026-09-11 20:30')
  const plan = planDay({
    now: evening,
    tz: TZ,
    settings: { cap: 4, minGapMinutes: 90 },
    source: 'evening-digest',
    facts: [
      fact({ salience: 80, title: 'tonight', slot: 'night' }),
      fact({ salience: 70, title: 'was for this morning', slot: 'morning' }),
    ],
  })
  assert.ok(plan.entries.every((e) => e.deliverAt >= evening))
  // Pushed past quiet hours rather than fired at 22:00.
  const late = plan.entries.find((e) => e.title === 'was for this morning')
  assert.equal(day(late.deliverAt), '2026-09-12')
  assert.equal(wall(late.deliverAt), '07:00')
})

test('every entry carries what it needs to be re-checked before it fires', () => {
  const plan = planDay({
    ...base,
    facts: [fact({ slot: 'evening', resolvedTitle: 'nice one', revalidate: { collector: 'habits', factKey: 'weekly:business:3' } })],
  })
  assert.deepEqual(plan.entries[0].revalidate, { collector: 'habits', factKey: 'weekly:business:3' })
  assert.equal(plan.entries[0].resolvedTitle, 'nice one')
})

test('a plan with no facts is an empty plan, not a "nothing to report" push', () => {
  const plan = planDay({ ...base, facts: [] })
  assert.deepEqual(plan.entries, [])
  assert.deepEqual(plan.dropped, [])
})

test('a cap of zero switches planning off without breaking', () => {
  const plan = planDay({ ...base, facts: [fact({})], settings: { cap: 0 } })
  assert.equal(plan.entries.length, 0)
  assert.equal(plan.dropped[0].reason, 'cap')
})

test('the plan is stamped with the local day and its source', () => {
  const plan = planDay({ now: at('2026-09-11 23:30'), tz: TZ, settings: {}, facts: [], source: 'evening-digest' })
  assert.equal(plan.planDate, '2026-09-11')
  assert.equal(plan.source, 'evening-digest')
  assert.match(plan.planId, /^plan_2026-09-11_evening-digest$/)
})

test('re-planning supersedes the earlier plan instead of duplicating it', () => {
  const existing = [
    { id: 'a', planDate: '2026-09-11', state: 'pending' },
    { id: 'b', planDate: '2026-09-11', state: 'delivered' },
    { id: 'c', planDate: '2026-09-11', state: 'sending' },
    { id: 'd', planDate: '2026-09-12', state: 'pending' },
    { id: 'e', planDate: null, state: 'pending' }, // an ad-hoc reminder, not ours to touch
  ]
  const { keep, superseded } = supersede(existing, { planDate: '2026-09-11' })
  assert.deepEqual(keep.map((e) => e.id), ['b', 'c', 'd', 'e'])
  assert.deepEqual(superseded.map((e) => e.id), ['a'])
})

test('a fact that stops being true at midnight is dropped, not delivered wrong', () => {
  // Found by running the evening preview against real data: "your 18-day streak
  // ends tonight", deferred past quiet hours, arrives at 7am as advice about a
  // streak that already broke. Late is not the same as harmless.
  const evening = at('2026-09-11 20:30')
  const plan = planDay({
    now: evening,
    tz: TZ,
    settings: { cap: 4, minGapMinutes: 90 },
    source: 'evening-digest',
    facts: [
      fact({ salience: 90, title: 'first', slot: 'night' }),
      fact({
        salience: 80,
        title: 'streak ends tonight',
        slot: 'evening',
        expiresAt: at('2026-09-11 23:59'),
      }),
    ],
  })
  assert.deepEqual(plan.entries.map((e) => e.title), ['first'])
  assert.deepEqual(plan.dropped.map((d) => [d.reason, d.fact.title]), [['too-late', 'streak ends tonight']])
})

test('an expiry further out still allows a deferred delivery', () => {
  // Two facts at 20:30: the second is spaced to 22:00, lands in quiet hours and
  // defers to the morning. Its expiry is the end of tomorrow, so unlike the streak
  // nudge it is still true when it arrives and must survive.
  const evening = at('2026-09-11 20:30')
  const plan = planDay({
    now: evening,
    tz: TZ,
    settings: { cap: 4, minGapMinutes: 90 },
    facts: [
      fact({ salience: 90, title: 'first', slot: 'night' }),
      fact({ salience: 80, title: 'one more this week', slot: 'evening', expiresAt: at('2026-09-12 23:59') }),
    ],
  })
  assert.deepEqual(plan.dropped, [])
  const deferred = plan.entries.find((e) => e.title === 'one more this week')
  assert.equal(day(deferred.deliverAt), '2026-09-12')
})

test('a fact with no expiry is never dropped for lateness', () => {
  const plan = planDay({ ...base, facts: [fact({ title: 'evergreen', slot: 'morning' })] })
  assert.equal(plan.entries[0].expiresAt, null)
  assert.equal(plan.dropped.length, 0)
})

test('a different app can bring its own categories', () => {
  // Bushido shares this module and has none of Totem's categories. The table is a
  // parameter so neither app has to know about the other's.
  const BUSHIDO = {
    'workout.logged': { label: 'Workout logged', quietHours: 'defer', pinned: true, slot: 'evening', dedupeWindowMinutes: 0 },
    'quota.pace': { label: 'Quota pace', quietHours: 'defer', slot: 'evening', dedupeWindowMinutes: 1440 },
  }
  const plan = planDay({
    now: NOW,
    tz: TZ,
    settings: { cap: 2 },
    categories: BUSHIDO,
    weights: { 'quota.behind': 0.25 },
    facts: [
      fact({ kind: 'quota.behind', category: 'quota.pace', salience: 90, title: 'behind on climbing' }),
      fact({ kind: 'workout.done', category: 'workout.logged', salience: 10, title: 'nice session' }),
    ],
  })
  // The Bushido table says a logged workout is pinned, so it beats a higher-scoring
  // fact and ignores the learned weight — exactly as birthdays do in Totem.
  assert.equal(plan.entries[0].title, 'nice session')
  assert.equal(plan.entries[0].pinned, true)
  assert.equal(plan.entries.find((e) => e.title === 'behind on climbing').weight, 0.25)
})
