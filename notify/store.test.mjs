// Run with: node --test notify/store.test.mjs
//
// The failures this file exists to catch are all silent: a reminder delivered
// twice after a crash, a rescheduled reminder that stacks instead of replacing, a
// dead device reported as healthy, a vote that overwrites the log it is supposed
// to append to.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNotifyStore } from './store.mjs'

const T0 = Date.UTC(2026, 8, 15, 12, 0)

async function freshStore(opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'totem-notify-'))
  let clock = opts.now ?? T0
  const store = createNotifyStore({
    queueFile: join(dir, 'notification-queue.json'),
    subscriptionsFile: join(dir, 'push-subscriptions.json'),
    ledgerFile: join(dir, 'notifications.json'),
    feedbackFile: join(dir, 'notification-feedback.jsonl'),
    now: () => clock,
    ...opts,
  })
  return { store, dir, setNow: (t) => { clock = t }, getNow: () => clock }
}

const sub = (endpoint) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } })

test('an entry is queued, listed, and claimed only once it is due', async () => {
  const { store, setNow } = await freshStore()
  await store.enqueue({ category: 'reminder.adhoc', title: 'Call the dentist', deliverAt: T0 + 60_000 })

  assert.equal((await store.claimDue({ at: T0 })).claimed.length, 0)
  const { claimed } = await store.claimDue({ at: T0 + 60_000 })
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0].title, 'Call the dentist')
  assert.equal(claimed[0].state, 'sending')
  setNow(T0 + 60_000)

  // Claimed means claimed: a second drain must not pick it up again.
  assert.equal((await store.claimDue({ at: T0 + 120_000 })).claimed.length, 0)
})

test('claiming marks sending before delivery, so a crash cannot double-deliver', async () => {
  const { store } = await freshStore()
  await store.enqueue({ category: 'reminder.adhoc', title: 'once', deliverAt: T0 })
  const { claimed } = await store.claimDue({ at: T0 })
  assert.equal(claimed[0].attempts, 1)
  // Simulate the crash: nothing calls finish(). The entry is stuck in `sending`
  // rather than being re-sent, which is the safe direction to fail in.
  const pending = await store.listQueue({ state: 'pending' })
  assert.equal(pending.length, 0)
  const sending = await store.listQueue({ state: 'sending' })
  assert.equal(sending.length, 1)
})

test('a rescheduled reminder replaces the pending one instead of stacking', async () => {
  const { store } = await freshStore()
  const first = await store.enqueue({
    category: 'reminder.adhoc', title: 'Call the dentist', deliverAt: T0 + 3600_000, dedupeKey: 'r:dentist',
  })
  const second = await store.enqueue({
    category: 'reminder.adhoc', title: 'Call the dentist', deliverAt: T0 + 7200_000, dedupeKey: 'r:dentist',
  })
  assert.equal(second.deduped, true)
  assert.equal(second.entry.id, first.entry.id)
  const queue = await store.listQueue()
  assert.equal(queue.length, 1)
  assert.equal(queue[0].deliverAt, T0 + 7200_000)
})

test('the same fact about different subjects is not deduped together', async () => {
  const { store } = await freshStore()
  await store.enqueue({ category: 'habit.slipping', factKind: 'daily', subject: 'journal', title: 'journal', deliverAt: T0 })
  await store.enqueue({ category: 'habit.slipping', factKind: 'daily', subject: 'move', title: 'move', deliverAt: T0 })
  assert.equal((await store.listQueue()).length, 2)
})

test('an entry past its own expiry is dropped at claim time, not delivered late', async () => {
  const { store } = await freshStore()
  await store.enqueue({
    category: 'habit.slipping', title: 'streak ends tonight',
    deliverAt: T0, expiresAt: T0 + 3600_000,
  })
  const { claimed, expired } = await store.claimDue({ at: T0 + 7200_000 })
  assert.equal(claimed.length, 0)
  assert.equal(expired.length, 1)
  assert.equal(expired[0].state, 'expired')
})

test('an outage produces one late delivery, not a backlog burst', async () => {
  const { store } = await freshStore({ catchUpMinutes: 30 })
  // Three entries the box slept through, spread across four hours.
  await store.enqueue({ category: 'digest.morning', title: 'a', deliverAt: T0 - 4 * 3600_000, dedupeKey: 'a' })
  await store.enqueue({ category: 'digest.morning', title: 'b', deliverAt: T0 - 2 * 3600_000, dedupeKey: 'b' })
  await store.enqueue({ category: 'digest.morning', title: 'c', deliverAt: T0 - 10 * 60_000, dedupeKey: 'c' })

  const { claimed, expired } = await store.claimDue({ at: T0 })
  // Only the one inside the grace window is delivered; the rest are recorded as
  // missed rather than fired hours late.
  assert.deepEqual(claimed.map((e) => e.title), ['c'])
  assert.deepEqual(expired.map((e) => e.state), ['missed', 'missed'])
})

test('a late-but-inside-grace delivery is flagged so it can say when it was for', async () => {
  const { store } = await freshStore({ catchUpMinutes: 30 })
  await store.enqueue({ category: 'reminder.adhoc', title: 'late', deliverAt: T0 - 10 * 60_000 })
  const { claimed } = await store.claimDue({ at: T0 })
  assert.equal(claimed[0].late, true)
})

test('a failed send retries, then gives up and stays visible', async () => {
  const { store } = await freshStore()
  const { entry } = await store.enqueue({ category: 'reminder.adhoc', title: 'flaky', deliverAt: T0 })
  for (let i = 0; i < 2; i++) {
    const { claimed } = await store.claimDue({ at: T0 })
    assert.equal(claimed.length, 1)
    const after = await store.finish(entry.id, { outcome: 'failed', error: 'push service 500' })
    assert.equal(after.state, 'pending')
  }
  const { claimed } = await store.claimDue({ at: T0 })
  assert.equal(claimed[0].attempts, 3)
  const dead = await store.finish(entry.id, { outcome: 'failed', error: 'push service 500' })
  assert.equal(dead.state, 'failed')
  assert.equal(dead.lastError, 'push service 500')
  // Abandoned, not deleted: a notification that could not be delivered is still a
  // record.
  assert.equal((await store.listQueue({ state: 'failed' })).length, 1)
})

test('a revalidation miss is a success of the design, not a failure', async () => {
  const { store } = await freshStore()
  const { entry } = await store.enqueue({ category: 'goal.nearcomplete', title: 'one more', deliverAt: T0 })
  await store.claimDue({ at: T0 })
  const done = await store.finish(entry.id, { outcome: 'stale' })
  assert.equal(done.state, 'stale')
  assert.equal(done.lastError, null)
})

test('delivering with the resolved title records what was actually sent', async () => {
  const { store } = await freshStore()
  const { entry } = await store.enqueue({
    category: 'goal.nearcomplete', title: 'one more to go', resolvedTitle: 'done for the week', deliverAt: T0,
  })
  await store.claimDue({ at: T0 })
  const sent = await store.finish(entry.id, { outcome: 'delivered', title: 'done for the week' })
  assert.equal(sent.state, 'delivered')
  assert.equal(sent.title, 'done for the week')
  assert.equal(sent.deliveredAt, T0)
})

test('applying a plan supersedes the earlier run and leaves delivered entries alone', async () => {
  const { store } = await freshStore()
  const plan = (entries) => ({
    planId: 'plan_2026-09-15_daily-digest', planDate: '2026-09-15', source: 'daily-digest', entries,
  })
  await store.applyPlan(plan([
    { category: 'person.birthday', factKind: 'birthday.today', title: 'birthday', deliverAt: T0 + 3600_000 },
    { category: 'habit.slipping', factKind: 'habit.streak-ending', title: 'streak', deliverAt: T0 + 7200_000 },
  ]))
  // One of them goes out.
  const { claimed } = await store.claimDue({ at: T0 + 3600_000 })
  await store.finish(claimed[0].id, { outcome: 'delivered' })

  const result = await store.applyPlan(plan([
    { category: 'goal.nearcomplete', factKind: 'goal.near-target', title: 'one more', deliverAt: T0 + 10800_000 },
  ]))
  assert.equal(result.superseded, 1) // only the undelivered one
  const queue = await store.listQueue()
  assert.deepEqual(queue.map((e) => e.title).sort(), ['birthday', 'one more'])
})

test('an ad-hoc reminder is not superseded by a digest re-plan', async () => {
  const { store } = await freshStore()
  await store.enqueue({ category: 'reminder.adhoc', title: 'Call the dentist', deliverAt: T0 + 3600_000 })
  await store.applyPlan({
    planId: 'p', planDate: '2026-09-15', source: 'daily-digest',
    entries: [{ category: 'digest.morning', title: 'digest', deliverAt: T0 + 60_000 }],
  })
  assert.equal((await store.listQueue()).length, 2)
})

test('a device re-subscribing refreshes its keys rather than duplicating it', async () => {
  const { store } = await freshStore()
  const first = await store.saveSubscription({ subscription: sub('https://push/1'), label: 'iPhone' })
  const again = await store.saveSubscription({
    subscription: { endpoint: 'https://push/1', keys: { p256dh: 'new', auth: 'new' } },
  })
  assert.equal(again.id, first.id)
  assert.equal(again.keys.p256dh, 'new')
  assert.equal(again.label, 'iPhone') // a re-subscribe does not wipe the name
  assert.equal((await store.listSubscriptions()).length, 1)
})

test('a gone device is expired and visible, not silently deleted', async () => {
  const { store } = await freshStore()
  await store.saveSubscription({ subscription: sub('https://push/1'), label: 'iPhone' })
  const expired = await store.expireSubscription('https://push/1', 'http 410')
  assert.equal(expired.state, 'expired')
  assert.equal(expired.lastError, 'http 410')
  // Still listed, so Settings can say "that device is gone" instead of nothing.
  assert.equal((await store.listSubscriptions()).length, 1)

  // Re-adding to the Home Screen revives it.
  const revived = await store.saveSubscription({ subscription: sub('https://push/1') })
  assert.equal(revived.state, 'active')
  assert.equal(revived.expiredAt, null)
})

test('the ledger records everything, read state and all', async () => {
  const { store } = await freshStore()
  await store.record({ category: 'job.failed', level: 'error', title: 'WHOOP sync failed' })
  await store.record({ category: 'digest.morning', title: 'Good morning' })
  const before = await store.ledger()
  assert.equal(before.items.length, 2)
  assert.equal(before.unread, 2)
  assert.equal(before.items[0].title, 'Good morning') // newest first

  await store.markRead([before.items[0].id])
  assert.equal((await store.ledger()).unread, 1)
  await store.markRead()
  assert.equal((await store.ledger()).unread, 0)
})

test('feedback appends and never rewrites, and mirrors the vote for the bell', async () => {
  const { store, dir } = await freshStore()
  const { entry } = await store.enqueue({ category: 'habit.slipping', factKind: 'habit.streak-ending', title: 'streak', deliverAt: T0 })
  await store.recordFeedback({ entryId: entry.id, category: 'habit.slipping', factKind: 'habit.streak-ending', event: 'delivered' })
  await store.recordFeedback({ entryId: entry.id, category: 'habit.slipping', factKind: 'habit.streak-ending', event: 'vote', vote: 'down', reasons: ['wrong-time'] })
  await store.recordFeedback({ entryId: entry.id, category: 'habit.slipping', factKind: 'habit.streak-ending', event: 'vote', vote: 'up' })

  const rows = await store.readFeedback()
  assert.equal(rows.length, 3)
  // The earlier vote is still there — the log is the source of truth and a change
  // of mind is a second row, not an edit.
  assert.deepEqual(rows.map((r) => r.vote), [null, 'down', 'up'])

  const raw = await readFile(join(dir, 'notification-feedback.jsonl'), 'utf8')
  assert.equal(raw.trim().split('\n').length, 3)

  // The queue entry mirrors only the latest, for rendering.
  const [queued] = await store.listQueue()
  assert.equal(queued.feedback.vote, 'up')
})

test('an open is recorded once, so a reopened notification is not counted twice', async () => {
  const { store, setNow } = await freshStore()
  const { entry } = await store.enqueue({ category: 'digest.morning', title: 'digest', deliverAt: T0 })
  const opened = await store.markOpened(entry.id)
  assert.equal(opened.openedAt, T0)
  setNow(T0 + 60_000)
  const again = await store.markOpened(entry.id)
  assert.equal(again.openedAt, T0)
})

test('pruning keeps pending work forever and old deliveries for a week', async () => {
  const { store } = await freshStore()
  const { entry: old } = await store.enqueue({ category: 'digest.morning', title: 'old', deliverAt: T0 })
  await store.enqueue({ category: 'reminder.adhoc', title: 'future', deliverAt: T0 + 30 * 86_400_000 })
  await store.claimDue({ at: T0 })
  await store.finish(old.id, { outcome: 'delivered' })

  assert.equal((await store.prune({ at: T0 + 6 * 86_400_000 })).removed, 0)
  assert.equal((await store.prune({ at: T0 + 8 * 86_400_000 })).removed, 1)
  assert.deepEqual((await store.listQueue()).map((e) => e.title), ['future'])
})

test('concurrent enqueues do not clobber each other', async () => {
  const { store } = await freshStore()
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.enqueue({ category: 'reminder.adhoc', title: `r${i}`, deliverAt: T0 + i, dedupeKey: `k${i}` })),
  )
  assert.equal((await store.listQueue()).length, 20)
})

test('a cancelled reminder leaves the queue; a delivered one cannot be cancelled', async () => {
  const { store } = await freshStore()
  const { entry } = await store.enqueue({ category: 'reminder.adhoc', title: 'nope', deliverAt: T0 + 3600_000 })
  assert.equal((await store.cancel(entry.id)).removed, 1)
  assert.equal((await store.listQueue()).length, 0)

  const { entry: sent } = await store.enqueue({ category: 'reminder.adhoc', title: 'gone out', deliverAt: T0 })
  await store.claimDue({ at: T0 })
  await store.finish(sent.id, { outcome: 'delivered' })
  assert.equal((await store.cancel(sent.id)).removed, 0)
})

test('a corrupt queue file reads as empty rather than taking the bridge down', async () => {
  const { store, dir } = await freshStore()
  const { writeFile } = await import('node:fs/promises')
  await store.enqueue({ category: 'reminder.adhoc', title: 'x', deliverAt: T0 })
  await writeFile(join(dir, 'notification-queue.json'), '{ not json')
  assert.deepEqual(await store.listQueue(), [])
  // And it recovers by writing a good file on the next enqueue.
  await store.enqueue({ category: 'reminder.adhoc', title: 'y', deliverAt: T0 })
  assert.equal((await store.listQueue()).length, 1)
})

test('two different ad-hoc reminders do not collapse into one', async () => {
  // Found by the notifier drain test: the category name alone was being used as a
  // dedupe identity, so "Call the dentist" and "Pick up the bike" silently became
  // whichever was enqueued last.
  const { store } = await freshStore()
  await store.enqueue({ category: 'reminder.adhoc', title: 'Call the dentist', deliverAt: T0 })
  await store.enqueue({ category: 'reminder.adhoc', title: 'Pick up the bike', deliverAt: T0 + 86_400_000 })
  const queue = await store.listQueue()
  assert.deepEqual(queue.map((e) => e.title), ['Call the dentist', 'Pick up the bike'])
})

test('a digest fact still collapses within its window, and not outside it', async () => {
  const { store } = await freshStore()
  // person.birthday has a 24 hour window.
  await store.enqueue({ category: 'person.birthday', factKind: 'birthday.today', subject: 'Marion', title: 'first', deliverAt: T0 })
  await store.enqueue({ category: 'person.birthday', factKind: 'birthday.today', subject: 'Marion', title: 'second', deliverAt: T0 + 3600_000 })
  assert.deepEqual((await store.listQueue()).map((e) => e.title), ['second'])

  // Two days later is a different birthday, not the same one said twice.
  await store.enqueue({ category: 'person.birthday', factKind: 'birthday.today', subject: 'Marion', title: 'next year', deliverAt: T0 + 2 * 86_400_000 })
  assert.equal((await store.listQueue()).length, 2)
})

test('an ignored entry is only counted once, however often the sweep runs', async () => {
  // The sweep runs on every 30 second tick; without the flag it would record the
  // same negative ~120 times an hour and bury a fact kind on its own.
  const { store } = await freshStore()
  const { entry } = await store.enqueue({ category: 'habit.slipping', factKind: 'habit.streak-ending', title: 'x', deliverAt: T0 })
  await store.claimDue({ at: T0 })
  await store.finish(entry.id, { outcome: 'delivered' })

  const first = await store.markIgnoredCounted(entry.id)
  assert.equal(first.ignoredCounted, true)
  const second = await store.markIgnoredCounted(entry.id)
  assert.equal(second.ignoredCounted, true)
  const [queued] = await store.listQueue()
  assert.equal(queued.ignoredCounted, true)
})
