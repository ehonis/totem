// Run with: node --test notify/usage.test.mjs
//
// The rule these tests exist to hold: a quota nudge is only raised when it will
// still be true at the time it is delivered. Everything else here is wording.
import test from 'node:test'
import assert from 'node:assert/strict'
import { usageFacts, paceRatio, resetPhrase, windowId } from './usage.mjs'

const TZ = 'America/New_York'
const NOW = Date.UTC(2026, 8, 17, 19, 0) // Thursday, 3 PM in New York
const HOUR = 3_600_000
const DAY = 24 * HOUR

const meter = (over = {}) => ({
  key: 'weekly_all:',
  label: '7-day limit',
  usedPct: 50,
  resetsAt: NOW + 3 * DAY,
  windowMinutes: 7 * 24 * 60,
  ...over,
})

const account = (over = {}) => ({
  id: 'claude:claude-default',
  backend: 'claude',
  displayName: 'Claude',
  status: 'ok',
  meters: [meter()],
  ...over,
})

const facts = (accounts, options) =>
  usageFacts({ accounts: [].concat(accounts), now: NOW, tz: TZ, options })

const kinds = (accounts, options) => facts(accounts, options).map((f) => f.kind)

test('a slow window crossing the threshold is worth saying', async () => {
  const [fact] = facts(account({ meters: [meter({ usedPct: 86 })] }))
  assert.equal(fact.kind, 'usage.low')
  assert.match(fact.title, /Quota running low/)
  // The number that matters is the one he has left, and it belongs in the body:
  // iOS shows one short line of title and several of body.
  assert.match(fact.body, /14% of the 7-day limit left/)
  assert.match(fact.body, /resets Sunday/)
})

test('an ordinary window says nothing at all', async () => {
  assert.deepEqual(kinds(account({ meters: [meter({ usedPct: 50 })] })), [])
})

test('a five-hour window may only say it is spent', async () => {
  const session = (usedPct) => account({
    meters: [meter({ key: 'session:', label: '5-hour limit', usedPct, windowMinutes: 300, resetsAt: NOW + 2 * HOUR })],
  })
  // 82% of a five-hour window, delivered three hours later, is a statement about
  // a window that has already reset. Never raised.
  assert.deepEqual(kinds(session(82)), [])
  assert.deepEqual(kinds(session(99.4)), ['usage.spent'])
})

test('a spent window expires when it refills, not at midnight', async () => {
  const resetsAt = NOW + 2 * HOUR
  const [fact] = facts(account({
    meters: [meter({ key: 'session:', label: '5-hour limit', usedPct: 100, windowMinutes: 300, resetsAt })],
  }))
  // "You are out of quota", arriving after the refill, is worse than silence.
  assert.equal(fact.expiresAt, resetsAt)
})

test('burning through a window fast is raised only while there is time to react', async () => {
  // A third of the way into the week with 62% gone: about 1.9x an even pace.
  const fast = meter({ usedPct: 62, resetsAt: NOW + 4.7 * DAY })
  assert.deepEqual(kinds(account({ meters: [fast] })), ['usage.burning'])

  // Same burn, but the window is nearly over: that is a countdown, not advice.
  const late = meter({ usedPct: 62, resetsAt: NOW + 4 * HOUR })
  assert.deepEqual(kinds(account({ meters: [late] })), [])
})

test('a fresh window is never "burning" on the strength of one busy hour', async () => {
  // 20% used in the first 2% of the window is a 10x ratio and means nothing.
  const justStarted = meter({ usedPct: 20, resetsAt: NOW + 6.9 * DAY })
  assert.equal(paceRatio(justStarted, 20, NOW), null)
  assert.deepEqual(kinds(account({ meters: [justStarted] })), [])
})

test('a long window about to roll over mostly unspent is worth one quiet word', async () => {
  const [fact] = facts(account({
    id: 'cursor:cursor-default',
    backend: 'cursor',
    displayName: 'Cursor',
    meters: [meter({ key: 'total', label: 'Included usage', usedPct: 11, windowMinutes: 30 * 24 * 60, resetsAt: NOW + 20 * HOUR })],
  }))
  assert.equal(fact.kind, 'usage.idle')
  assert.equal(fact.category, 'usage.idle')
  assert.match(fact.body, /used 11% of it/)
})

test('an unreadable account and an unlimited plan both stay silent', async () => {
  // A dead login is a Settings problem, not something to act on from a phone.
  assert.deepEqual(kinds(account({ status: 'expired', meters: [meter({ usedPct: 99 })] })), [])
  // Cursor's unlimited plans report percentages that cap nothing.
  assert.deepEqual(kinds(account({ unlimited: true, meters: [meter({ usedPct: 99 })] })), [])
  assert.deepEqual(kinds(account({ meters: [meter({ usedPct: null })] })), [])
})

test('one meter raises one fact, in severity order', async () => {
  // Spent wins over low, low wins over burning: they are the same sentence at
  // different temperatures, and saying two of them about one meter is noise.
  assert.deepEqual(kinds(account({ meters: [meter({ usedPct: 99.5 })] })), ['usage.spent'])
  assert.deepEqual(kinds(account({ meters: [meter({ usedPct: 88, resetsAt: NOW + 5 * DAY })] })), ['usage.low'])
})

test('the threshold is configurable without touching the wording', async () => {
  const meters = [meter({ usedPct: 71 })]
  assert.deepEqual(kinds(account({ meters })), [])
  assert.deepEqual(kinds(account({ meters }), { lowPct: 70 }), ['usage.low'])
})

test('every fact carries an identity without its number, and a fact key with it', async () => {
  const [fact] = facts(account({ meters: [meter({ usedPct: 86 })] }))
  // This is what lets a percentage that moved between the plan and the push be
  // re-worded at delivery instead of sent stale. See notify/revalidate.mjs.
  assert.doesNotMatch(fact.revalidate.identity, /86/)
  assert.match(fact.revalidate.factKey, /86$/)
  assert.ok(fact.revalidate.factKey.startsWith(fact.revalidate.identity))
  assert.equal(fact.revalidate.collector, 'usage')
})

test('reset times read like a person said them', async () => {
  assert.equal(resetPhrase(NOW + 40 * 60_000, NOW, TZ), 'resets in 40 minutes')
  assert.equal(resetPhrase(NOW + 3 * HOUR, NOW, TZ), 'resets at 6 PM')
  assert.equal(resetPhrase(NOW + 2 * DAY, NOW, TZ), 'resets Saturday at 3 PM')
  // A window that has already turned over has nothing to say about when it will.
  assert.equal(resetPhrase(NOW - HOUR, NOW, TZ), '')
})

// The shape of the duplicate that started this: one account, three meters, all
// spent for eleven days until one monthly reset.
const cursorSpent = (resetsAt) => account({
  id: 'cursor:cursor-default',
  backend: 'cursor',
  displayName: 'Cursor',
  meters: [
    meter({ key: 'total', label: 'Included usage', usedPct: 100, windowMinutes: 30 * 24 * 60, resetsAt }),
    meter({ key: 'auto', label: 'Auto models', usedPct: 100, windowMinutes: 30 * 24 * 60, resetsAt }),
    meter({ key: 'api', label: 'Named API models', usedPct: 100, windowMinutes: 30 * 24 * 60, resetsAt }),
  ],
})

test('every meter of one account spent until the same reset is one fact', async () => {
  const all = facts(cursorSpent(NOW + 10 * DAY))
  assert.equal(all.length, 1)
  assert.equal(all[0].kind, 'usage.spent')
  assert.match(all[0].body, /^Cursor: the included usage, auto models and named api models are used up, resets/)
})

test('a spent fact is keyed by its window, not by the day it was planned', async () => {
  const resetsAt = NOW + 10 * DAY
  const today = usageFacts({ accounts: [cursorSpent(resetsAt)], now: NOW, tz: TZ })[0]
  // Read again three days later, and with the vendor reporting the reset a few
  // seconds off: the same window, so the same key.
  const later = usageFacts({ accounts: [cursorSpent(resetsAt + 7_000)], now: NOW + 3 * DAY, tz: TZ })[0]
  assert.equal(today.dedupeKey, later.dedupeKey)
  assert.equal(today.dedupeUntil, resetsAt)
  // The next window is a different key.
  const next = usageFacts({ accounts: [cursorSpent(resetsAt + 30 * DAY)], now: resetsAt + DAY, tz: TZ })[0]
  assert.notEqual(next.dedupeKey, today.dedupeKey)
})

test('a running-low nudge is keyed per meter, ten-point step and window', async () => {
  const [at86] = facts(account({ meters: [meter({ usedPct: 86 })] }))
  assert.equal(at86.dedupeKey, `usage:claude:claude-default:weekly_all::low80:${windowId(NOW + 3 * DAY, NOW, TZ)}`)
  assert.equal(at86.dedupeUntil, NOW + 3 * DAY)
  // Still in the eighties: the same thing to say. Past ninety: a new one.
  assert.equal(facts(account({ meters: [meter({ usedPct: 89 })] }))[0].dedupeKey, at86.dedupeKey)
  assert.notEqual(facts(account({ meters: [meter({ usedPct: 91 })] }))[0].dedupeKey, at86.dedupeKey)
})

test('a meter with no reset time falls back to once a day', async () => {
  assert.equal(windowId(null, NOW, TZ), '2026-09-17')
})

test('a reset reported a second either side of a whole hour, half past or midnight is one window', async () => {
  const boundaries = [
    Date.UTC(2026, 9, 30, 16, 0), // a whole hour, and a five-hour multiple since the epoch
    Date.UTC(2026, 9, 3, 14, 30),
    Date.UTC(2026, 10, 1, 0, 0), // UTC midnight
    Date.UTC(2026, 10, 3, 10, 32), // a billing reset on its own minute
  ]
  for (const at of boundaries) {
    const ids = [-5000, -1000, 0, 1000, 5000].map((d) => windowId(at + d, NOW, TZ))
    assert.equal(new Set(ids).size, 1, `${new Date(at).toISOString()}: ${ids.join(' ')}`)
  }
  // Two consecutive windows of one meter never share an id, however short.
  const at = Date.UTC(2026, 9, 30, 16, 0)
  assert.notEqual(windowId(at, NOW, TZ), windowId(at + 5 * 3_600_000, NOW, TZ))
  assert.notEqual(windowId(at, NOW, TZ), windowId(at + 7 * DAY, NOW, TZ))
})
