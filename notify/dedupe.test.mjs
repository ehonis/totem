// Run with: node --test notify/dedupe.test.mjs
//
// The gate exists because of real duplicates: a Cursor window spent for eleven
// days that pushed three times a day, a model launch that arrived once from the
// AI feed and again from the front-page feed, and one launch under two headlines.
// The fixtures below are synthetic, in the same shapes.
//
// And because a false "same story" deletes real news without a trace, half of
// this file is pairs that must both go out.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNotifyStore } from './store.mjs'
import { createNotifier } from './notifier.mjs'
import { createDigest } from './digest.mjs'
import { usageFacts } from './usage.mjs'
import { createPushHttpHandler } from './http.mjs'
import {
  createDedupeGate, canonicalUrl, storyScore, readHeadline, normalizeDedupeSettings, DEDUPE_DEFAULTS,
} from './dedupe.mjs'

const TZ = 'America/New_York'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 9, 23, 11, 15) // a Friday, 07:15 in New York
const VAPID = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:a@b.c' }

async function harness({ settings = null, tiebreak = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'totem-dedupe-'))
  let clock = T0
  const store = createNotifyStore({
    queueFile: join(root, 'q.json'),
    subscriptionsFile: join(root, 's.json'),
    ledgerFile: join(root, 'l.json'),
    feedbackFile: join(root, 'f.jsonl'),
    now: () => clock,
  })
  const pushes = []
  const transport = { failing: false }
  const make = () => {
    const gate = createDedupeGate({
      file: join(root, 'dedupe.json'),
      settingsFile: join(root, 'dedupe-settings.json'),
      now: () => clock,
      tiebreak,
      tiebreakMs: 200,
    })
    const notifier = createNotifier({
      store,
      vapid: VAPID,
      gate,
      sendImpl: async ({ payload }) => {
        if (transport.failing) return { ok: false, retryable: true, status: 503, error: 'unavailable' }
        pushes.push(JSON.parse(payload).data)
        return { ok: true, status: 201 }
      },
    })
    return { gate, notifier }
  }
  let { gate, notifier } = make()
  if (settings) await gate.saveSettings(settings)
  await store.saveSubscription({ subscription: { endpoint: 'https://push/phone', keys: { p256dh: 'p', auth: 'a' } }, label: 'phone' })
  return {
    root,
    store,
    pushes,
    transport,
    get gate() { return gate },
    get notifier() { return notifier },
    // A bridge restart: a new gate and notifier over the same files.
    restart() { ({ gate, notifier } = make()) },
    setNow(t) { clock = t },
    now: () => clock,
  }
}

const story = (category, title, url, over = {}) => ({
  category,
  title: category === 'news.big' ? 'Big on Hacker News' : 'AI news',
  body: `${title} — 512 points.`,
  url,
  story: { title, url },
  ...over,
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

/* ------------------------------------------------------------ usage state */

// One Cursor account, three meters, all spent until the same monthly reset: the
// shape the poller reports.
const RESET = T0 + 11 * DAY
const cursor = (resetsAt = RESET) => ({
  id: 'cursor:cursor-default',
  backend: 'cursor',
  displayName: 'Cursor',
  status: 'ok',
  meters: [
    { key: 'total', label: 'Included usage', usedPct: 100, windowMinutes: 30 * 24 * 60, resetsAt },
    { key: 'auto', label: 'Auto models', usedPct: 100, windowMinutes: 30 * 24 * 60, resetsAt },
    { key: 'api', label: 'Named API models', usedPct: 100, windowMinutes: 30 * 24 * 60, resetsAt },
  ],
})

// The bridge's digest path, end to end: collect, plan, queue, drain.
async function digestDay(h, accounts, at) {
  h.setNow(at)
  const digest = createDigest({
    collect: async ({ now }) => ({ facts: usageFacts({ accounts: typeof accounts === 'function' ? accounts(now) : accounts, now, tz: TZ }) }),
    store: h.store,
    sentKeys: (when) => h.gate.sentKeys(when),
    budgetMs: 50,
  })
  // The morning run and the midday one both re-collect the same facts.
  await digest({ now: at, tz: TZ, source: 'daily-digest' })
  await digest({ now: at + HOUR, tz: TZ, source: 'midday-digest' })
  const due = (await h.store.listQueue({ state: 'pending' })).map((e) => e.deliverAt).sort((a, b) => a - b)
  for (const when of due) {
    h.setNow(when + 1000)
    await h.notifier.drain({ at: when + 1000 })
  }
}

test('a spent Cursor window pushes once across polls, days and a restart', async () => {
  const h = await harness()
  for (let day = 0; day < 4; day += 1) {
    if (day === 2) h.restart()
    await digestDay(h, [cursor()], T0 + day * DAY)
  }
  assert.equal(h.pushes.length, 1, h.pushes.map((p) => p.title).join(' | '))
  // One account, one window: the three meters are one sentence.
  assert.match(h.pushes[0].body, /included usage, auto models and named api models are used up/)
})

test('a reset time reported a few seconds apart, either side of half past, is one window', async () => {
  const h = await harness()
  // The vendor reports 10:30:00 give or take five seconds on each poll.
  const half = Date.UTC(2026, 10, 3, 10, 30)
  const jitter = [-5000, 5000, -2000, 4000]
  for (let day = 0; day < jitter.length; day += 1) {
    await digestDay(h, [cursor(half + jitter[day])], T0 + day * DAY)
  }
  assert.equal(h.pushes.length, 1)
})

test('the next window is a new state and pushes again, once', async () => {
  const h = await harness()
  await digestDay(h, [cursor()], T0)
  const next = RESET + 30 * DAY
  await digestDay(h, [cursor(next)], RESET + DAY)
  h.restart()
  await digestDay(h, [cursor(next)], RESET + 2 * DAY)
  assert.equal(h.pushes.length, 2)
})

test('a usage nudge delivered directly is also held back after a restart', async () => {
  const h = await harness()
  const [fact] = usageFacts({ accounts: [cursor()], now: T0, tz: TZ })
  const send = () => h.notifier.deliver({ ...fact, dedupeKey: fact.dedupeKey, dedupeUntil: fact.dedupeUntil })
  assert.equal((await send()).ok, true)
  h.restart()
  const again = await send()
  assert.equal(again.suppressed, true)
  assert.equal(again.reason, 'same-key')
  // Past the reset the key is free again.
  h.setNow(RESET + HOUR)
  assert.equal((await send()).ok, true)
})

/* ------------------------------------------------- sent means it arrived */

test('a push that reached no device does not block the same key later', async () => {
  const h = await harness()
  const item = { category: 'usage.blocked', title: 'Quota spent', body: 'x', dedupeKey: 'usage:k:spent:w1', dedupeUntil: T0 + 10 * DAY }
  h.transport.failing = true
  const first = await h.notifier.deliver(item)
  assert.equal(first.ok, false)
  h.transport.failing = false
  h.setNow(T0 + HOUR)
  assert.equal((await h.notifier.deliver(item)).ok, true)
  assert.equal(h.pushes.length, 1)
})

test('a queued entry abandoned after three failed attempts leaves the key free for the next plan', async () => {
  const h = await harness()
  const dedupeUntil = T0 + 10 * DAY
  await h.store.enqueue({ category: 'usage.blocked', title: 'Quota spent', body: 'x', dedupeKey: 'usage:k:spent:w1', dedupeUntil, deliverAt: T0 })
  h.transport.failing = true
  for (let i = 1; i <= 3; i += 1) await h.notifier.drain({ at: T0 + i * 1000 })
  assert.equal((await h.store.listQueue())[0].state, 'failed')
  assert.equal((await h.gate.sentKeys(T0 + DAY)).size, 0)

  h.transport.failing = false
  h.setNow(T0 + DAY)
  await h.store.enqueue({ category: 'usage.blocked', title: 'Quota spent', body: 'x', dedupeKey: 'usage:k:spent:w1', dedupeUntil, deliverAt: T0 + DAY })
  await h.notifier.drain({ at: T0 + DAY + 1000 })
  assert.equal(h.pushes.length, 1)
})

test('a crash between admitting and confirming holds the key only for a few minutes', async () => {
  const h = await harness()
  const item = { category: 'usage.blocked', title: 'Quota spent', body: 'x', dedupeKey: 'usage:k:spent:w1', dedupeUntil: T0 + 10 * DAY }
  // Admitted, then the process dies before the push and confirm().
  assert.equal((await h.gate.admit(item)).action, 'send')
  h.restart()
  // Seconds later it is still in flight as far as anyone knows: not twice.
  h.setNow(T0 + MINUTE)
  assert.equal((await h.notifier.deliver(item)).suppressed, true)
  // Minutes later the reservation has lapsed.
  h.setNow(T0 + 6 * MINUTE)
  assert.equal((await h.notifier.deliver(item)).ok, true)
})

test('a repeat that arrives while the first is still going out is counted on the bell', async () => {
  const h = await harness()
  let release
  const gateOpen = new Promise((resolve) => { release = resolve })
  const notifier = createNotifier({
    store: h.store,
    vapid: VAPID,
    gate: h.gate,
    sendImpl: async ({ payload }) => { await gateOpen; h.pushes.push(JSON.parse(payload).data); return { ok: true, status: 201 } },
  })
  const first = notifier.deliver(story('news.model', 'Gemini 4 Carbon', 'https://example.com/a'))
  await settle()
  const second = await notifier.deliver(story('news.model', 'Gemini 4 Carbon is the new #1 on the leaderboard', 'https://example.com/b'))
  assert.equal(second.suppressed, true)
  release()
  await first
  const { items } = await h.store.ledger()
  assert.equal(items.length, 1)
  assert.equal(items[0].similar, 1)
})

/* ---------------------------------------------------------------- stories */

test('the same model launch from three feeds is one push', async () => {
  const h = await harness()
  const first = await h.notifier.deliver(story('news.model', 'Introducing GPT-9.2', 'https://openai.com/index/introducing-gpt-9-2/?utm_source=hn'))
  h.setNow(T0 + 2 * HOUR)
  const second = await h.notifier.deliver(story('news.model', 'OpenAI releases GPT-9.2, its new flagship model', 'https://example-news.com/2026/10/openai-gpt-9-2'))
  h.setNow(T0 + 6 * HOUR)
  const third = await h.notifier.deliver(story('news.big', 'GPT 9.2 is here', 'https://www.openai.com/index/introducing-gpt-9-2'))
  assert.equal(first.ok, true)
  assert.equal(second.suppressed, true)
  assert.equal(third.suppressed, true)
  assert.equal(h.pushes.length, 1)

  // Folded into the one he has, and counted there.
  const { items } = await h.store.ledger()
  assert.equal(items.length, 1)
  assert.equal(items[0].similar, 2)
  assert.equal(items[0].similarItems.length, 2)
})

// Every pair a reviewer found folded together that should not have been: each a
// different story about the same model, product or version.
const DIFFERENT = [
  ['OpenAI releases GPT-6.1', 'OpenAI delays GPT-6.1'],
  ['OpenAI releases GPT-6.1', 'OpenAI releases GPT-6.2'],
  ['Anthropic releases Claude Opus 5.5', 'Anthropic pulls Claude Opus 5.5 after outage'],
  ['OpenAI launches GPT-6.1', 'GPT-6.1 outage takes down ChatGPT'],
  ['Python 3.14 released', 'Python 3.14 security flaw found'],
  ['Google launches Gemini 4 in Europe', 'Google launches Gemini 4 in Japan'],
  ['Gemini 4 in Europe', 'Gemini 4 in Japan'],
  ['Apple announces iPhone 18', 'Apple recalls iPhone 18'],
  ['Claude Sonnet 5', 'Claude Haiku 5'],
  ['Show HN: My GPT-6 wrapper', 'OpenAI releases GPT-6'],
  ['OpenAI raises prices for API customers', 'OpenAI cuts prices for ChatGPT Plus'],
  ['Anthropic opens an office in Tokyo', 'Anthropic publishes interpretability research on Claude'],
  ['Top 10 Rust crates of the year', 'Top 10 Python libraries of the year'],
  // Follow-ups: the later headline names the original event and adds its own.
  ['OpenAI releases GPT-6.1', 'OpenAI GPT-6.1 release delayed in Europe'],
  ['OpenAI releases GPT-6.1', 'Lawsuit filed over OpenAI GPT-6.1 release'],
  ['Python 3.14 released', 'Python 3.14 release pulled over security flaw'],
  ['OpenAI launches GPT-6.1 in ChatGPT', 'Outage takes down ChatGPT hours after GPT-6.1 launch'],
  ['OpenAI launches GPT-6.1 in ChatGPT', 'OpenAI GPT-6.1 jailbroken within hours of release'],
  // Same name, maker and event; each with details of its own.
  ['OpenAI releases GPT-6.1 to Plus users', 'OpenAI releases GPT-6.1 to Enterprise customers worldwide'],
]

for (const [a, b] of DIFFERENT) {
  test(`two stories: "${a}" then "${b}" both go out`, async () => {
    const h = await harness()
    await h.notifier.deliver(story('news.model', a, 'https://a.example/1'))
    h.setNow(T0 + HOUR)
    const second = await h.notifier.deliver(story('news.model', b, 'https://b.example/2'))
    assert.equal(h.pushes.length, 2, JSON.stringify(storyScore({ title: b }, { title: a })))
    assert.equal(second.ok, true)
  })
}

test('a later headline that only adds the launch, or rewords it, is still the same story', async () => {
  const pairs = [
    ['Gemini 4 Carbon', 'Google launches Gemini 4 Carbon'],
    ['OpenAI launches GPT-6.1', 'GPT-6.1 is here'],
    ['Acme releases Nimbus 4.2, its new frontier model', 'Acme Nimbus 4.2 released'],
  ]
  for (const [a, b] of pairs) {
    const h = await harness()
    await h.notifier.deliver(story('news.model', a, 'https://a.example/1'))
    const second = await h.notifier.deliver(story('news.model', b, 'https://b.example/2'))
    assert.equal(second.suppressed, true, `${a} / ${b}: ${JSON.stringify(storyScore({ title: b }, { title: a }))}`)
  }
})

test('the same link with tracking stripped is the same story, whatever the headline says', async () => {
  const h = await harness()
  await h.notifier.deliver(story('news.model', 'A long read on agents', 'https://blog.example.org/posts/agents?utm_source=hn&utm_medium=rss'))
  const again = await h.notifier.deliver(story('news.big', 'Why everyone is talking about agents this week', 'http://www.blog.example.org/posts/agents/#comments'))
  assert.equal(again.suppressed, true)
  assert.equal(again.reason, 'same-story')
  assert.equal(h.pushes.length, 1)
})

test('a more urgent category stands in for a less urgent one, never the reverse', async () => {
  // The AI feed first, then the front page: one push.
  const down = await harness()
  await down.notifier.deliver(story('news.model', 'Acme releases Nimbus 4.2', 'https://a.example/1'))
  await down.notifier.deliver(story('news.big', 'Nimbus 4.2 from Acme is out', 'https://b.example/2'))
  assert.equal(down.pushes.length, 1)
  // The front page first, then the AI feed: the AI story is not hidden by it.
  const up = await harness()
  await up.notifier.deliver(story('news.big', 'Acme releases Nimbus 4.2', 'https://a.example/1'))
  await up.notifier.deliver(story('news.model', 'Nimbus 4.2 from Acme is out', 'https://b.example/2'))
  assert.equal(up.pushes.length, 2)
})

test('one Hacker News item crossing a second source floor two days later is still one push', async () => {
  const h = await harness()
  // The AI source (points > 150) finds it, then the front-page source (> 800).
  // Both key it by the item id; before the gate only a *pending* copy collapsed.
  await h.store.enqueue({ ...story('news.model', 'Company files to go public', 'https://sec.example.gov/s1'), factKind: 'feed.ai-models', subject: 'hn:1', dedupeKey: 'feed:hn:1', deliverAt: T0 })
  await h.notifier.drain({ at: T0 + 1000 })
  h.setNow(T0 + 47 * HOUR)
  await h.store.enqueue({ ...story('news.big', 'Company files to go public (S-1)', 'https://sec.example.gov/s1'), factKind: 'feed.hn-big', subject: 'hn:1', dedupeKey: 'feed:hn:1', deliverAt: T0 + 47 * HOUR })
  const { sent } = await h.notifier.drain({ at: T0 + 47 * HOUR + 1000 })
  assert.equal(h.pushes.length, 1)
  assert.equal(sent[0].suppressed, true)
  const entries = await h.store.listQueue()
  assert.deepEqual(entries.map((e) => e.state), ['delivered', 'suppressed'])
})

test('stories queued by one scan are compared with each other as they go out', async () => {
  const h = await harness()
  for (const [i, title] of ['Gemini 4 Carbon', 'Gemini 4 Carbon is the new #1 on the leaderboard'].entries()) {
    await h.store.enqueue({ ...story('news.model', title, `https://example.com/${i}`), dedupeKey: `feed:hn:${i}`, deliverAt: T0 })
  }
  await h.notifier.drain({ at: T0 + 1000 })
  assert.equal(h.pushes.length, 1)
})

test('a release is not a story: two versions with one releases page both go out', async () => {
  const h = await harness()
  const release = (v) => ({ category: 'news.release', title: 'T3 Code released', body: `${v} is out.`, url: 'https://github.com/owner/repo/releases', dedupeKey: `feed:t3-code:${v}` })
  await h.notifier.deliver(release('0.1.4'))
  await h.notifier.deliver(release('0.1.5'))
  assert.equal(h.pushes.length, 2)
})

test('only a notification that names its story is compared as one: a weekly summary is not', async () => {
  const h = await harness()
  await h.notifier.deliver(story('news.timex', 'Brand x Timex 40mm watch', 'https://example.com/w', { title: 'Timex collab' }))
  // Same category, no `story`, and a body that repeats the headline.
  const weekly = await h.notifier.deliver({ category: 'news.timex', title: 'Timex collab week', body: 'Brand x Timex 40mm watch', url: 'https://example.com/w', dedupeKey: 'timex-collab-weekly:2026-W43' })
  assert.equal(weekly.ok, true)
  assert.equal(h.pushes.length, 2)
})

/* --------------------------------------------------------------- settings */

test('settings: switched off, every repeat goes out and the planner skips nothing', async () => {
  const h = await harness({ settings: { enabled: false } })
  await h.notifier.deliver(story('news.model', 'Introducing GPT-9.2', 'https://openai.com/gpt-9-2'))
  await h.notifier.deliver(story('news.big', 'Introducing GPT-9.2', 'https://openai.com/gpt-9-2'))
  assert.equal(h.pushes.length, 2)

  await h.gate.saveSettings({ enabled: true })
  await h.notifier.deliver({ category: 'usage.blocked', title: 'Quota spent', dedupeKey: 'usage:k', dedupeUntil: T0 + DAY })
  assert.equal((await h.gate.sentKeys()).size, 1)
  await h.gate.saveSettings({ enabled: false })
  assert.equal((await h.gate.sentKeys()).size, 0)
})

test('settings: the story window and the categories are honoured', async () => {
  const h = await harness({ settings: { storyWindowHours: 12 } })
  await h.notifier.deliver(story('news.model', 'Gemini 4 Carbon', 'https://example.com/a'))
  h.setNow(T0 + 13 * HOUR)
  await h.notifier.deliver(story('news.model', 'Gemini 4 Carbon tops the leaderboard', 'https://example.com/b'))
  assert.equal(h.pushes.length, 2)

  await h.gate.saveSettings({ storyWindowHours: 48, storyCategories: ['news.big'] })
  await h.notifier.deliver(story('news.model', 'Gemini 4 Carbon is out', 'https://example.com/c'))
  assert.equal(h.pushes.length, 3)
})

test('settings: a stricter match line lets a near pair through', async () => {
  const pair = [
    story('news.model', 'Mistral Large 4 (Le Chonk) is now open weight', 'https://example.com/a'),
    story('news.model', 'Releasing the weights of Mistral Large 4', 'https://example.com/b'),
  ]
  const loose = await harness()
  for (const s of pair) await loose.notifier.deliver(s)
  assert.equal(loose.pushes.length, 1)

  const strict = await harness({ settings: { sameStoryScore: 0.95 } })
  for (const s of pair) await strict.notifier.deliver(s)
  assert.equal(strict.pushes.length, 2)
})

test('settings are normalised: out-of-range numbers are clamped, borderline never above the match line', () => {
  const s = normalizeDedupeSettings({ storyWindowHours: -5, sameStoryScore: 0.5, borderlineScore: 0.9, keyWindowHours: 'x' })
  assert.equal(s.storyWindowHours, 0)
  assert.equal(s.sameStoryScore, 0.5)
  assert.equal(s.borderlineScore, 0.5)
  assert.equal(s.keyWindowHours, DEDUPE_DEFAULTS.keyWindowHours)
  assert.equal(s.enabled, true)
  assert.deepEqual(normalizeDedupeSettings([1, 2]), normalizeDedupeSettings({}))
})

/* ----------------------------------------------------- keys without stories */

test('a job failing twice in its window with the same message pushes once, a different message pushes', async () => {
  const h = await harness()
  const fail = (body) => h.notifier.deliver({ category: 'job.failed', title: 'Outage watch could not check', body, tag: 'job:watch' })
  await fail('HTTP 503')
  h.setNow(T0 + 30 * MINUTE)
  assert.equal((await fail('HTTP 503')).suppressed, true)
  await fail('HTTP 401')
  h.setNow(T0 + 2 * HOUR)
  await fail('HTTP 503')
  assert.equal(h.pushes.length, 3)
})

test('a machine that goes down, comes back and goes down again is told all three times', async () => {
  const h = await harness()
  const fleet = (title, body) => h.notifier.deliver({ category: 'fleet.offline', title, body, url: '/fleet' })
  await fleet('box stopped reporting', 'No reading for 5 minutes.')
  h.setNow(T0 + 10 * MINUTE)
  await fleet('box is back', 'Reporting again.')
  h.setNow(T0 + 40 * MINUTE)
  const third = await fleet('box stopped reporting', 'No reading for 5 minutes.')
  assert.equal(third.ok, true)
  assert.deepEqual(h.pushes.map((p) => p.title), ['box stopped reporting', 'box is back', 'box stopped reporting'])
})

test('an external alert and an unknown category are never held back by their words', async () => {
  const h = await harness()
  for (const category of ['alert.external', 'some.new.category']) {
    await h.notifier.deliver({ category, title: 'Disk 95% full', body: 'on the box' })
    h.setNow(h.now() + 20 * MINUTE)
    await h.notifier.deliver({ category, title: 'Disk 95% full', body: 'on the box' })
  }
  assert.equal(h.pushes.length, 4)
})

test('pinned categories are never held back', async () => {
  const h = await harness()
  await h.notifier.deliver({ category: 'approval.pending', title: 'Approve 1234', body: 'code', dedupeKey: 'approval:1' })
  await h.notifier.deliver({ category: 'approval.pending', title: 'Approve 1234', body: 'code', dedupeKey: 'approval:1' })
  await h.notifier.deliver({ category: 'chat.finished', title: 'A chat', body: 'Done.' })
  await h.notifier.deliver({ category: 'chat.finished', title: 'A chat', body: 'Done.' })
  assert.equal(h.pushes.length, 4)
})

test('a queued entry retried after a failed send is not mistaken for its own repeat', async () => {
  const h = await harness()
  await h.store.enqueue({ ...story('news.model', 'Gemini 4 Carbon', 'https://example.com/g'), dedupeKey: 'feed:hn:9', deliverAt: T0 })
  h.transport.failing = true
  await h.notifier.drain({ at: T0 + 1000 })
  await h.notifier.drain({ at: T0 + 2000 })
  h.transport.failing = false
  await h.notifier.drain({ at: T0 + 3000 })
  assert.equal(h.pushes.length, 1)
  assert.equal((await h.store.listQueue())[0].state, 'delivered')
  // Three attempts, one notification: one row in the bell.
  assert.equal((await h.store.ledger()).items.length, 1)
})

test('a broken dedupe log fails open', async () => {
  const h = await harness()
  const broken = { admit: async () => { throw new Error('disk full') }, confirm: async () => { throw new Error('disk full') }, shouldHold: () => null }
  const notifier = createNotifier({ store: h.store, vapid: VAPID, gate: broken, sendImpl: async () => (h.pushes.push(1), { ok: true }) })
  assert.equal((await notifier.deliver({ category: 'news.model', title: 'x', body: 'y' })).ok, true)
})

test('the sent log is capped, oldest first', async () => {
  const h = await harness()
  for (let i = 0; i < 2100; i += 1) {
    await h.gate.admit({ category: 'news.release', title: 'r', dedupeKey: `release:${i}` })
  }
  const log = JSON.parse(await readFile(join(h.root, 'dedupe.json'), 'utf8'))
  assert.equal(log.sent.length, 2000)
  assert.equal(log.sent.at(-1).key, 'release:2099')
  assert.ok(!log.sent.some((r) => r.key === 'release:0'))
})

/* ------------------------------------------------------------- model check */

// Same name, nothing else in common, nothing ruling it out: the band where the
// heuristic cannot say.
const borderline = [
  story('news.model', 'Python 3.14 free-threading benchmarks', 'https://example.com/bench'),
  story('news.model', 'Python 3.14 released', 'https://example.com/release'),
]

async function queueBoth(h) {
  await h.notifier.deliver(borderline[0])
  await h.store.enqueue({ ...borderline[1], dedupeKey: 'feed:hn:2', deliverAt: T0 })
}

test('the model check is off by default and never asked', async () => {
  let asked = 0
  const h = await harness({ tiebreak: async () => { asked += 1; return true } })
  await queueBoth(h)
  await h.notifier.drain({ at: T0 + 1000 })
  assert.equal(asked, 0)
  assert.equal(h.pushes.length, 2)
})

test('the model check runs off the drain: the entry waits, and the next drain has the answer', async () => {
  let asked = 0
  const h = await harness({ settings: { modelCheck: true }, tiebreak: async () => { asked += 1; return true } })
  await queueBoth(h)
  // The first drain starts the check and does not wait for it.
  const first = await h.notifier.drain({ at: T0 + 1000 })
  assert.equal(first.sent[0].held, true)
  const [entry] = await h.store.listQueue()
  assert.equal(entry.state, 'pending')
  assert.equal(entry.attempts, 0)
  await settle()
  h.setNow(entry.deliverAt + 1000)
  await h.notifier.drain({ at: entry.deliverAt + 1000 })
  assert.equal(asked, 1)
  assert.equal(h.pushes.length, 1)
  const { items } = await h.gate.suppressed()
  assert.match(items[0].why, /model check said same/)
})

test('a direct push never waits on the model check', async () => {
  let asked = 0
  const h = await harness({ settings: { modelCheck: true }, tiebreak: async () => { asked += 1; return true } })
  for (const s of borderline) await h.notifier.deliver(s)
  assert.equal(asked, 0)
  assert.equal(h.pushes.length, 2)
})

test('clear pairs never reach the model check', async () => {
  let asked = 0
  const h = await harness({ settings: { modelCheck: true }, tiebreak: async () => { asked += 1; return true } })
  await h.notifier.deliver(story('news.model', 'Gemini 4 Carbon', 'https://example.com/a'))
  for (const [i, title] of ['Gemini 4 Carbon is the new #1', 'A guide to sourdough starters', 'OpenAI delays GPT-6.1'].entries()) {
    await h.store.enqueue({ ...story('news.model', title, `https://example.com/q${i}`), dedupeKey: `feed:hn:q${i}`, deliverAt: T0 })
  }
  await h.notifier.drain({ at: T0 + 1000 })
  assert.equal(asked, 0)
  assert.equal(h.pushes.length, 3)
})

test('the model check fails open: an error, a hang or a non-answer sends on the next drain', async () => {
  for (const tiebreak of [
    async () => { throw new Error('logged out') },
    () => new Promise(() => {}),
    async () => 'maybe',
  ]) {
    const h = await harness({ settings: { modelCheck: true }, tiebreak })
    await queueBoth(h)
    await h.notifier.drain({ at: T0 + 1000 })
    await new Promise((resolve) => setTimeout(resolve, 250)) // past the 200 ms budget
    const [entry] = await h.store.listQueue()
    await h.notifier.drain({ at: entry.deliverAt + 1000 })
    assert.equal(h.pushes.length, 2)
  }
})

/* ------------------------------------------------------------ audit, hold */

test('every suppression is logged with why, and countable over the settings route', async () => {
  const h = await harness()
  await h.notifier.deliver(story('news.model', 'Gemini 4 Carbon', 'https://example.com/a'))
  await h.notifier.deliver(story('news.big', 'Gemini 4 Carbon is the new #1', 'https://example.com/b'))
  const handler = createPushHttpHandler({ store: h.store, notifier: h.notifier })
  let status = 0
  let body = ''
  const res = { writeHead: (s) => { status = s }, end: (b) => { body = b } }
  const req = { method: 'GET', url: '/api/push/dedupe', headers: {}, [Symbol.asyncIterator]: async function* () {} }
  await handler(req, res)
  const out = JSON.parse(body)
  assert.equal(status, 200)
  assert.equal(out.suppressed, 1)
  assert.equal(out.items[0].reason, 'same-story')
  assert.match(out.items[0].why, /gemini4/)
  assert.equal(out.settings.storyWindowHours, 48)
})

test('a hold keeps a queued entry waiting without spending an attempt', async () => {
  const h = await harness()
  h.gate.addHold((entry) => (entry.category === 'news.model' ? { until: T0 + DAY } : null))
  await h.store.enqueue({ ...story('news.model', 'Gemini 4 Carbon', 'https://example.com/a'), deliverAt: T0 })
  await h.notifier.drain({ at: T0 + 1000 })
  const [entry] = await h.store.listQueue()
  assert.equal(entry.state, 'pending')
  assert.equal(entry.attempts, 0)
  assert.equal(entry.deliverAt, T0 + DAY)
  assert.equal(h.pushes.length, 0)
})

/* -------------------------------------------------------------- matching */

test('links: tracking, www, amp and trailing slashes do not make two links', () => {
  assert.equal(
    canonicalUrl('http://www.example.com/a/b/?utm_source=x&fbclid=y&id=3#frag'),
    canonicalUrl('https://example.com/a/b?id=3'),
  )
  assert.equal(canonicalUrl('https://example.com/story/amp'), 'https://example.com/story')
  // A whole site, or a releases page, is not one story.
  assert.equal(canonicalUrl('https://news.ycombinator.com/'), null)
  assert.equal(canonicalUrl('https://github.com/owner/repo/releases'), null)
  assert.equal(canonicalUrl('not a url'), null)
})

test('names: a model is found however a headline spells it', () => {
  const lead = (t) => [...readHeadline(t).lead]
  assert.ok(lead('GPT-6.1 Terra').includes('gpt6.1'))
  assert.ok(lead('OpenAI ships GPT 6.1').includes('gpt6.1'))
  assert.ok(lead('Claude Opus 5.5 is out').includes('opus5.5'))
  assert.ok(lead('Mistral Large 4 is now open weight').includes('mistrallarge4'))
  // A size or a count is not a product.
  assert.deepEqual(lead('Top 10 tools for 27B models'), [])
})

test('words: outlets, points and punctuation are not part of the story; event words meet', () => {
  const w = (t) => [...readHeadline(t).words]
  assert.deepEqual(w('Gemini launches — 512 points.'), w('Gemini launches'))
  assert.deepEqual(w('Gemini launches - AP News'), w('Gemini launches'))
  assert.deepEqual(w('Releases released releasing'), ['@launch'])
  assert.deepEqual([...readHeadline('Service outage takes it down').events], ['outage'])
})

test('scores: one launch under two headlines matches; a shared name alone is only borderline', () => {
  const same = storyScore({ title: 'Gemini 4 Carbon' }, { title: 'Gemini 4 Carbon is the new #1 on an intelligence index' })
  assert.ok(same.score >= DEDUPE_DEFAULTS.sameStoryScore && same.words >= DEDUPE_DEFAULTS.minWordOverlap, JSON.stringify(same))
  const named = storyScore(borderline[0].story, borderline[1].story)
  assert.ok(named.score >= DEDUPE_DEFAULTS.borderlineScore && named.score < DEDUPE_DEFAULTS.sameStoryScore, JSON.stringify(named))
  // Ruled out outright, not merely below the line. ("Gemini 4 in Europe" and "…in
  // Japan" share nothing but the name, so they are borderline instead.)
  for (const [a, b] of [...DIFFERENT.slice(0, 9), ...DIFFERENT.slice(-6)].filter(([a]) => a !== 'Gemini 4 in Europe')) {
    assert.equal(storyScore({ title: b }, { title: a }).different, true, `${a} / ${b}`)
  }
})
