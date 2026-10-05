// Run with: node --test notify/notifier.test.mjs
//
// The test button and the queue drain share this module on purpose: a hand-test
// that works has to prove the automatic path works too, and that is only true if
// there is one path. These tests hold that line.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNotifyStore } from './store.mjs'
import { createNotifier } from './notifier.mjs'

const T0 = Date.UTC(2026, 8, 15, 12, 0)
const VAPID = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:a@b.c' }

async function harness({ send, vapid = VAPID } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'totem-notifier-'))
  let clock = T0
  const store = createNotifyStore({
    queueFile: join(dir, 'q.json'),
    subscriptionsFile: join(dir, 's.json'),
    ledgerFile: join(dir, 'l.json'),
    feedbackFile: join(dir, 'f.jsonl'),
    now: () => clock,
  })
  const sent = []
  const sendImpl = send || (async ({ subscription, payload }) => {
    sent.push({ endpoint: subscription.endpoint, payload })
    return { ok: true, status: 201, gone: false }
  })
  const notifier = createNotifier({ store, vapid, sendImpl })
  return { store, notifier, sent, setNow: (t) => { clock = t } }
}

const sub = (endpoint) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } })

test('a delivery reaches every active device and is recorded in the ledger', async () => {
  const { store, notifier, sent } = await harness()
  await store.saveSubscription({ subscription: sub('https://push/1'), label: 'iPhone' })
  await store.saveSubscription({ subscription: sub('https://push/2'), label: 'iPad' })

  const result = await notifier.deliver({ title: 'Totem test', body: 'hello' })
  assert.equal(result.ok, true)
  assert.equal(result.delivered, 2)
  assert.deepEqual(sent.map((s) => s.endpoint).sort(), ['https://push/1', 'https://push/2'])

  const ledger = await store.ledger()
  assert.equal(ledger.items[0].title, 'Totem test')
})

test('an expired device is skipped without being retried', async () => {
  const { store, notifier, sent } = await harness()
  await store.saveSubscription({ subscription: sub('https://push/1'), label: 'iPhone' })
  await store.saveSubscription({ subscription: sub('https://push/2'), label: 'old iPad' })
  await store.expireSubscription('https://push/2', 'http 410')

  await notifier.deliver({ title: 'x' })
  assert.deepEqual(sent.map((s) => s.endpoint), ['https://push/1'])
})

test('a 410 expires that device and leaves the others delivered', async () => {
  const { store, notifier } = await harness({
    send: async ({ subscription }) => subscription.endpoint === 'https://push/gone'
      ? { ok: false, gone: true, status: 410, error: 'unsubscribed' }
      : { ok: true, status: 201, gone: false },
  })
  await store.saveSubscription({ subscription: sub('https://push/gone'), label: 'removed from Home Screen' })
  await store.saveSubscription({ subscription: sub('https://push/live'), label: 'iPhone' })

  const result = await notifier.deliver({ title: 'x' })
  assert.equal(result.ok, true)
  assert.equal(result.delivered, 1)

  const devices = await store.listSubscriptions()
  assert.equal(devices.find((d) => d.label.startsWith('removed')).state, 'expired')
  assert.equal(devices.find((d) => d.label === 'iPhone').state, 'active')
  assert.ok(devices.find((d) => d.label === 'iPhone').lastDeliveredAt)
})

test('with every device gone the result says so instead of reporting success', async () => {
  const { store, notifier } = await harness({
    send: async () => ({ ok: false, gone: true, status: 410 }),
  })
  await store.saveSubscription({ subscription: sub('https://push/1') })
  const result = await notifier.deliver({ title: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'all-devices-gone')
})

test('no devices and no VAPID keys are different failures, and both still record', async () => {
  const none = await harness()
  const noDevices = await none.notifier.deliver({ title: 'x' })
  assert.equal(noDevices.reason, 'no-devices')
  assert.equal((await none.store.ledger()).items.length, 1)

  const unconfigured = await harness({ vapid: null })
  await unconfigured.store.saveSubscription({ subscription: sub('https://push/1') })
  const result = await unconfigured.notifier.deliver({ title: 'x' })
  assert.equal(result.reason, 'not-configured')
  assert.equal(unconfigured.notifier.configured(), false)
  // Still in the bell. A push that could not be sent is not an event that did not
  // happen.
  assert.equal((await unconfigured.store.ledger()).items.length, 1)
})

test('one thrown send does not stop the other devices', async () => {
  const { store, notifier } = await harness({
    send: async ({ subscription }) => {
      if (subscription.endpoint === 'https://push/bad') throw new Error('socket hang up')
      return { ok: true, status: 201, gone: false }
    },
  })
  await store.saveSubscription({ subscription: sub('https://push/bad') })
  await store.saveSubscription({ subscription: sub('https://push/good') })
  const result = await notifier.deliver({ title: 'x' })
  assert.equal(result.delivered, 1)
  assert.equal(result.results.find((r) => !r.ok).error, 'socket hang up')
})

test('the payload carries the badge, the deep link and the entry id', async () => {
  const { store, notifier, sent } = await harness()
  await store.saveSubscription({ subscription: sub('https://push/1') })
  await notifier.deliver({ title: 'Birthday', body: 'turns 65', url: '/brain', entryId: 'n_1' })
  const payload = JSON.parse(sent[0].payload)
  assert.equal(payload.notification.title, 'Birthday')
  assert.equal(payload.notification.navigate, '/brain')
  assert.equal(payload.data.entryId, 'n_1')
  assert.equal(payload.notification.app_badge, '1')
})

test('the drain sends what is due and finishes it', async () => {
  const { store, notifier, sent } = await harness()
  await store.saveSubscription({ subscription: sub('https://push/1') })
  await store.enqueue({ category: 'reminder.adhoc', title: 'Call the dentist', deliverAt: T0 })
  await store.enqueue({ category: 'reminder.adhoc', title: 'Later', deliverAt: T0 + 86_400_000 })

  const result = await notifier.drain({ at: T0 })
  assert.deepEqual(result.sent.map((s) => s.title), ['Call the dentist'])
  assert.equal(sent.length, 1)
  assert.equal((await store.listQueue({ state: 'delivered' })).length, 1)
  assert.equal((await store.listQueue({ state: 'pending' })).length, 1)
})

test('a fact that went stale is dropped at send time, not delivered wrong', async () => {
  const { store, notifier, sent } = await harness()
  await store.saveSubscription({ subscription: sub('https://push/1') })
  await store.enqueue({
    category: 'goal.nearcomplete', title: 'One more to finish', deliverAt: T0,
    revalidate: { collector: 'habits', factKey: 'weekly:business:3' },
  })
  const result = await notifier.drain({ at: T0, revalidate: async () => ({ state: 'stale' }) })
  assert.equal(sent.length, 0)
  assert.deepEqual(result.sent, [])
  assert.equal((await store.listQueue({ state: 'stale' })).length, 1)
})

test('a fact that turned into a win sends the other copy', async () => {
  const { store, notifier, sent } = await harness()
  await store.saveSubscription({ subscription: sub('https://push/1') })
  await store.enqueue({
    category: 'goal.nearcomplete', title: 'One more to finish', resolvedTitle: 'Done for the week — 4 of 4',
    deliverAt: T0, revalidate: { collector: 'habits', factKey: 'weekly:business:3' },
  })
  await notifier.drain({ at: T0, revalidate: async () => ({ state: 'resolved', body: 'nice' }) })
  const payload = JSON.parse(sent[0].payload)
  assert.equal(payload.notification.title, 'Done for the week — 4 of 4')
  assert.equal(payload.notification.body, 'nice')
})

test('a fact whose numbers moved is sent with the numbers it has now', async () => {
  const { store, notifier, sent } = await harness()
  await store.saveSubscription({ subscription: sub('https://push/1') })
  await store.enqueue({
    category: 'goal.nearcomplete', title: '"50 Miles Biked" is at 73%', body: 'One more push finishes it.',
    url: '/productivity/goals', deliverAt: T0, subject: 'g1',
    revalidate: { collector: 'goals', identity: 'near:g1', factKey: 'near:g1:73' },
  })
  await notifier.drain({
    at: T0,
    revalidate: async () => ({ state: 'changed', title: '"50 Miles Biked" is at 91%', body: '2 days left.', url: '/productivity/goals' }),
  })
  const payload = JSON.parse(sent[0].payload)
  assert.equal(payload.notification.title, '"50 Miles Biked" is at 91%')
  assert.equal(payload.notification.body, '2 days left.')

  // And the record agrees with the phone. A queue row still saying 73% is the
  // thing that made this look broken in the first place.
  const [delivered] = await store.listQueue({ state: 'delivered' })
  assert.match(delivered.title, /91%/)
  assert.equal(delivered.body, '2 days left.')
  assert.equal((await store.ledger()).items[0].title, '"50 Miles Biked" is at 91%')
})

test('a planned entry keeps the subject the revalidator needs to find it', async () => {
  // Without this the goals resolver looks up `undefined`, finds no goal, and
  // reports the goal finished.
  const { store } = await harness()
  await store.applyPlan({
    planId: 'p1', planDate: '2026-09-15', source: 'daily-digest',
    entries: [{
      category: 'goal.nearcomplete', factKind: 'goal.near-complete', title: 'at 73%',
      deliverAt: T0, subject: 'g1', revalidate: { collector: 'goals', identity: 'near:g1', factKey: 'near:g1:73' },
    }],
  })
  const [entry] = await store.listQueue({ state: 'pending' })
  assert.equal(entry.subject, 'g1')
})

test('a resolved fact with nothing good to say stays quiet', async () => {
  const { store, notifier, sent } = await harness()
  await store.saveSubscription({ subscription: sub('https://push/1') })
  await store.enqueue({
    category: 'habit.slipping', title: 'streak ends tonight', deliverAt: T0,
    revalidate: { collector: 'habits', factKey: 'daily:journal' },
  })
  await notifier.drain({ at: T0, revalidate: async () => ({ state: 'resolved' }) })
  assert.equal(sent.length, 0)
})

test('a collector that throws during revalidation fails closed', async () => {
  const { store, notifier, sent } = await harness()
  await store.saveSubscription({ subscription: sub('https://push/1') })
  await store.enqueue({
    category: 'habit.slipping', title: 'unverifiable', deliverAt: T0,
    revalidate: { collector: 'habits', factKey: 'x' },
  })
  await notifier.drain({ at: T0, revalidate: async () => { throw new Error('db locked') } })
  // Sending something that could not be verified is the failure the check exists
  // to prevent, so an error means silence.
  assert.equal(sent.length, 0)
  assert.equal((await store.listQueue({ state: 'stale' })).length, 1)
})

test('a late delivery says how late it is', async () => {
  const { store, notifier, sent } = await harness()
  await store.saveSubscription({ subscription: sub('https://push/1') })
  await store.enqueue({ category: 'reminder.adhoc', title: 'Call the dentist', body: 'about the crown', deliverAt: T0 })
  await notifier.drain({ at: T0 + 20 * 60_000 })
  assert.match(JSON.parse(sent[0].payload).notification.body, /about the crown · 20 min late/)
})

test('every delivery writes a feedback row, so effectiveness can be measured later', async () => {
  const { store, notifier } = await harness()
  await store.saveSubscription({ subscription: sub('https://push/1') })
  await store.enqueue({ category: 'habit.slipping', factKind: 'habit.streak-ending', title: 'streak', deliverAt: T0 })
  await notifier.drain({ at: T0 })
  const rows = await store.readFeedback()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].event, 'delivered')
  assert.equal(rows[0].factKind, 'habit.streak-ending')
})

test('a transient send failure leaves the entry retryable rather than delivered', async () => {
  const { store, notifier } = await harness({
    send: async () => ({ ok: false, gone: false, retryable: true, status: 500, error: 'boom' }),
  })
  await store.saveSubscription({ subscription: sub('https://push/1') })
  await store.enqueue({ category: 'reminder.adhoc', title: 'x', deliverAt: T0 })
  await notifier.drain({ at: T0 })
  assert.equal((await store.listQueue({ state: 'pending' })).length, 1)
  assert.equal((await store.listQueue({ state: 'delivered' })).length, 0)
})

test('a request the push service will always refuse is abandoned on the first try', async () => {
  // Apple answered `400 BadWebPushTopic` to every scheduled push while the test
  // button worked, and the entry burned three attempts pretending it might come
  // good. A 4xx that is not 404/410 is this server's bug and will not fix itself.
  let attempts = 0
  const { store, notifier } = await harness({
    send: async () => {
      attempts += 1
      return { ok: false, gone: false, retryable: false, status: 400, error: '{"reason":"BadWebPushTopic"}' }
    },
  })
  await store.saveSubscription({ subscription: sub('https://push/1') })
  await store.enqueue({ category: 'reminder.adhoc', title: 'x', deliverAt: T0 })
  await notifier.drain({ at: T0 })
  assert.equal(attempts, 1)
  const [failed] = await store.listQueue({ state: 'failed' })
  assert.match(failed.lastError, /BadWebPushTopic/)
  assert.equal((await store.listQueue({ state: 'pending' })).length, 0)
})

test('nothing to send to is not a send failure worth retrying', async () => {
  const { store, notifier } = await harness()
  await store.enqueue({ category: 'reminder.adhoc', title: 'x', deliverAt: T0 })
  await notifier.drain({ at: T0 })
  const [failed] = await store.listQueue({ state: 'failed' })
  assert.equal(failed.lastError, 'no-devices')
  assert.equal((await store.listQueue({ state: 'pending' })).length, 0)
})

test('the ledger keeps the fact kind, so a notification stays ratable after its entry is gone', async () => {
  // The queue entry is superseded by the next plan and pruned after a week. If
  // ratability were looked up through it, every rating older than that would
  // quietly become impossible.
  const { store, notifier } = await harness()
  await store.saveSubscription({ subscription: sub('https://push/1') })
  await store.enqueue({ category: 'habit.slipping', factKind: 'habit.streak-ending', title: 'streak', deliverAt: T0 })
  await notifier.drain({ at: T0 })

  const { items } = await store.ledger()
  assert.equal(items[0].factKind, 'habit.streak-ending')
})
