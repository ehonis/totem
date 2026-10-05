// Run with: node --test notify/feed.test.mjs
//
// A feed is the one collector whose input is unbounded and mostly uninteresting,
// so what is pinned here is restraint: the baseline scan says nothing, an item is
// news exactly once, a backlog never floods, and a dead source costs only itself.
import test from 'node:test'
import assert from 'node:assert/strict'
import { factsFor, scanFeeds, parseFeed, sameStory, stripOutletSuffix, googleNewsUrl, DEFAULT_SOURCES } from './feed.mjs'
import { TITLE_MAX } from './text.mjs'

const NOW = Date.UTC(2026, 8, 16, 12, 0)
const DAY = 86_400_000

const npmSource = { id: 't3-code', kind: 'npm', label: 'T3 Code', pkg: 't3', tags: ['latest'], category: 'news.release', salience: 85 }
const hnSource = { id: 'hn', kind: 'hn', label: 'Hacker News', minPoints: 500, category: 'news.big', salience: 55, maxPerScan: 2 }

test('the first sight of a package is a baseline, not news', () => {
  // Announcing the version he has been running for a week, the first time the
  // feature runs, is how it loses credibility on day one.
  const { facts, seen } = factsFor(npmSource, { versions: { latest: '0.0.42' } }, {}, { now: NOW })
  assert.deepEqual(facts, [])
  assert.equal(seen['v:latest'], '0.0.42')
})

test('a version change is news exactly once', () => {
  const first = factsFor(npmSource, { versions: { latest: '0.0.42' } }, {}, { now: NOW })
  const bumped = factsFor(npmSource, { versions: { latest: '0.0.43' } }, first.seen, { now: NOW })
  assert.equal(bumped.facts.length, 1)
  // Label in the title, content in the body — iOS truncates the title.
  assert.equal(bumped.facts[0].title, 'T3 Code released')
  assert.equal(bumped.facts[0].body, '0.0.43 is out, up from 0.0.42.')
  assert.equal(bumped.facts[0].category, 'news.release')

  const again = factsFor(npmSource, { versions: { latest: '0.0.43' } }, bumped.seen, { now: NOW })
  assert.deepEqual(again.facts, [])
})

test('a missing dist-tag is skipped rather than announced as null', () => {
  const { facts } = factsFor(npmSource, { versions: { latest: null } }, { 'v:latest': '0.0.42' }, { now: NOW })
  assert.deepEqual(facts, [])
})

const hit = (id, over = {}) => ({ id: `hn:${id}`, title: `Story ${id}`, url: `https://x/${id}`, at: NOW - 3600_000, points: 900, ...over })

test('the first scan of a feed records what is there and says nothing', () => {
  const { facts, seen } = factsFor(hnSource, { items: [hit(1), hit(2)] }, {}, { now: NOW })
  assert.deepEqual(facts, [])
  assert.deepEqual(seen.ids, ['hn:1', 'hn:2'])
})

test('only unseen items become facts', () => {
  const base = factsFor(hnSource, { items: [hit(1)] }, {}, { now: NOW })
  const next = factsFor(hnSource, { items: [hit(2), hit(1)] }, base.seen, { now: NOW })
  assert.deepEqual(next.facts.map((f) => f.subject), ['hn:2'])
})

test('a burst produces one notification about the rest, not one each', () => {
  const base = factsFor(hnSource, { items: [hit(0)] }, {}, { now: NOW })
  const burst = factsFor(hnSource, { items: [hit(1), hit(2), hit(3), hit(4), hit(5), hit(0)] }, base.seen, { now: NOW })
  // maxPerScan is 2, so two named and one summary.
  assert.equal(burst.facts.length, 3)
  assert.equal(burst.facts.at(-1).title, 'More from Hacker News')
  assert.match(burst.facts.at(-1).body, /3 others/)
  assert.ok(burst.facts.at(-1).salience < burst.facts[0].salience)
})

test('a feed that was unreachable for a week does not dump its backlog', () => {
  const base = factsFor(hnSource, { items: [hit(0)] }, {}, { now: NOW })
  const stale = factsFor(hnSource, { items: [hit(9, { at: NOW - 10 * DAY }), hit(0)] }, base.seen, { now: NOW })
  assert.deepEqual(stale.facts, [])
})

test('an item with no date is allowed through — absent is not old', () => {
  const base = factsFor(hnSource, { items: [hit(0)] }, {}, { now: NOW })
  const undated = factsFor(hnSource, { items: [hit(9, { at: null }), hit(0)] }, base.seen, { now: NOW })
  assert.equal(undated.facts.length, 1)
})

test('points raise salience, within a bound', () => {
  const base = factsFor(hnSource, { items: [hit(0)] }, {}, { now: NOW })
  const hot = factsFor(hnSource, { items: [hit(1, { points: 4000 }), hit(0)] }, base.seen, { now: NOW })
  assert.ok(hot.facts[0].salience > hnSource.salience)
  assert.ok(hot.facts[0].salience <= hnSource.salience + 10)
})

test('news never needs revalidating — it does not stop being true', () => {
  const base = factsFor(hnSource, { items: [hit(0)] }, {}, { now: NOW })
  const next = factsFor(hnSource, { items: [hit(1), hit(0)] }, base.seen, { now: NOW })
  assert.equal(next.facts[0].revalidate, null)
  assert.ok(next.facts[0].expiresAt > NOW)
})

test('the seen list is bounded, so the watermark cannot grow forever', () => {
  const many = Array.from({ length: 400 }, (_, i) => hit(i))
  const { seen } = factsFor(hnSource, { items: many }, { ids: ['hn:old'] }, { now: NOW })
  assert.ok(seen.ids.length <= 200)
})

test('parseFeed reads Atom and RSS, and strips the markup', () => {
  const atom = `<feed><entry><id>yt:video:abc</id><title>How Honey Got Away With It</title>
    <link rel="alternate" href="https://youtu.be/abc"/><published>2026-09-15T10:00:00+00:00</published></entry></feed>`
  const [a] = parseFeed(atom)
  assert.equal(a.id, 'yt:video:abc')
  assert.equal(a.title, 'How Honey Got Away With It')
  assert.equal(a.url, 'https://youtu.be/abc')

  const rss = `<rss><channel><item><guid>1</guid><title><![CDATA[Anthropic ships &amp; something]]></title>
    <link>https://e/1</link><pubDate>Tue, 15 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`
  const [r] = parseFeed(rss)
  assert.equal(r.title, 'Anthropic ships & something')
  assert.equal(r.url, 'https://e/1')
})

test('one dead source costs only itself', async () => {
  const sources = [
    { ...npmSource, id: 'good' },
    { ...npmSource, id: 'bad', pkg: 'nope' },
  ]
  const fetchImpl = async (url) => {
    if (url.includes('nope')) throw new Error('ECONNREFUSED')
    return { ok: true, json: async () => ({ 'dist-tags': { latest: '2.0.0' }, time: {} }) }
  }
  const seeded = { good: { 'v:latest': '1.0.0' } }
  const logged = []
  const { facts, state } = await scanFeeds({ sources, state: seeded, now: NOW, fetchImpl, log: (m) => logged.push(m) })

  assert.deepEqual(facts.map((f) => f.title), ['T3 Code released'])
  assert.deepEqual(facts.map((f) => f.body), ['2.0.0 is out, up from 1.0.0.'])
  assert.match(state.bad.lastError, /ECONNREFUSED/)
  assert.equal(state.good.lastOk, NOW)
  assert.equal(logged.length, 1)
})

test('a disabled source is not fetched at all', async () => {
  let called = false
  await scanFeeds({
    sources: [{ ...npmSource, enabled: false }],
    fetchImpl: async () => { called = true; return { ok: true, json: async () => ({}) } },
  })
  assert.equal(called, false)
})

test('every fact fits a lock screen: label in the title, story in the body', async () => {
  // The bug this pins: "A single firm is behind OpenAI, An…" in the title with
  // "631 points on Hacker News." in the body — the interesting half truncated,
  // the boring half in full.
  const long = 'A single firm is behind OpenAI, Anthropic, and Meta hacking scandals'
  const source = { ...hnSource, id: 'ai', headline: 'AI news' }
  const { facts } = factsFor(
    source,
    { items: [{ id: 'hn:new', title: long, url: 'https://x', at: NOW, points: 631 }] },
    { ids: ['hn:seed'] },
    { now: NOW },
  )
  assert.equal(facts[0].title, 'AI news')
  assert.ok(facts[0].title.length <= TITLE_MAX)
  assert.equal(facts[0].body, `${long} — 631 points.`)
})

test('the shipped sources are all public and need no key', () => {
  for (const s of DEFAULT_SOURCES) {
    assert.ok(['npm', 'rss', 'hn'].includes(s.kind), `${s.id}: unexpected kind`)
    assert.ok(s.category.startsWith('news.'), `${s.id}: should be a news category`)
    // An API key is a thing that expires silently, and silence is this feature's
    // failure mode.
    assert.ok(!JSON.stringify(s).match(/token|apiKey|secret/i), `${s.id}: needs a credential`)
  }
})

test('Hacker News keywords are matched here, not handed to a query that ignores them', async () => {
  // Algolia's `query` is full-text relevance with no boolean OR: asking it for
  // "Claude OR Anthropic OR OpenAI" matches none of them and returns whatever it
  // thinks is close — on the day this was written, an OCR post and a YC launch.
  let requested = null
  const hits = [
    { objectID: '1', title: 'Anthropic ships a new model', points: 300, created_at_i: NOW / 1000 },
    { objectID: '2', title: 'EU chief opens door for Canada', points: 900, created_at_i: NOW / 1000 },
    { objectID: '3', title: 'Show HN: my Gemini wrapper', points: 200, created_at_i: NOW / 1000 },
  ]
  const fetchImpl = async (url) => {
    requested = url
    return { ok: true, json: async () => ({ hits }) }
  }
  const source = { ...hnSource, id: 'ai', match: ['anthropic', 'gemini'], minPoints: 150 }
  // Seed the watermark so this is not treated as a baseline scan.
  const { facts } = await scanFeeds({
    sources: [source], state: { ai: { ids: ['hn:seed'] } }, now: NOW, fetchImpl,
  })

  assert.ok(!requested.includes('query='), 'the keywords must not be sent as a query')
  assert.ok(requested.includes('hitsPerPage=100'), 'a filtered feed needs a wide fetch')
  assert.deepEqual(facts.map((f) => f.subject), ['hn:1', 'hn:3'])
})

/* ------------------------------------------------- bundled news (world, good)
 *
 * A bundled source is the opposite of everything above: it does not interrupt
 * when it finds something, it collects and lands once, at an hour of its own.
 * What is pinned here is that collecting for hours cannot lose a story, and
 * delivering cannot repeat one. */

const SLOT = NOW + 6 * 3600_000
const worldSource = {
  id: 'world', kind: 'rss', label: 'World', headline: 'World news',
  bundle: 3, credit: true, deliverSlots: ['morning', 'evening'],
  category: 'news.world', salience: 45, maxAgeDays: 1,
}
const story = (id, title, over = {}) => ({ id: `w:${id}`, title, url: `https://x/${id}`, at: NOW - 3600_000, outlet: 'AP', ...over })

test('a bundle is one notification with several headlines, not several notifications', () => {
  const base = factsFor(worldSource, { items: [story(0, 'Seed story about nothing')] }, {}, { now: NOW, deliverAt: SLOT })
  const { facts } = factsFor(worldSource, {
    items: [story(1, 'Flood defences hold in Jakarta'), story(2, 'Rail strike ends in France', { outlet: 'Reuters' }), story(0, 'Seed story about nothing')],
  }, base.seen, { now: NOW, deliverAt: SLOT })

  assert.equal(facts.length, 1, 'one notification')
  assert.equal(facts[0].title, 'World news')
  assert.ok(facts[0].title.length <= TITLE_MAX)
  assert.deepEqual(facts[0].body.split('\n'), [
    'Flood defences hold in Jakarta (AP)',
    'Rail strike ends in France (Reuters)',
  ])
  // An appointment, not an interruption.
  assert.equal(facts[0].deliverAt, SLOT)
  assert.equal(facts[0].dedupeKey, `feed:world:${SLOT}`)
  assert.ok(facts[0].expiresAt > SLOT, 'headlines half a day late are not headlines')
})

test('the outlet is on the line when a source credits, and off when it does not', () => {
  const quiet = { ...worldSource, id: 'good', credit: false, headline: 'Some good news' }
  const base = factsFor(quiet, { items: [story(0, 'Seed story about nothing')] }, {}, { now: NOW, deliverAt: SLOT })
  const { facts } = factsFor(quiet, { items: [story(1, 'Beavers return to the river'), story(0, 'Seed story about nothing')] }, base.seen, { now: NOW, deliverAt: SLOT })
  assert.equal(facts[0].body, 'Beavers return to the river')
})

test('a scan before the hour rewrites the waiting roundup and loses nothing', () => {
  // The bug this pins: the 09:00 scan replaces the 07:00 scan's entry under the
  // same key, so if 07:00's stories were watermarked they would vanish from the
  // notification that actually goes out.
  const base = factsFor(worldSource, { items: [story(0, 'Seed story about nothing')] }, {}, { now: NOW, deliverAt: SLOT })
  const first = factsFor(worldSource, { items: [story(1, 'Flood defences hold in Jakarta'), story(0, 'Seed story about nothing')] }, base.seen, { now: NOW, deliverAt: SLOT })
  assert.match(first.facts[0].body, /Jakarta/)

  const second = factsFor(worldSource, {
    items: [story(2, 'Rail strike ends in France'), story(1, 'Flood defences hold in Jakarta'), story(0, 'Seed story about nothing')],
  }, first.seen, { now: NOW + 2 * 3600_000, deliverAt: SLOT })

  assert.equal(second.facts.length, 1)
  assert.match(second.facts[0].body, /Jakarta/, 'the earlier story is still in the roundup')
  assert.match(second.facts[0].body, /France/)
  assert.equal(second.facts[0].dedupeKey, first.facts[0].dedupeKey, 'same key, so it replaces rather than stacks')
})

test('a story that has already gone out never comes back in the next roundup', () => {
  const base = factsFor(worldSource, { items: [story(0, 'Seed story about nothing')] }, {}, { now: NOW, deliverAt: SLOT })
  const morning = factsFor(worldSource, { items: [story(1, 'Flood defences hold in Jakarta'), story(0, 'Seed story about nothing')] }, base.seen, { now: NOW, deliverAt: SLOT })

  // Past the hour it was for: delivered, and therefore history.
  const later = NOW + 7 * 3600_000
  const evening = factsFor(worldSource, {
    items: [story(2, 'Rail strike ends in France'), story(1, 'Flood defences hold in Jakarta')],
  }, morning.seen, { now: later, deliverAt: later + 3600_000 })

  assert.equal(evening.facts.length, 1)
  assert.ok(!evening.facts[0].body.includes('Jakarta'), 'already delivered')
  assert.match(evening.facts[0].body, /France/)
})

test('a scan that finds nothing leaves the waiting roundup alone', () => {
  const base = factsFor(worldSource, { items: [story(0, 'Seed story about nothing')] }, {}, { now: NOW, deliverAt: SLOT })
  const held = factsFor(worldSource, { items: [story(1, 'Flood defences hold in Jakarta'), story(0, 'Seed story about nothing')] }, base.seen, { now: NOW, deliverAt: SLOT })
  // The feed has since dropped the story, and nothing new has appeared.
  const quiet = factsFor(worldSource, { items: [story(0, 'Seed story about nothing')] }, held.seen, { now: NOW + 3600_000, deliverAt: SLOT })

  assert.deepEqual(quiet.facts, [], 'nothing to add')
  assert.deepEqual(quiet.seen.pending, ['w:1'], 'the queued roundup still owns that story')
  assert.equal(quiet.seen.pendingFor, SLOT)
})

test('the same event from three desks is one headline, not three', () => {
  const base = factsFor(worldSource, { items: [story(0, 'Seed story about nothing')] }, {}, { now: NOW, deliverAt: SLOT })
  const { facts } = factsFor(worldSource, {
    items: [
      story(1, 'Ceasefire agreed in Sudan after months of talks'),
      story(2, 'Sudan ceasefire agreed after months of negotiations', { outlet: 'Reuters' }),
      story(3, 'Iceland volcano erupts for the fourth time', { outlet: 'BBC' }),
      story(0, 'Seed story about nothing'),
    ],
  }, base.seen, { now: NOW, deliverAt: SLOT })

  const lines = facts[0].body.split('\n')
  assert.equal(lines.length, 2, 'the duplicate desk is dropped')
  assert.match(lines[0], /Sudan/)
  assert.match(lines[1], /Iceland/)
})

test('sameStory is strict — a wrong match silently deletes a real headline', () => {
  assert.ok(sameStory('Ceasefire agreed in Sudan after months of talks', 'Sudan ceasefire agreed after months of negotiations'))
  assert.ok(!sameStory('Iceland volcano erupts again', 'Sudan ceasefire agreed'))
  // Two short headlines about different things must not merge on one shared word.
  assert.ok(!sameStory('Markets rise', 'Markets fall'))
})

test('a bundle caps its headlines and says nothing about the rest', () => {
  const base = factsFor(worldSource, { items: [story(0, 'Seed story about nothing')] }, {}, { now: NOW, deliverAt: SLOT })
  const headlines = [
    'Iceland volcano erupts for the fourth time',
    'Rail strike ends in France',
    'Ceasefire agreed in Sudan',
    'Typhoon makes landfall near Manila',
    'Argentina devalues the peso',
    'Kenya opens its first geothermal plant',
    'Antarctic sea ice hits a record low',
  ]
  const items = headlines.map((title, i) => story(i + 1, title, { at: NOW - i * 60_000 }))
  const { facts } = factsFor(worldSource, { items: [...items, story(0, 'Seed story about nothing')] }, base.seen, { now: NOW, deliverAt: SLOT })

  assert.equal(facts.length, 1, 'never a second notification')
  const lines = facts[0].body.split('\n')
  assert.equal(lines.length, 3, 'three headlines, and no count of what was left out')
  assert.ok(!facts[0].body.includes('more'), '"…and 26 more" is a number he cannot act on')
  // Newest first: a roundup is the top of the hour, not the bottom of the queue.
  assert.match(lines[0], /Iceland/)
})

test('yesterday is not news — a bundled source sets its own window', () => {
  const base = factsFor(worldSource, { items: [story(0, 'Seed story about nothing')] }, {}, { now: NOW, deliverAt: SLOT })
  const { facts } = factsFor(worldSource, {
    items: [story(9, 'Something from the day before yesterday', { at: NOW - 2 * DAY }), story(0, 'Seed story about nothing')],
  }, base.seen, { now: NOW, deliverAt: SLOT })
  assert.deepEqual(facts, [])
})

test('several outlets in one source: one being down does not silence the others', async () => {
  const source = {
    ...worldSource,
    feeds: [
      { outlet: 'AP', googleNews: 'when:1d site:apnews.com' },
      { outlet: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
    ],
  }
  const rss = (title) => `<rss><channel><item><guid>${title}</guid><title>${title}</title><link>https://e/1</link><pubDate>${new Date(NOW - 3600_000).toUTCString()}</pubDate></item></channel></rss>`
  const fetchImpl = async (url) => {
    if (url.includes('news.google.com')) throw new Error('HTTP 429')
    return { ok: true, text: async () => rss('Flood defences hold in Jakarta') }
  }
  const { facts, state } = await scanFeeds({
    sources: [source], state: { world: { ids: ['w:seed'] } }, now: NOW, fetchImpl,
    deliverAt: () => SLOT,
  })
  assert.equal(facts.length, 1)
  assert.match(facts[0].body, /Jakarta/)
  assert.ok(!state.world.lastError, 'a partial read is a read')
})

test('every outlet being down is a real failure, reported as one', async () => {
  const source = { ...worldSource, feeds: [{ outlet: 'AP', googleNews: 'x' }, { outlet: 'BBC', url: 'https://b' }] }
  const logged = []
  const { facts, state } = await scanFeeds({
    sources: [source], state: { world: { ids: ['w:seed'] } }, now: NOW,
    fetchImpl: async () => { throw new Error('ECONNREFUSED') }, log: (m) => logged.push(m),
  })
  assert.deepEqual(facts, [])
  assert.match(state.world.lastError, /AP.*BBC/s)
  assert.equal(logged.length, 1)
})

test('a wire service is reached as a Google News search, with its suffix stripped', () => {
  const url = googleNewsUrl('when:1d site:apnews.com')
  assert.ok(url.startsWith('https://news.google.com/rss/search?q='))
  assert.ok(url.includes('site%3Aapnews.com'))
  assert.equal(stripOutletSuffix('Rail strike ends in France - Reuters'), 'Rail strike ends in France')
  // Only the trailing attribution, never a dash inside the headline itself.
  assert.equal(stripOutletSuffix('US-China talks resume - AP News'), 'US-China talks resume')
  assert.equal(stripOutletSuffix('No attribution here'), 'No attribution here')
})

test('the bundled sources deliver at an hour, not the moment they are found', () => {
  for (const s of DEFAULT_SOURCES.filter((x) => x.bundle)) {
    assert.ok(Array.isArray(s.deliverSlots) && s.deliverSlots.length, `${s.id}: a bundle needs its own hour`)
    assert.ok(s.bundle <= 3, `${s.id}: a lock screen is not a feed reader`)
    assert.ok(s.feeds?.length, `${s.id}: needs at least one feed`)
  }
})

test('a roundup takes one story per desk before a second from any', () => {
  // The bug this pins: the first live roundup was three Reuters headlines,
  // because Google News stamps a wire firehose fresher than the BBC's feed.
  const base = factsFor(worldSource, { items: [story(0, 'Seed story about nothing')] }, {}, { now: NOW, deliverAt: SLOT })
  const items = [
    story(1, 'Reuters leads on the markets', { outlet: 'Reuters', at: NOW - 60_000 }),
    story(2, 'Reuters also leads on the bonds', { outlet: 'Reuters', at: NOW - 120_000 }),
    story(3, 'Reuters has a third from the desk', { outlet: 'Reuters', at: NOW - 180_000 }),
    story(4, 'Typhoon makes landfall near Manila', { outlet: 'AP', at: NOW - 600_000 }),
    story(5, 'Antarctic sea ice hits a record low', { outlet: 'BBC', at: NOW - 900_000 }),
  ]
  const { facts } = factsFor(worldSource, { items: [...items, story(0, 'Seed story about nothing')] }, base.seen, { now: NOW, deliverAt: SLOT })
  const outlets = facts[0].body.split('\n').map((l) => l.match(/\(([^)]+)\)$/)[1])
  assert.deepEqual([...new Set(outlets)].sort(), ['AP', 'BBC', 'Reuters'], 'all three desks are represented')
})

test('a fast source keeps enough history not to re-announce itself', () => {
  // Eight scans a day across three wire feeds evicts a story from a 200-id
  // watermark while it is still sitting on the wire, and it comes back as news.
  const world = DEFAULT_SOURCES.find((s) => s.id === 'world')
  assert.ok(world.seenLimit > 200)
  const many = Array.from({ length: 300 }, (_, i) => story(i, `Headline ${i}`))
  const { seen } = factsFor(world, { items: many }, { ids: ['w:old'] }, { now: NOW, deliverAt: SLOT })
  // 300 seen plus the one already there; the three in the roundup are tracked
  // separately until it goes out.
  assert.equal(seen.ids.length + seen.pending.length, 301, 'nothing evicted yet')
})
