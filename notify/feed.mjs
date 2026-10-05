// notify/feed.mjs — the outside world, filtered down to the handful of things
// worth interrupting for.
//
// Everything else in notify/ reads the owner's own data, where a fact is true or it
// is not. A feed is different: it is an unbounded stream of things that are all
// *true* and mostly *not interesting*, and it arrives whether or not anyone
// asked. So the design is mostly about restraint:
//
//   * A WATERMARK per source. Something is a fact the first time it is seen and
//     never again — a release announced on Tuesday is not news on Wednesday.
//   * A THRESHOLD, per source, not per item. Hacker News with no points floor is
//     a firehose; with one it is a front page.
//   * A CAP per scan, so a source that suddenly publishes forty things produces
//     one notification about forty things rather than forty notifications.
//   * NO AI in the loop. A model asked "is this big?" will answer yes, because
//     that is the more helpful-sounding answer. Points, version numbers and
//     keyword matches do not flatter anyone.
//
// Every source is public and unauthenticated on purpose: an API key is a thing
// that expires silently, and the failure mode of this feature is silence.
//
// ON TITLES. iOS gives a notification ONE bold line for the title, truncated
// around 34 characters on a phone, then the app name, then the body — which
// wraps to several lines. So the title is a label and the body is the content.
// Putting a headline in the title produced "A single firm is behind OpenAI,
// An…" with "631 points on Hacker News." underneath: the interesting half cut
// off, the boring half in full. `headline` below is the label; the item's own
// text goes in the body where it has room.

// ON BUNDLES. The rules above are sized for a release or a front-page story —
// things that happen a few times a week. World news happens continuously, and a
// story-by-story stream of it is the one thing this feature was asked never to
// be ("I don't want it to ruin my day"). So a source may set `bundle: n` and
// `deliverSlots`, and then it behaves completely differently: it collects
// quietly all day and lands as ONE notification at a fixed hour, n headlines in
// the body. A later scan REPLACES the one waiting rather than stacking a second
// — which is why an undelivered bundle's stories stay un-watermarked, or the
// replacement would silently drop everything the earlier scan had found.

const DAY = 86_400_000

/* ------------------------------------------------------------------ sources */

// `kind` picks the fetcher and the diff. Anything here can be edited, disabled
// or added to without touching the code below.
export const DEFAULT_SOURCES = [
  {
    id: 't3-code',
    kind: 'npm',
    label: 'T3 Code',
    headline: 'T3 Code released',
    pkg: 't3',
    // The editor he actually works in. A nightly moves most days, so only the
    // stable tag is worth a notification; the nightly is noise by design.
    tags: ['latest'],
    category: 'news.release',
    salience: 85,
    url: 'https://github.com/pingdotgg/t3code/releases',
    // A release he is behind stages a confirm-only inbox proposal, and the push
    // links to it. See notify/updates.mjs.
    update: {
      // The CLI isn't on PATH; the service writes what it is running.
      installed: { kind: 'json', file: '~/.t3/runtime/service-state.json', key: 'activeVersion' },
      command: 'npx -y t3@latest service update',
      // `service update` targets the same t3code.service unit whichever channel
      // it runs from, so pointing this at a nightly build is a silent channel
      // swap rather than an update. Stable installs only.
      channel: 'stable',
      what: 'Runs `npx -y t3@latest service update`, which installs the current stable T3 Code into the t3code.service unit and restarts it.',
      // Downloading and pinning a runtime takes longer than the 60s default.
      timeout: 600,
    },
  },
  {
    id: 'claude-code',
    kind: 'npm',
    label: 'Claude Code',
    headline: 'Claude Code released',
    pkg: '@anthropic-ai/claude-code',
    tags: ['latest'],
    category: 'news.release',
    salience: 80,
    url: 'https://github.com/anthropics/claude-code/releases',
    update: {
      // Installed by the native installer under ~/.local/share/claude, NOT as a
      // global npm package — `npm i -g` here would leave two copies and a stale
      // symlink. Ask the binary itself.
      installed: { kind: 'command', command: 'claude --version' },
      command: 'claude update',
      channel: 'stable',
      what: 'Runs `claude update`, which installs the current Claude Code release over the one in ~/.local/share/claude.',
      timeout: 300,
    },
  },
  {
    id: 'theo',
    kind: 'rss',
    label: 'Theo',
    headline: 'Theo posted',
    // YouTube publishes a real Atom feed per channel, no key and no scraping.
    // X itself has no free API and no reliable public feed — see the note in
    // docs/notifications.md — so this is the closest honest proxy.
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCtuO2h6OwDueF7h3p8DYYjQ',
    category: 'news.creator',
    salience: 60,
    maxPerScan: 2,
  },
  {
    id: 'ai-models',
    kind: 'hn',
    label: 'AI',
    headline: 'AI news',
    // Matched HERE rather than in the query, because Algolia's `query` is
    // full-text relevance and has no boolean OR — "Claude OR Anthropic" quietly
    // matches neither and returns whatever it thinks is close, which on the day
    // this was written meant an OCR post and a YC launch. Fetch broad, filter
    // exactly.
    match: [
      'claude', 'anthropic', 'openai', 'chatgpt', 'gpt-', 'gemini', 'llama',
      'mistral', 'deepseek', 'grok', 'qwen', 'llm', 'frontier model',
    ],
    // Low enough to catch a launch in its first hours, since the keyword filter
    // is doing the real narrowing.
    minPoints: 150,
    category: 'news.model',
    salience: 75,
    maxPerScan: 3,
  },
  {
    id: 'world',
    kind: 'rss',
    label: 'World',
    headline: 'World news',
    // "Unbiased" is not a thing a source can be, but a wire service is the
    // closest the trade has: AP and Reuters sell the same copy to outlets across
    // the whole political spectrum, which is a commercial reason to report what
    // happened rather than what to think about it. Neither publishes a public
    // RSS feed any more (AP's 403s, Reuters retired its own in 2020) and both
    // still syndicate through Google News, which is why these two are search
    // queries rather than URLs. BBC World is the third because it is a real
    // feed, it is not American, and a story all three carry is a story.
    feeds: [
      { outlet: 'AP', googleNews: 'when:1d site:apnews.com' },
      { outlet: 'Reuters', googleNews: 'when:1d site:reuters.com' },
      { outlet: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
    ],
    // Three headlines, twice a day. Not a feed to scroll — a thing to have read.
    bundle: 3,
    // Reading three outlets means the same event arrives three times; `credit`
    // puts the outlet on each line so it is visible which one it came from.
    credit: true,
    deliverSlots: ['morning', 'evening'],
    category: 'news.world',
    salience: 45,
    url: 'https://apnews.com/hub/world-news',
    // Yesterday's headline is not news, and the morning bundle is allowed to
    // reach back over the night it slept through.
    maxAgeDays: 1,
    // Eight scans a day across three fast feeds. 200 would roll over inside a day
    // and start re-announcing stories still sitting on the wire.
    seenLimit: 800,
  },
  {
    id: 'good',
    kind: 'rss',
    label: 'Good news',
    headline: 'Some good news',
    // The other half of the ask: "get good stories out of it." These three are
    // solutions-and-progress desks rather than the viral-animal genre — they
    // report things that actually happened, which is the only reason they are
    // allowed to sit beside the wire services.
    feeds: [
      { outlet: 'Good News Network', url: 'https://www.goodnewsnetwork.org/feed/' },
      { outlet: 'Positive News', url: 'https://www.positive.news/feed/' },
      { outlet: 'Reasons to be Cheerful', url: 'https://reasonstobecheerful.world/feed/' },
    ],
    bundle: 2,
    // No outlet credit here. On a world headline the source is part of the
    // claim; on a good story it is 22 characters of "Reasons to be Cheerful"
    // eating the line the story needed.
    credit: false,
    // Its own hour, deliberately away from the world bundles. A good story
    // stapled to the bottom of the hard news is a good story nobody reads.
    deliverSlots: ['midday'],
    category: 'news.good',
    salience: 40,
    url: 'https://www.goodnewsnetwork.org/',
    // These publish a few times a week, not hourly, so a four-day window is what
    // keeps the midday slot from being empty most days.
    maxAgeDays: 4,
  },
  {
    id: 'hn-big',
    kind: 'hn',
    label: 'Hacker News',
    headline: 'Big on Hacker News',
    // The "something genuinely big happened" line. Deliberately much higher than
    // the AI one: a general story needs to be enormous to beat his own day.
    minPoints: 800,
    category: 'news.big',
    salience: 55,
    maxPerScan: 2,
  },
]

/* ------------------------------------------------------------------ fetching */

const timeout = (ms) => AbortSignal.timeout(ms)

// AP and Reuters both retired their public RSS feeds and both still syndicate
// through Google News, so a wire service is reachable as a search rather than a
// URL. No key, no scraping, and the query is readable in the source list above.
export const googleNewsUrl = (query) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`

// Google News appends " - AP News" to every title. The outlet is already on the
// line (or deliberately left off), so this is duplication that costs characters
// on the one screen where characters are scarce.
export const stripOutletSuffix = (title) =>
  String(title).replace(/\s+-\s+[^-]{2,30}$/, '').trim() || String(title)


async function getJson(url, fetchImpl, ms = 8000) {
  const r = await fetchImpl(url, {
    signal: timeout(ms),
    headers: { accept: 'application/json', 'user-agent': 'totem-bridge/1.0' },
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

async function getText(url, fetchImpl, ms = 8000) {
  const r = await fetchImpl(url, {
    signal: timeout(ms),
    headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', 'user-agent': 'totem-bridge/1.0' },
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.text()
}

// Atom and RSS in one pass. Deliberately a regex rather than a parser: these are
// two well-known feed shapes, and a dependency for twenty lines is a dependency
// that has to be kept current forever.
export function parseFeed(xml, limit = 10) {
  const out = []
  const blocks = String(xml).matchAll(/<(entry|item)\b[\s\S]*?<\/\1>/gi)
  for (const [block] of blocks) {
    const title = decode(tag(block, 'title'))
    const id = decode(tag(block, 'id')) || decode(tag(block, 'guid')) || title
    const link = block.match(/<link[^>]*href="([^"]+)"/i)?.[1] || decode(tag(block, 'link'))
    const published = decode(tag(block, 'published')) || decode(tag(block, 'updated')) || decode(tag(block, 'pubDate'))
    if (!title) continue
    out.push({ id, title, url: link || null, at: published ? Date.parse(published) : null })
    if (out.length >= limit) break
  }
  return out
}

const tag = (xml, name) => xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || ''

const decode = (s) => String(s)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim()

async function readSource(source, fetchImpl) {
  if (source.kind === 'npm') {
    const doc = await getJson(`https://registry.npmjs.org/${encodeURIComponent(source.pkg).replace('%40', '@')}`, fetchImpl)
    const tags = doc['dist-tags'] || {}
    return {
      versions: Object.fromEntries((source.tags || ['latest']).map((t) => [t, tags[t] || null])),
      // `time` carries the publish date, which is what makes "released 3 hours
      // ago" possible rather than "released at some point".
      at: source.tags?.[0] && doc.time?.[tags[source.tags[0]]] ? Date.parse(doc.time[tags[source.tags[0]]]) : null,
    }
  }

  if (source.kind === 'rss') {
    // One feed or several. Several is what makes a wire-service bundle possible:
    // reading AP, Reuters and the BBC together is the whole "unbiased" claim, and
    // any one of them being down must not silence the other two. All three down
    // is a real failure and is reported as one.
    const feeds = source.feeds || [{ url: source.url }]
    const items = []
    const failures = []
    for (const feed of feeds) {
      const url = feed.url || googleNewsUrl(feed.googleNews)
      try {
        for (const item of parseFeed(await getText(url, fetchImpl), source.perFeed || 10)) {
          items.push({
            ...item,
            title: feed.googleNews ? stripOutletSuffix(item.title) : item.title,
            outlet: feed.outlet || null,
          })
        }
      } catch (e) {
        failures.push(`${feed.outlet || url}: ${e.message || e}`)
      }
    }
    if (!items.length && failures.length) throw new Error(failures.join('; '))
    return { items }
  }

  if (source.kind === 'hn') {
    const params = new URLSearchParams({
      numericFilters: `points>${source.minPoints || 200}`,
      // Wide, because the keyword filter below is what narrows it. 20 was enough
      // for an untargeted feed and far too few for a filtered one.
      hitsPerPage: source.match ? '100' : '20',
      tags: 'story',
    })
    if (source.query) params.set('query', source.query)
    const doc = await getJson(`https://hn.algolia.com/api/v1/search_by_date?${params}`, fetchImpl)
    const matcher = source.match
      ? new RegExp(source.match.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
      : null
    return {
      items: (doc.hits || [])
        .filter((h) => h.title && (!matcher || matcher.test(h.title)))
        .map((h) => ({
          id: `hn:${h.objectID}`,
          title: h.title,
          url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
          at: h.created_at_i ? h.created_at_i * 1000 : null,
          points: h.points,
        })),
    }
  }

  throw new Error(`unknown source kind ${source.kind}`)
}

/* ------------------------------------------------------------------ diffing */

// Three outlets covering the same morning means the same event arrives three
// times, and a bundle of three headlines that are all one story is worse than a
// bundle of one. Word overlap, not a model: "is this the same story?" is exactly
// the question an AI answers agreeably, and a wrong yes silently deletes a real
// headline.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'after', 'over', 'into', 'that', 'this',
  'its', 'his', 'her', 'their', 'says', 'say', 'said', 'new', 'are', 'was',
  'were', 'has', 'have', 'will', 'amid', 'but', 'not', 'how', 'why', 'who',
])

export function storyWords(title) {
  return new Set(
    String(title).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  )
}

/** Same event, different desk. Deliberately strict: a false merge loses news. */
export function sameStory(a, b) {
  const x = storyWords(a)
  const y = storyWords(b)
  const smaller = Math.min(x.size, y.size)
  // Two three-word headlines sharing two words is a coincidence, not a match.
  if (smaller < 3) return false
  let shared = 0
  for (const w of x) if (y.has(w)) shared += 1
  return shared >= 3 && shared / smaller >= 0.5
}

// One story per desk, in turn. Without this the first live roundup was three
// Reuters headlines: Google News timestamps a wire service's own firehose fresher
// than the BBC's, so a straight newest-first sort hands the whole bundle to
// whichever outlet publishes fastest — which quietly undoes the reason three of
// them are being read.
function interleaveByOutlet(items) {
  const desks = new Map()
  for (const item of items) {
    const key = item.outlet || ''
    if (!desks.has(key)) desks.set(key, [])
    desks.get(key).push(item)
  }
  const queues = [...desks.values()]
  const out = []
  for (let i = 0; queues.some((q) => q.length > i); i += 1) {
    for (const q of queues) if (q[i]) out.push(q[i])
  }
  return out
}

function dropRepeats(items) {
  const kept = []
  for (const item of items) {
    if (kept.some((k) => sameStory(k.title, item.title))) continue
    kept.push(item)
  }
  return kept
}

/**
 * Turn one source's payload into facts, given what has already been seen.
 *
 * Pure, so every rule below is testable without the network: the first-run
 * behaviour, the watermark, the per-scan cap, and the age cutoff.
 */
export function factsFor(source, payload, seen = {}, { now = Date.now(), maxAgeDays = 3, deliverAt = now } = {}) {
  const facts = []
  const next = { ...seen }

  if (source.kind === 'npm') {
    for (const [tagName, version] of Object.entries(payload.versions || {})) {
      if (!version) continue
      const key = `v:${tagName}`
      const previous = seen[key]
      next[key] = version
      // First sight of a package is not news — it is the baseline. Announcing
      // "T3 Code 0.0.42 is out" the first time the feature runs, about a version
      // he has been using for a week, is how a feature loses its credibility on
      // day one.
      if (!previous || previous === version) continue
      facts.push({
        kind: `release.${source.id}`,
        category: source.category,
        salience: source.salience,
        slot: null,
        subject: `${source.id}:${version}`,
        title: source.headline || `${source.label} released`,
        // "You were on X" used to mean the version npm published *before* this
        // one, which is not the same claim as what this box is running and read
        // exactly like it was. The caller replaces this line with the real one
        // once it has asked the box; this is what ships if it cannot.
        body: `${version} is out, up from ${previous}.`,
        url: source.url || null,
        expiresAt: now + 2 * DAY,
        revalidate: null,
        // Read by the update path, which needs the number rather than the
        // sentence it ended up in.
        release: { sourceId: source.id, version, previous },
      })
    }
    return { facts, seen: next }
  }

  const items = payload.items || []
  const known = new Set(seen.ids || [])

  // A bundle whose hour has passed has gone out, and its stories are history. One
  // still waiting in the queue has not: the next scan replaces it under the same
  // dedupe key, so those items must stay eligible or the replacement would drop
  // every headline the earlier scan had found.
  const held = seen.pendingFor && now < seen.pendingFor ? new Set(seen.pending || []) : new Set()
  for (const id of seen.pending || []) if (!held.has(id)) known.add(id)

  const maxAge = (source.maxAgeDays || maxAgeDays) * DAY
  const fresh = items.filter((item) => {
    if (known.has(item.id)) return false
    // A feed that has been unreachable for a week must not dump its backlog the
    // moment it comes back.
    if (item.at && now - item.at > maxAge) return false
    return true
  })

  // The baseline rule again: the first scan of a feed records what is there and
  // says nothing.
  if (!seen.ids) {
    next.ids = items.map((i) => i.id).slice(0, source.seenLimit || 200)
    if (source.bundle) { next.pending = []; next.pendingFor = null }
    return { facts, seen: next }
  }

  const cap = source.bundle || source.maxPerScan || 3
  // A bundle is the day's top n, so it ranks by recency and collapses repeats
  // first. An unbundled source keeps its original order — that is the burst rule,
  // where "the rest" is a count rather than a ranking.
  const ranked = source.bundle
    ? dropRepeats(interleaveByOutlet([...fresh].sort((a, b) => (b.at || 0) - (a.at || 0))))
    : fresh
  const chosen = ranked.slice(0, cap)

  // Everything observed is watermarked, except what is going into a bundle that
  // has not been delivered yet.
  const holding = source.bundle ? new Set(chosen.map((i) => i.id)) : new Set()
  // Three wire feeds turn over fast enough to evict their own recent history from
  // a 200-id watermark inside a day, and an evicted story that is still on the
  // feed comes back as news. A bundled source sets its own headroom.
  next.ids = [...items.map((i) => i.id).filter((id) => !holding.has(id)), ...known].slice(0, source.seenLimit || 200)

  if (source.bundle) {
    // Nothing to say, but a bundle may still be sitting in the queue holding
    // stories. Clearing the watermark here would let those exact stories come
    // back as new and turn up a second time in the next roundup.
    if (!chosen.length) {
      next.pending = held.size ? (seen.pending || []) : []
      next.pendingFor = held.size ? seen.pendingFor : null
      return { facts, seen: next }
    }
    next.pending = [...holding]
    next.pendingFor = deliverAt

    // One headline per line, and no "…and 26 more". The burst rule above exists
    // to say "you are missing things", which is the right thing to say about a
    // release. Saying it about the world is a number nobody can act on, attached
    // to exactly the feeling this feature is meant not to give. Three headlines and a tap
    // through to the wire is the whole promise.
    const lines = chosen.map((item) => (source.credit && item.outlet ? `${item.title} (${item.outlet})` : item.title))

    facts.push({
      kind: `feed.${source.id}`,
      category: source.category,
      salience: source.salience,
      slot: null,
      // Identified by the hour it is for, not by its contents: that is what makes
      // the next scan replace the waiting bundle instead of queueing a second.
      subject: `${source.id}:${deliverAt}`,
      dedupeKey: `feed:${source.id}:${deliverAt}`,
      deliverAt,
      title: source.headline || source.label,
      body: lines.join('\n'),
      url: source.url || null,
      // Headlines delivered half a day late are not headlines. A box that was
      // asleep through the slot drops them rather than opening with yesterday.
      expiresAt: deliverAt + (source.expiresAfterHours || 6) * 3600_000,
      revalidate: null,
    })
    return { facts, seen: next }
  }

  for (const item of chosen) {
    facts.push({
      kind: `feed.${source.id}`,
      category: source.category,
      salience: source.salience + (item.points ? Math.min(Math.round(item.points / 200), 10) : 0),
      slot: null,
      subject: item.id,
      // Label in the title, the story itself in the body — see the note above.
      title: source.headline || source.label,
      body: item.points ? `${item.title} — ${item.points} points.` : item.title,
      url: item.url,
      expiresAt: now + 2 * DAY,
      revalidate: null,
    })
  }

  // One notification about the overflow rather than a notification each.
  if (fresh.length > chosen.length) {
    facts.push({
      kind: `feed.${source.id}.more`,
      category: source.category,
      salience: source.salience - 20,
      slot: null,
      subject: `${source.id}:more:${fresh.length}`,
      title: `More from ${source.label}`,
      body: `${fresh.length - chosen.length} other${fresh.length - chosen.length === 1 ? '' : 's'} worth a look${chosen.length ? ', beyond the ones above' : ''}.`,
      url: source.kind === 'hn' ? 'https://news.ycombinator.com/' : source.url || null,
      expiresAt: now + DAY,
      revalidate: null,
    })
  }

  return { facts, seen: next }
}

/**
 * Scan every enabled source. Network failures are per-source and never throw:
 * Hacker News being down must not cost the T3 Code release.
 */
export async function scanFeeds({
  sources = DEFAULT_SOURCES,
  state = {},
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  log = () => {},
  // When a bundled source's notification is due. A function of the source rather
  // than a value, because resolving "the next morning or evening slot" needs a
  // timezone and a settings read — neither of which belongs in a pure collector.
  deliverAt = () => now,
} = {}) {
  const facts = []
  const nextState = { ...state }

  for (const source of sources) {
    if (source.enabled === false) continue
    try {
      const payload = await readSource(source, fetchImpl)
      const result = factsFor(source, payload, state[source.id] || {}, { now, deliverAt: deliverAt(source) })
      nextState[source.id] = { ...result.seen, lastOk: now }
      facts.push(...result.facts)
    } catch (e) {
      log(`feed ${source.id} failed: ${e.message || e}`)
      nextState[source.id] = { ...(state[source.id] || {}), lastError: String(e.message || e), lastErrorAt: now }
    }
  }

  return { facts, state: nextState }
}
