// Run with: node --test notify/digest.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNotifyStore } from './store.mjs'
import { createDigest, keepsFacts, parseCopy, factsForPrompt } from './digest.mjs'

const TZ = 'America/New_York'
const NOW = Date.UTC(2026, 8, 15, 11, 15) // 07:15 in New York

const fact = (over) => ({
  kind: 'habit.streak-ending',
  category: 'habit.slipping',
  salience: 60,
  slot: 'morning',
  title: 'a fact',
  body: '',
  revalidate: { collector: 'habits', factKey: 'k' },
  ...over,
})

async function harness({ facts = [], writeCopy = null, settings = () => ({}) } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'totem-digest-'))
  const store = createNotifyStore({
    queueFile: join(dir, 'q.json'),
    subscriptionsFile: join(dir, 's.json'),
    ledgerFile: join(dir, 'l.json'),
    feedbackFile: join(dir, 'f.jsonl'),
    now: () => NOW,
  })
  const digest = createDigest({
    collect: async () => ({ facts }),
    store,
    writeCopy,
    settings,
    // Short, so the timeout path is a fast test rather than a 90 second one.
    budgetMs: 50,
  })
  return { store, digest }
}

test('a quiet day is a skipped run, not a push that says nothing to report', async () => {
  const { digest, store } = await harness({ facts: [] })
  const result = await digest({ now: NOW, tz: TZ })
  assert.equal(result.status, 'skipped')
  assert.equal((await store.listQueue()).length, 0)
})

test('facts become queued entries at their own times', async () => {
  const { digest, store } = await harness({
    facts: [
      fact({ kind: 'birthday.today', category: 'person.birthday', salience: 100, title: 'Marion turns 65 today' }),
      fact({ slot: 'evening', title: 'streak ends tonight' }),
    ],
  })
  const result = await digest({ now: NOW, tz: TZ })
  assert.equal(result.status, 'ok')
  assert.equal(result.planned, 2)
  const queue = await store.listQueue()
  assert.deepEqual(queue.map((e) => e.title), ['Marion turns 65 today', 'streak ends tonight'])
  assert.ok(queue[1].deliverAt > queue[0].deliverAt)
})

test('the AI rewrites the wording and nothing else', async () => {
  const { digest, store } = await harness({
    facts: [fact({ title: 'Help the Business is 3 of 4', body: '2 days left' })],
    writeCopy: async () => [{ title: 'One more and Help the Business is done', body: '3 of 4, 2 days left.' }],
  })
  const result = await digest({ now: NOW, tz: TZ })
  assert.match(result.output, /in Totem's voice/)
  const [entry] = await store.listQueue()
  assert.equal(entry.title, 'One more and Help the Business is done')
})

test('a model that drops a fact loses its line, not the fact', async () => {
  const { digest, store } = await harness({
    facts: [fact({ title: 'Marion turns 65 today', body: '' })],
    // Warm, encouraging, and it has quietly lost both the name and the number.
    writeCopy: async () => [{ title: 'Someone special has a birthday!', body: 'Go wish them well.' }],
  })
  await digest({ now: NOW, tz: TZ })
  const [entry] = await store.listQueue()
  assert.equal(entry.title, 'Marion turns 65 today')
})

test('one bad line falls back alone, and the good ones keep the better wording', async () => {
  const { digest, store } = await harness({
    facts: [
      fact({ title: 'Marion turns 65 today', slot: 'morning' }),
      fact({ title: 'Sleep has been under goal', body: '7 of the last 7 days below 85%', slot: 'evening' }),
    ],
    writeCopy: async () => [
      { title: 'A birthday today!', body: 'nice' },
      { title: 'Sleep has been under goal for a week', body: '7 of the last 7 days below 85%.' },
    ],
  })
  await digest({ now: NOW, tz: TZ })
  const queue = await store.listQueue()
  assert.equal(queue.find((e) => e.title.includes('Marion')).title, 'Marion turns 65 today')
  assert.equal(queue.find((e) => e.title.includes('Sleep')).title, 'Sleep has been under goal for a week')
})

test('an AI that times out or throws still ships the digest', async () => {
  for (const writeCopy of [
    async () => { throw new Error('provider logged out') },
    async () => new Promise(() => {}), // never resolves
  ]) {
    const { digest, store } = await harness({ facts: [fact({ title: 'Marion turns 65 today' })], writeCopy })
    const result = await digest({ now: NOW, tz: TZ })
    assert.equal(result.status, 'ok')
    assert.match(result.output, /template wording/)
    assert.equal((await store.listQueue())[0].title, 'Marion turns 65 today')
  }
})

test('a reply with the wrong number of lines is rejected wholesale', async () => {
  const { digest, store } = await harness({
    facts: [fact({ title: 'one' }), fact({ title: 'two', slot: 'evening' })],
    writeCopy: async () => [{ title: 'only one line', body: '' }],
  })
  const result = await digest({ now: NOW, tz: TZ })
  assert.match(result.output, /template wording/)
  assert.deepEqual((await store.listQueue()).map((e) => e.title), ['one', 'two'])
})

test('re-planning the same day supersedes rather than duplicating', async () => {
  const { digest, store } = await harness({ facts: [fact({ title: 'a fact' })] })
  await digest({ now: NOW, tz: TZ })
  const second = await digest({ now: NOW, tz: TZ })
  assert.equal(second.superseded, 1)
  assert.equal((await store.listQueue()).length, 1)
})

test('a cap of zero plans nothing and says why', async () => {
  const { digest } = await harness({ facts: [fact({})], settings: () => ({ cap: 0 }) })
  const result = await digest({ now: NOW, tz: TZ })
  assert.equal(result.status, 'skipped')
  assert.match(result.output, /1 fact/)
})

test('keepsFacts catches a lost number or name, and allows a genuine rewrite', () => {
  const entry = { title: 'Help the Business is 3 of 4', body: '2 days left' }
  assert.equal(keepsFacts(entry, 'One more and Help the Business is done — 3 of 4, 2 days left.'), true)
  assert.equal(keepsFacts(entry, 'Nearly there on Help the Business, 2 days left.'), false) // lost 3 and 4
  assert.equal(keepsFacts(entry, 'You are 3 of 4 with 2 days to go.'), false)               // lost the name
})

test('parseCopy survives a code fence, a preamble, and an array', () => {
  const expected = [{ title: 'a', body: 'b' }, { title: 'c', body: 'd' }]
  assert.deepEqual(parseCopy('```json\n{"title":"a","body":"b"}\n{"title":"c","body":"d"}\n```'), expected)
  assert.deepEqual(parseCopy('Here you go:\n{"title":"a","body":"b"}\n{"title":"c","body":"d"}'), expected)
  assert.deepEqual(parseCopy('[{"title":"a","body":"b"},{"title":"c","body":"d"}]'), expected)
  assert.deepEqual(parseCopy('1. {"title":"a","body":"b"}\n2. {"title":"c","body":"d"}'), expected)
  assert.deepEqual(parseCopy('total nonsense'), [])
})

test('the prompt numbers the facts so line N maps to entry N', () => {
  assert.equal(
    factsForPrompt([{ title: 'first', body: 'x' }, { title: 'second', body: '' }]),
    '1. first — x\n2. second',
  )
})

test('the cap is a budget for the day, not for each run', async () => {
  // The evening digest planning four more on top of the four the morning already
  // delivered is how a notification budget quietly becomes twice what was asked.
  const { digest, store } = await harness({
    facts: [
      fact({ subject: 'a', title: 'first', slot: 'morning' }),
      fact({ subject: 'b', title: 'second', slot: 'evening' }),
    ],
    settings: () => ({ cap: 2 }),
  })
  await digest({ now: NOW, tz: TZ })

  // The morning's first entry goes out.
  const { claimed } = await store.claimDue({ at: NOW })
  await store.finish(claimed[0].id, { outcome: 'delivered' })

  // The evening run sees one already spent and plans only one more.
  const evening = await digest({ now: NOW, tz: TZ, source: 'evening-digest' })
  assert.equal(evening.planned, 1)
  const queue = await store.listQueue()
  assert.equal(queue.filter((e) => e.state === 'pending').length, 1)
  assert.equal(queue.filter((e) => e.state === 'delivered').length, 1)
})

test('a day already at its cap plans nothing and says why', async () => {
  const { digest, store } = await harness({
    facts: [fact({ subject: 'a', title: 'first' })],
    settings: () => ({ cap: 1 }),
  })
  await digest({ now: NOW, tz: TZ })
  const { claimed } = await store.claimDue({ at: NOW })
  await store.finish(claimed[0].id, { outcome: 'delivered' })

  const second = await digest({ now: NOW, tz: TZ, source: 'evening-digest' })
  assert.equal(second.status, 'skipped')
  assert.match(second.output, /already sent today, at the cap of 1/)
})

test('a later run replaces what an earlier one left undelivered', async () => {
  const { digest, store } = await harness({ facts: [fact({ subject: 'a', title: 'still true', slot: 'evening' })] })
  await digest({ now: NOW, tz: TZ })
  const evening = await digest({ now: NOW, tz: TZ, source: 'evening-digest' })
  assert.equal(evening.superseded, 1)
  const queue = await store.listQueue()
  assert.equal(queue.length, 1)
  assert.equal(queue[0].source, 'evening-digest')
})

test('an ad-hoc reminder is never superseded by a digest', async () => {
  const { digest, store } = await harness({ facts: [fact({ subject: 'a', title: 'planned' })] })
  await store.enqueue({ category: 'reminder.adhoc', title: 'Call the dentist', deliverAt: NOW + 3600_000 })
  await digest({ now: NOW, tz: TZ })
  await digest({ now: NOW, tz: TZ, source: 'evening-digest' })
  assert.ok((await store.listQueue()).some((e) => e.title === 'Call the dentist'))
})

test('a fact already delivered today is not re-planned by the evening run', async () => {
  const { digest, store } = await harness({
    facts: [fact({ subject: 'sleep', title: 'Sleep under goal', slot: 'evening' })],
  })
  await digest({ now: NOW, tz: TZ })
  // At its own slot, not hours past it: beyond the catch-up grace an entry is
  // recorded as missed rather than delivered.
  const [queued] = await store.listQueue()
  const { claimed } = await store.claimDue({ at: queued.deliverAt })
  await store.finish(claimed[0].id, { outcome: 'delivered' })

  const evening = await digest({ now: NOW, tz: TZ, source: 'evening-digest' })
  assert.equal(evening.status, 'skipped')
  assert.equal((await store.listQueue({ state: 'pending' })).length, 0)
})
