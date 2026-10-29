// Run with: node --test notify/revalidate.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRevalidator } from './revalidate.mjs'

const NOW = Date.UTC(2026, 8, 15, 18, 0) // Tuesday
const TODAY = '2026-09-15'

const entry = (over) => ({ subject: null, revalidate: null, ...over })

const snapshot = (over = {}) => ({
  now: NOW,
  facts: [],
  habits: [{ id: 'journal', name: '3 Year Journal', cadence: 'daily', target: 1 },
    { id: 'business', name: 'Help the Business', cadence: 'weekly', target: 4 }],
  entries: {},
  tasks: null,
  goals: null,
  ...over,
})

const build = async (snap) => (await createRevalidator({ collect: async () => snap })())

test('a fact still in the live set is fresh', async () => {
  const revalidate = await build(snapshot({
    facts: [{ revalidate: { collector: 'tasks', factKey: 'due:2026-09-15:1' } }],
  }))
  const verdict = await revalidate(entry({ revalidate: { collector: 'tasks', factKey: 'due:2026-09-15:1' } }))
  assert.equal(verdict.state, 'fresh')
})

test('an entry with no revalidation key is always fresh', async () => {
  const revalidate = await build(snapshot())
  // Ad-hoc reminders, job failures and approval codes are not derived facts.
  assert.equal((await revalidate(entry({ revalidate: null }))).state, 'fresh')
})

test('a queued habit nudge is never turned into a congratulation', async () => {
  // Habit nudges are retired. One still in the queue goes quiet even after the
  // habit is logged: no "Streak intact", no "Done for the week".
  const logged = await build(snapshot({
    entries: {
      [TODAY]: { journal: { count: 1 }, business: { count: 2 } },
      '2026-09-14': { business: { count: 1 } },
      '2026-09-13': { business: { count: 1 } },
    },
  }))
  for (const rev of [
    { collector: 'habits', identity: `daily:journal:${TODAY}`, factKey: `daily:journal:${TODAY}` },
    { collector: 'habits', identity: 'weekly:business:2026-09-14', factKey: 'weekly:business:2026-09-14:3' },
    { collector: 'habits', identity: 'weekly-behind:business:2026-09-14', factKey: 'weekly-behind:business:2026-09-14:1' },
  ]) {
    const verdict = await logged(entry({ subject: rev.identity.split(':')[1], revalidate: rev }))
    assert.equal(verdict.state, 'stale', rev.identity)
  }
})

test('the due-today nudge resolves when the board is clear', async () => {
  const clear = await build(snapshot({
    tasks: [{ id: 'a', dueDate: TODAY, status: 'done', completedAt: '2026-09-15T15:00:00Z' }],
  }))
  const verdict = await clear(entry({ subject: TODAY, revalidate: { collector: 'tasks', factKey: `due:${TODAY}:1` } }))
  assert.equal(verdict.state, 'resolved')

  const stillOpen = await build(snapshot({
    tasks: [{ id: 'a', dueDate: TODAY, status: 'todo', completedAt: null, archivedAt: null, deletedAt: null }],
  }))
  assert.equal(
    (await stillOpen(entry({ revalidate: { collector: 'tasks', factKey: `due:${TODAY}:1` } }))).state,
    'stale',
  )
})

test('an unreadable task list cannot resolve anything', async () => {
  const revalidate = await build(snapshot({ tasks: null }))
  assert.equal(
    (await revalidate(entry({ revalidate: { collector: 'tasks', factKey: `due:${TODAY}:1` } }))).state,
    'stale',
  )
})

test('a goal gone from the list or marked complete is resolved', async () => {
  const done = await build(snapshot({ goals: [{ id: 'g1', complete: true }] }))
  assert.equal((await done(entry({ subject: 'g1', revalidate: { collector: 'goals', factKey: 'near:g1:80' } }))).state, 'resolved')

  const gone = await build(snapshot({ goals: [] }))
  assert.equal((await gone(entry({ subject: 'g1', revalidate: { collector: 'goals', factKey: 'near:g1:80' } }))).state, 'resolved')

  const open = await build(snapshot({ goals: [{ id: 'g1', complete: false }] }))
  assert.equal((await open(entry({ subject: 'g1', revalidate: { collector: 'goals', factKey: 'near:g1:80' } }))).state, 'stale')
})

test('a birthday is never stale — it does not stop being true', async () => {
  const revalidate = await build(snapshot())
  const verdict = await revalidate(entry({ revalidate: { collector: 'birthdays', factKey: 'birthday:Marion:2026-09-15' } }))
  assert.equal(verdict.state, 'fresh')
})

test('an unknown collector fails closed', async () => {
  const revalidate = await build(snapshot())
  assert.equal((await revalidate(entry({ revalidate: { collector: 'invented', factKey: 'x' } }))).state, 'stale')
})

test('a failed snapshot sends nothing at all rather than sending unverified', async () => {
  const revalidate = await (createRevalidator({ collect: async () => { throw new Error('db locked') } })())
  assert.equal((await revalidate(entry({ revalidate: { collector: 'birthdays', factKey: 'birthday:Marion:x' } }))).state, 'stale')
  // Even an entry that would otherwise be trivially fresh.
  assert.equal((await revalidate(entry({ revalidate: null }))).state, 'stale')
})

// ---------------------------------------------------------------------------
// The number moved between plan and delivery
// ---------------------------------------------------------------------------

test('a fact whose numbers moved is re-worded, not sent stale and not dropped', async () => {
  // Planned at 07:15 at 73%; a ride at lunchtime took it to 91%. The identity is
  // the same nudge, so the fresh sentence replaces the planned one.
  const revalidate = await build(snapshot({
    facts: [{
      title: '"50 Miles Biked" is at 91%',
      body: '2 days left on this week. One more push finishes it.',
      url: '/productivity/goals',
      revalidate: { collector: 'goals', identity: 'near:g1:2026-09-15', factKey: 'near:g1:2026-09-15:91' },
    }],
  }))
  const verdict = await revalidate(entry({
    subject: 'g1',
    title: '"50 Miles Biked" is at 73%',
    revalidate: { collector: 'goals', identity: 'near:g1:2026-09-15', factKey: 'near:g1:2026-09-15:73' },
  }))
  assert.equal(verdict.state, 'changed')
  assert.match(verdict.title, /91%/)
  assert.doesNotMatch(verdict.title, /73%/)
  assert.equal(verdict.url, '/productivity/goals')
})

test('an unchanged fact stays fresh, keeping the wording it was planned with', async () => {
  const rev = { collector: 'goals', identity: 'near:g1:2026-09-15', factKey: 'near:g1:2026-09-15:73' }
  const revalidate = await build(snapshot({ facts: [{ title: 'x', revalidate: rev }] }))
  assert.equal((await revalidate(entry({ subject: 'g1', revalidate: rev }))).state, 'fresh')
})

test('a finished fact still resolves rather than being re-worded', async () => {
  // Nothing in the fresh set matches the identity at all — the goal is done, which
  // is the one case that has something nicer to say than silence.
  const revalidate = await build(snapshot({ goals: [{ id: 'g1', complete: true }], facts: [] }))
  const verdict = await revalidate(entry({
    subject: 'g1',
    revalidate: { collector: 'goals', identity: 'near:g1:2026-09-15', factKey: 'near:g1:2026-09-15:73' },
  }))
  assert.equal(verdict.state, 'resolved')
})

test('an entry planned before identities existed still revalidates', async () => {
  // Entries already sitting in the queue at deploy time carry a factKey and no
  // identity. They must not all go stale on the first drain after a restart.
  const rev = { collector: 'goals', factKey: `near:g1:${TODAY}:73` }
  const revalidate = await build(snapshot({ facts: [{ revalidate: rev }] }))
  assert.equal((await revalidate(entry({ subject: 'g1', revalidate: rev }))).state, 'fresh')
})

test('an entry that cannot be checked is never congratulated', async () => {
  // Entries queued before the store persisted `subject` reach the resolver with
  // nothing to look the goal up by. Reporting "finished" there would congratulate
  // a goal sitting at 73%.
  const revalidate = await build(snapshot({ goals: [{ id: 'g1', complete: false }] }))
  const verdict = await revalidate(entry({ revalidate: { collector: 'goals', factKey: 'near:g1:2026-09-15' } }))
  assert.equal(verdict.state, 'stale')
})

test('an entry queued before identities existed re-renders rather than failing closed', async () => {
  // Its fact key is exactly what the identity is now — which is what makes this
  // survive the restart that introduces the change.
  const revalidate = await build(snapshot({
    goals: [{ id: 'g1', complete: false }],
    facts: [{
      title: '"50 Miles Biked" is at 91%',
      revalidate: { collector: 'goals', identity: 'near:g1:2026-09-15', factKey: 'near:g1:2026-09-15:91' },
    }],
  }))
  const verdict = await revalidate(entry({
    subject: 'g1',
    revalidate: { collector: 'goals', factKey: 'near:g1:2026-09-15' },
  }))
  assert.equal(verdict.state, 'changed')
  assert.match(verdict.title, /91%/)
})
