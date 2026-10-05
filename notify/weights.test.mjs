// Run with: node --test notify/weights.test.mjs
//
// These numbers decide what the owner quietly stops being told about. The tests that
// matter most are the ones pinning what feedback CANNOT do: silence a category,
// act on a single bad day, or be irreversible.
import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveWeights, weightChanges, ignoredSince, WEIGHT_FLOOR, WEIGHT_CEILING, MIN_EVIDENCE } from './weights.mjs'

const NOW = Date.UTC(2026, 8, 15, 12, 0)
const DAY = 86_400_000

const row = (over) => ({ ts: NOW, factKind: 'habit.streak-ending', category: 'habit.slipping', event: 'vote', vote: 'down', reasons: [], ...over })
const votes = (n, vote, over = {}) => Array.from({ length: n }, () => row({ vote, ...over }))

test('no feedback at all means no weights and no opinions', () => {
  const { weights, detail } = deriveWeights([], { now: NOW })
  assert.deepEqual(weights, {})
  assert.deepEqual(detail, [])
})

test('a cold start is exactly neutral', () => {
  // One grumpy Tuesday is not a preference.
  const { weights, detail } = deriveWeights([row({ vote: 'down' })], { now: NOW })
  assert.equal(weights['habit.streak-ending'], 1)
  assert.match(detail[0].because, /Not enough feedback yet/)
})

test('repeated downvotes make a kind rarer but never silent', () => {
  const { weights } = deriveWeights(votes(20, 'down'), { now: NOW })
  assert.equal(weights['habit.streak-ending'], WEIGHT_FLOOR)
  assert.ok(weights['habit.streak-ending'] > 0)
})

test('repeated upvotes raise it, capped', () => {
  const { weights } = deriveWeights(votes(20, 'up'), { now: NOW })
  assert.equal(weights['habit.streak-ending'], WEIGHT_CEILING)
})

test('mixed feedback lands between the two, not at an extreme', () => {
  const { weights } = deriveWeights([...votes(5, 'up'), ...votes(3, 'down')], { now: NOW })
  const w = weights['habit.streak-ending']
  assert.ok(w > 1 && w < WEIGHT_CEILING, `expected a middling weight, got ${w}`)
})

test('acting on a nudge counts for more than merely opening it', () => {
  const acted = deriveWeights(Array.from({ length: 4 }, () => row({ event: 'acted', vote: null })), { now: NOW })
  const opened = deriveWeights(Array.from({ length: 4 }, () => row({ event: 'opened', vote: null })), { now: NOW })
  assert.ok(acted.weights['habit.streak-ending'] > opened.weights['habit.streak-ending'])
})

test('being ignored counts against a kind', () => {
  const { weights } = deriveWeights(Array.from({ length: 8 }, () => row({ event: 'ignored', vote: null })), { now: NOW })
  assert.ok(weights['habit.streak-ending'] < 1)
})

test('deliveries and failures are bookkeeping, not opinion', () => {
  const rows = [
    ...Array.from({ length: 20 }, () => row({ event: 'delivered', vote: null })),
    ...Array.from({ length: 20 }, () => row({ event: 'failed', vote: null })),
  ]
  assert.deepEqual(deriveWeights(rows, { now: NOW }).weights, { 'habit.streak-ending': 1 })
})

test('old feedback fades rather than outvoting last week', () => {
  const stale = deriveWeights(votes(10, 'down', { ts: NOW - 400 * DAY }), { now: NOW })
  const fresh = deriveWeights(votes(10, 'down'), { now: NOW })
  assert.ok(stale.weights['habit.streak-ending'] > fresh.weights['habit.streak-ending'])
  // Faded far enough that it no longer clears the evidence bar on its own.
  assert.equal(stale.weights['habit.streak-ending'], 1)
})

test('a change of mind wins, because the log is ordered and decayed', () => {
  const rows = [...votes(6, 'down', { ts: NOW - 80 * DAY }), ...votes(6, 'up')]
  assert.ok(deriveWeights(rows, { now: NOW }).weights['habit.streak-ending'] > 1)
})

test('each fact kind is judged on its own', () => {
  const { weights } = deriveWeights([
    ...votes(8, 'down'),
    ...votes(8, 'up', { factKind: 'birthday.today', category: 'person.birthday' }),
  ], { now: NOW })
  // Near the bounds rather than exactly on them: eight votes is a clear opinion,
  // not yet a settled one, and the curve saturates rather than snapping.
  assert.ok(weights['habit.streak-ending'] < 0.4, `expected rare, got ${weights['habit.streak-ending']}`)
  assert.ok(weights['birthday.today'] > 1.7, `expected favoured, got ${weights['birthday.today']}`)
})

test('a pinned category is flagged, so the UI can say the weight will not apply', () => {
  const { detail } = deriveWeights(votes(8, 'down', { factKind: 'birthday.today', category: 'person.birthday' }), { now: NOW })
  assert.equal(detail[0].pinned, true)
})

test('every weight comes with the evidence behind it, in words', () => {
  const { detail } = deriveWeights([...votes(5, 'down'), row({ event: 'ignored', vote: null })], { now: NOW })
  assert.match(detail[0].because, /5 down/)
  assert.match(detail[0].because, /1 ignored/)
  assert.equal(detail[0].down, 5)
  assert.equal(detail[0].ignored, 1)
})

test('rows without a fact kind are skipped rather than lumped together', () => {
  // Ad-hoc reminders and approval codes carry no fact kind; they are not a
  // category of thing to learn about.
  const { weights } = deriveWeights([row({ factKind: null }), row({ factKind: undefined })], { now: NOW })
  assert.deepEqual(weights, {})
})

test('crossing a threshold is reported so the digest can say it out loud', () => {
  assert.deepEqual(weightChanges({ a: 1 }, { a: 0.5 }), [{ kind: 'a', direction: 'down', from: 1, to: 0.5 }])
  assert.deepEqual(weightChanges({ a: 1 }, { a: 1.5 }), [{ kind: 'a', direction: 'up', from: 1, to: 1.5 }])
  // Drifting within the neutral band is not news.
  assert.deepEqual(weightChanges({ a: 1 }, { a: 1.05 }), [])
  // Already reported once; not reported again.
  assert.deepEqual(weightChanges({ a: 0.5 }, { a: 0.4 }), [])
  // A kind with no history starts from neutral.
  assert.deepEqual(weightChanges({}, { a: 0.3 }), [{ kind: 'a', direction: 'down', from: 1, to: 0.3 }])
})

test('delivered-and-never-opened becomes ignored, but only after a grace period', () => {
  const entries = [
    { id: 'a', state: 'delivered', deliveredAt: NOW - 8 * 3_600_000, openedAt: null },
    { id: 'b', state: 'delivered', deliveredAt: NOW - 1 * 3_600_000, openedAt: null },
    { id: 'c', state: 'delivered', deliveredAt: NOW - 8 * 3_600_000, openedAt: NOW },
    { id: 'd', state: 'pending', deliveredAt: null, openedAt: null },
    { id: 'e', state: 'delivered', deliveredAt: NOW - 8 * 3_600_000, openedAt: null, ignoredCounted: true },
  ]
  assert.deepEqual(ignoredSince(entries, { now: NOW }).map((e) => e.id), ['a'])
})

test('the evidence bar is high enough that a handful of clicks cannot move it', () => {
  const opened = Array.from({ length: MIN_EVIDENCE - 1 }, () => row({ event: 'opened', vote: null }))
  assert.equal(deriveWeights(opened, { now: NOW }).weights['habit.streak-ending'], 1)
})

test('a reset puts one kind back to neutral and leaves the rest alone', () => {
  const rows = [
    ...votes(8, 'down'),
    ...votes(8, 'down', { factKind: 'metric.off-goal', category: 'goal.slipping' }),
    { ts: NOW, event: 'reset', factKind: 'habit.streak-ending' },
  ]
  const { weights } = deriveWeights(rows, { now: NOW })
  assert.equal(weights['habit.streak-ending'], undefined) // no opinion at all now
  assert.ok(weights['metric.off-goal'] < 1)
})

test('a reset with no kind clears everything', () => {
  const rows = [...votes(8, 'down'), ...votes(8, 'up', { factKind: 'birthday.today' }), { ts: NOW, event: 'reset', factKind: null }]
  assert.deepEqual(deriveWeights(rows, { now: NOW }).weights, {})
})

test('feedback after a reset counts again', () => {
  const rows = [
    ...votes(8, 'down'),
    { ts: NOW - 2 * DAY, event: 'reset', factKind: 'habit.streak-ending' },
    ...votes(8, 'up'),
  ]
  assert.ok(deriveWeights(rows, { now: NOW }).weights['habit.streak-ending'] > 1)
})

test('a kind with only deliveries is listed with no opinion, so the panel can say so', () => {
  const rows = Array.from({ length: 12 }, () => row({ event: 'delivered', vote: null }))
  const { weights, detail } = deriveWeights(rows, { now: NOW })
  assert.equal(weights['habit.streak-ending'], 1)
  assert.equal(detail[0].delivered, 12)
  assert.match(detail[0].because, /Not enough feedback yet/)
})
