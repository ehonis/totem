// notify/dedupe.mjs — the gate every notification passes on its way out.
//
// Two ways a phone hears the same thing twice, and one check for each:
//
//   * THE SAME KEY. A notification that names what it is about ("Cursor's
//     included usage is spent, this billing window") has a dedupe key, and a key
//     that already went out inside its window does not go out again. The log of
//     what was sent is a file, so a restart does not forget it: the queue used to
//     be the only memory, it only collapsed *pending* entries, and a delivered one
//     blocked nothing.
//   * THE SAME STORY. Two feeds that report one model launch have two ids, two
//     links and two headlines. Before a story goes out it is compared with every
//     story sent in the last two days. A match is folded into the earlier
//     notification, which counts it, rather than sent.
//
// Matching is deliberately strict, for the reason notify/feed.mjs gives about
// bundles: a false "same story" deletes real news without a trace. So a shared
// model name is never enough on its own: "OpenAI releases GPT-6.1" and "OpenAI
// delays GPT-6.1" name the same model and are two stories. See `storyScore`. A
// pair that is close but not close enough is *sent*, unless the owner has switched
// on the model check, which only ever sees those borderline pairs and fails open.
//
// What goes out is RESERVED when it is admitted and COMMITTED once the notifier
// knows it reached the bell or a phone. A push that reached nothing is released,
// so its retry, or tomorrow's plan, is not mistaken for a repeat of it; a
// reservation a crash left unconfirmed lapses after five minutes.
//
// Pinned categories (categories.mjs) never pass through either check: an approval
// code or a reminder he set is never "a repeat".
//
// Two lists are exposed for other code to extend rather than edit this file:
// `addHold(fn)` lets something keep a queued notification waiting (away days),
// and every suppression is logged here, readable from Settings → Notifications.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { categoryDef, isPinned, CATEGORIES } from './categories.mjs'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const MAX_SUPPRESSED = 500
const MAX_SENT = 2000
const KEEP_SUPPRESSED_MS = 30 * 24 * HOUR
// Long enough for a delivery to every device to finish, short enough that a
// crash between admitting and confirming does not hold a key for days.
const RESERVE_MS = 5 * MINUTE
// A model check answers once per pair; the answer is kept this long.
const VERDICT_MS = 6 * HOUR
// At most this many model checks waiting at once. Past it, a borderline pair is
// sent rather than queued behind the others.
const MAX_CHECKS = 2

export const DEDUPE_DEFAULTS = {
  enabled: true,
  // How long a named notification ("this window is spent", "this HN story") stays
  // said, when it does not carry a window of its own. A week, because the same
  // Hacker News item crossing a second source's points floor took two days.
  keyWindowHours: 168,
  // How far back a new story is compared with what was sent.
  storyWindowHours: 48,
  // Where stories come from, most urgent first. A story sent in one of these
  // stands in for the same story later in the same category or one further down,
  // never one further up. Releases are not here: "0.1.5 is out" and "0.1.4 is
  // out" share a link and most of their words and are two different facts.
  storyCategories: ['news.model', 'news.big', 'news.creator', 'news.timex'],
  // At or above this a pair is one story. Below `borderlineScore` it is two.
  // Between the two it is two as well, unless the model check says otherwise.
  sameStoryScore: 0.6,
  borderlineScore: 0.4,
  // However the names line up, a match also needs this share of the shorter
  // headline's other words in the longer one.
  minWordOverlap: 0.3,
  modelCheck: false,
}

export function normalizeDedupeSettings(raw = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const num = (v, lo, hi, d) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Math.min(Math.max(Number(v), lo), hi) : d)
  const same = num(r.sameStoryScore, 0.3, 1, DEDUPE_DEFAULTS.sameStoryScore)
  return {
    enabled: r.enabled === undefined ? DEDUPE_DEFAULTS.enabled : Boolean(r.enabled),
    keyWindowHours: num(r.keyWindowHours, 1, 24 * 60, DEDUPE_DEFAULTS.keyWindowHours),
    storyWindowHours: num(r.storyWindowHours, 0, 24 * 14, DEDUPE_DEFAULTS.storyWindowHours),
    storyCategories: Array.isArray(r.storyCategories)
      ? r.storyCategories.filter((c) => typeof c === 'string').slice(0, 50)
      : [...DEDUPE_DEFAULTS.storyCategories],
    sameStoryScore: same,
    // Never above the match line, or "borderline" would include certain matches.
    borderlineScore: Math.min(num(r.borderlineScore, 0.1, 1, DEDUPE_DEFAULTS.borderlineScore), same),
    minWordOverlap: num(r.minWordOverlap, 0, 1, DEDUPE_DEFAULTS.minWordOverlap),
    modelCheck: r.modelCheck === undefined ? DEDUPE_DEFAULTS.modelCheck : Boolean(r.modelCheck),
  }
}

/* ---------------------------------------------------------------- stories */

// Query parameters that say who shared a link, never what it links to.
const TRACKING = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|si|s|ref|ref_src|ref_url|source|src|cmpid|smid|ocid|oc|_hsenc|_hsmi|mkt_tok|spm|share|at_medium|at_campaign|campaign|feature)$/i

/**
 * One spelling of a link. Null for a link that is a whole site (a front page, a
 * releases page) rather than one story on it, because every item from that
 * source shares it.
 */
export function canonicalUrl(raw) {
  if (!raw || typeof raw !== 'string') return null
  let u
  try { u = new URL(raw) } catch { return null }
  if (!/^https?:$/.test(u.protocol)) return null
  const host = u.hostname.toLowerCase().replace(/^(www|m|amp|mobile)\./, '')
  let path = u.pathname.replace(/\/amp\/?$/, '').replace(/\/+$/, '')
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING.test(k))
    .sort(([a], [b]) => a.localeCompare(b))
  if (!path && !params.length) return null
  if (/\/releases$/.test(path) && !params.length) return null
  path = path || '/'
  const query = params.length ? `?${new URLSearchParams(params)}` : ''
  return `https://${host}${path}${query}`
}

/** The story a notification tells, if its producer said so. Nothing is guessed. */
export function storyOf(input) {
  const story = input?.story
  if (!story?.title || typeof story.title !== 'string') return null
  return { title: story.title.slice(0, 300), url: typeof story.url === 'string' ? story.url : null }
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'with', 'from', 'after', 'over', 'into', 'onto',
  'that', 'this', 'its', 'it', 'his', 'her', 'their', 'our', 'your', 'says', 'say',
  'said', 'new', 'now', 'are', 'is', 'was', 'were', 'be', 'been', 'has', 'have', 'had',
  'will', 'amid', 'but', 'not', 'how', 'why', 'who', 'what', 'when', 'of', 'in', 'on',
  'at', 'to', 'by', 'as', 'up', 'about', 'just', 'can', 'all', 'more', 'than',
  'we', 'you', 'they', 'us', 'i', 'my', 'via', 'vs',
  // Words that say where a story ran, not what it is.
  'show', 'ask', 'hn', 'points', 'point', 'reported', 'report', 'reports',
])

// What happened, in a few kinds. Two headlines naming different kinds of event
// are two stories, whatever else they share: a launch and the outage that
// follows it, a release and the flaw found in it.
const EVENTS = [
  ['launch', /^(launch\w*|releas\w*|introduc\w*|announc\w*|unveil\w*|debut\w*|ship|ships|shipp\w*|availab\w*|arriv\w*|here|out|rollout)$/],
  ['outage', /^(outage\w*|down|downtime|incident\w*|degrad\w*|offline|crash\w*|broken)$/],
  ['delay', /^(delay\w*|postpon\w*)$/],
  ['withdrawn', /^(recall\w*|pull|pulls|pulled|pulling|withdr\w*|suspend\w*|halt\w*|discontinu\w*|ban|bans|banned|banning|shut|shuts|shutdown|deprecat\w*|retir\w*|kill\w*)$/],
  ['security', /^(flaw\w*|vulnerab\w*|secur\w*|exploit\w*|breach\w*|leak\w*|hack\w*|backdoor\w*|cve|malware|trojan\w*|attack\w*|compromis\w*|jailbr\w*)$/],
  ['legal', /^(sue|sues|sued|suing|lawsuit\w*|court\w*|fine|fines|fined|antitrust|probe\w*|investigat\w*|settle\w*)$/],
]
const eventOf = (word) => EVENTS.find(([, re]) => re.test(word))?.[0] || null

// Light stemming: enough that "releases", "released" and "releasing" meet, not a
// linguistics project.
export function stem(word) {
  if (word.length <= 4 || /\d/.test(word)) return word
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  for (const suffix of ['ing', 'ed', 'es', 's', 'ly']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) return word.slice(0, -suffix.length)
  }
  return word
}

// What a feed appends that is not the story: "— 435 points.", " - AP News",
// "(Reuters)".
export function storyText(text) {
  return String(text || '')
    .replace(/\s+[—–-]\s+\d[\d,]*\s+points?\.?\s*$/i, '')
    .replace(/\s+-\s+[^-]{2,30}$/, '')
    .replace(/\s*\([^)]{2,30}\)\s*$/, '')
    .trim()
}

const words = (text) => String(text || '')
  .toLowerCase()
  .replace(/[’']/g, '')
  // Keep a dot inside a version number ("6.1"); everything else splits.
  .replace(/(\d)\.(?=\d)/g, '$1§')
  .replace(/[^a-z0-9§\s-]/g, ' ')
  .replace(/§/g, '.')
  .split(/[\s]+/)
  .flatMap((w) => (/[a-z]-\d|\d-[a-z]/.test(w) ? [w] : w.split('-')))
  .filter(Boolean)

// Model names, listed rather than guessed from capitals: headlines are title
// case, and "Top 10" is not a product. A family name followed by a number is a
// model ("Gemini 4"); any word followed by a dotted number is a version
// ("Python 3.14").
const FAMILIES = new Set([
  'gpt', 'o', 'chatgpt', 'claude', 'opus', 'sonnet', 'haiku', 'fable', 'gemini', 'gemma',
  'llama', 'mistral', 'mixtral', 'codestral', 'devstral', 'magistral', 'qwen', 'qwq',
  'deepseek', 'grok', 'kimi', 'glm', 'phi', 'sora', 'veo', 'imagen', 'nova', 'olmo',
  'codex', 'dalle', 'midjourney', 'flux', 'whisper', 'minimax', 'ernie', 'yi',
])

// Who made it. Not part of what a story is about: "OpenAI releases GPT-6.1 to
// Plus users" and "… to Enterprise customers" share OpenAI and are two stories.
const MAKERS = new Set([
  'openai', 'anthropic', 'google', 'deepmind', 'meta', 'microsoft', 'apple', 'nvidia',
  'mistral', 'xai', 'alibaba', 'deepseek', 'moonshot', 'amazon', 'aws', 'cohere', 'perplexity',
  'huggingface', 'ibm', 'intel', 'amd', 'github',
])

const isVersion = (w) => /^v?\d+(\.\d+)*$/.test(w)
const isSize = (w) => /^\d+(\.\d+)?[a-z]+$/.test(w) // 27b, 5x, 10k: a size, not a name

/**
 * A headline taken apart:
 *   names  — every name-and-version in it ("gpt6.1", "claudeopus5.5", "opus5.5")
 *   lead   — the first of them, which is what the headline is about. "Qwen3.8
 *            matches Fable 5" mentions Fable 5; it is not the Fable 5 launch.
 *   events — the kinds of thing that happened (launch, outage, withdrawn, …)
 *   words  — everything else, stemmed, with each event word standing for its kind
 */
export function readHeadline(text) {
  const tokens = words(storyText(text))
  const found = []
  const used = new Set()
  const add = (name, version, from, to) => {
    found.push({ key: `${name}${version.replace(/^v/, '')}`, version, at: from })
    for (let k = from; k <= to; k += 1) used.add(k)
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const w = tokens[i]
    // One token with the name and the number in it: "gpt-6.1", "qwen3.8-27b", "k3.1".
    const glued = w.match(/^([a-z]{1,12})-?(\d+(?:\.\d+)*)(?:-[a-z0-9]+)*$/)
    if (glued && !isSize(w) && (FAMILIES.has(glued[1]) || glued[2].includes('.'))) {
      add(glued[1], glued[2], i, i)
      continue
    }
    if (STOPWORDS.has(w) || isVersion(w)) continue
    // A family name, maybe a tier, then the number: "gemini 4", "mistral large 4",
    // "claude opus 5.5". Any word then a dotted number: "python 3.14".
    const next = tokens[i + 1]
    const after = tokens[i + 2]
    if (next && isVersion(next) && (FAMILIES.has(w) || next.includes('.'))) {
      add(w, next, i, i + 1)
    } else if (FAMILIES.has(w) && next && !STOPWORDS.has(next) && after && isVersion(after)) {
      add(`${w}${next}`, after, i, i + 2)
    }
  }
  const first = found[0]
  const lead = new Set(found.filter((f) => first && f.version === first.version && f.at - first.at <= 2).map((f) => f.key))

  const events = new Set()
  const rest = new Set()
  tokens.forEach((raw, i) => {
    if (used.has(i)) return
    const w = raw.replace(/-/g, '')
    const kind = eventOf(w) || eventOf(stem(w))
    if (kind) { events.add(kind); rest.add(`@${kind}`); return }
    if (w.length > 1 && !STOPWORDS.has(w)) rest.add(stem(w))
  })
  return { names: new Set(found.map((f) => f.key)), lead, events, words: rest }
}

/**
 * Is `later` a repeat of `earlier`? `{ title, url }` each. Returns
 * `{ score, words, why }`, and `different: true` when something rules a match out.
 * One-sided on purpose: only the later story is ever held back, and a follow-up
 * usually names the event it follows ("GPT-6.1 release delayed").
 *
 * The same canonical link is the same story, whatever the headlines say.
 * Otherwise, in order:
 *
 *   1. Both name a model and the leads differ (GPT-6.1 and GPT-6.2, Claude
 *      Sonnet 5 and Claude Haiku 5): two stories.
 *   2. The later headline says something happened that the earlier one does not
 *      (delayed, sued, pulled, an outage, a flaw, a jailbreak), or the two name
 *      different kinds of event outright: two stories. A launch is the one kind
 *      that is not news about news: "Gemini 4 Carbon" then "Google launches
 *      Gemini 4 Carbon" is one story.
 *   3. The headlines are one sentence with a detail swapped (in Europe, in
 *      Japan), or they share nothing but the name, the maker and the event
 *      while each adds details of its own (to Plus users, to Enterprise
 *      customers): two stories.
 *   4. Same lead name: 0.4, plus 0.6 × the share of the shorter headline's other
 *      words found in the longer. A shared name alone reaches the borderline band
 *      and no further: "Show HN: my GPT-6 wrapper" is not the GPT-6 launch.
 *   5. No shared name: the Jaccard overlap of the two headlines' words.
 *
 * `words` is the word overlap on its own; a match needs it to be at least
 * `minWordOverlap` as well as the score to reach `sameStoryScore`.
 */
export function storyScore(later, earlier) {
  const a = later
  const b = earlier
  const ua = canonicalUrl(a?.url)
  if (ua && ua === canonicalUrl(b?.url)) return { score: 1, words: 1, why: 'same link', link: true }
  const x = readHeadline(a?.title)
  const y = readHeadline(b?.title)
  const differ = (why) => ({ score: 0, words: 0, why, different: true })
  const list = (s) => [...s].join(', ')

  if (x.lead.size && y.lead.size && ![...x.lead].some((n) => y.lead.has(n))) {
    return differ(`different model or version (${list(x.lead)} / ${list(y.lead)})`)
  }
  const followUp = [...x.events].filter((e) => e !== 'launch' && !y.events.has(e))
  if (followUp.length) return differ(`new event (${followUp.join(', ')})`)
  if (x.events.size && y.events.size && ![...x.events].some((e) => y.events.has(e))) {
    return differ(`different event (${list(x.events)} / ${list(y.events)})`)
  }
  let shared = 0
  for (const w of x.words) if (y.words.has(w)) shared += 1
  const onlyX = x.words.size - shared
  const onlyY = y.words.size - shared
  if (shared >= 1 && onlyX >= 1 && onlyX <= 2 && onlyY >= 1 && onlyY <= 2) {
    return differ(`one detail differs (${list([...x.words].filter((w) => !y.words.has(w)))} / ${list([...y.words].filter((w) => !x.words.has(w)))})`)
  }
  const substance = (w) => !w.startsWith('@') && !MAKERS.has(w)
  const ownX = [...x.words].filter((w) => substance(w) && !y.words.has(w))
  const ownY = [...y.words].filter((w) => substance(w) && !x.words.has(w))
  const common = [...x.words].filter((w) => substance(w) && y.words.has(w))
  if (ownX.length && ownY.length && !common.length) {
    return differ(`different details (${ownX.join(', ')} / ${ownY.join(', ')})`)
  }

  const leads = [...x.lead].filter((n) => y.lead.has(n))
  const smaller = Math.min(x.words.size, y.words.size)
  const contained = smaller ? shared / smaller : 0
  const jaccard = x.words.size + y.words.size - shared ? shared / (x.words.size + y.words.size - shared) : 0
  const overlap = leads.length ? contained : jaccard
  const score = leads.length ? 0.4 + 0.6 * contained : jaccard
  const why = [leads.length ? `same name ${leads.join(', ')}` : '', `words ${overlap.toFixed(2)}`].filter(Boolean).join('; ')
  return { score: Math.round(score * 100) / 100, words: Math.round(overlap * 100) / 100, why }
}

/* ------------------------------------------------------------------- gate */

// A notification without a key of its own is identified by what it says. Only in
// a category that opts in (`textDedupe`, categories.mjs): a job failing twice in
// the hour with the same message. Never by default, because "stopped reporting",
// "back", "stopped reporting" is three different things with two texts.
export function contentKey({ category, title = '', body = '' }) {
  const hash = createHash('sha256').update(`${title}\n${body}`).digest('hex').slice(0, 16)
  return `${category}:text:${hash}`
}

export function createDedupeGate({
  // Null keeps the log in memory: tests, and a notifier built without a gate.
  file = null,
  settingsFile = null,
  categories = CATEGORIES,
  now = () => Date.now(),
  log = () => {},
  // async ({ candidate, earlier }) → true (same) | false (different) | null.
  // Only asked about borderline pairs, only with `modelCheck` on, and never
  // awaited by a delivery: see `admit`.
  tiebreak = null,
  tiebreakMs = 120_000,
} = {}) {
  let memory = { sent: [], suppressed: [] }
  let memorySettings = {}
  const holds = []
  // Model checks by pair: { state: 'pending' | 'done', verdict, at }.
  const checks = new Map()
  let chain = Promise.resolve()

  function withLock(fn) {
    const run = chain.then(() => fn())
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  async function readJson(path, fallback) {
    if (!path) return fallback
    try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
  }

  async function writeJson(path, value) {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(value, null, 2))
    await rename(tmp, path)
  }

  const isRow = (r) => r && typeof r === 'object' && !Array.isArray(r)

  async function load() {
    if (!file) return memory
    const parsed = await readJson(file, null)
    return {
      sent: Array.isArray(parsed?.sent) ? parsed.sent.filter(isRow) : [],
      suppressed: Array.isArray(parsed?.suppressed) ? parsed.suppressed.filter(isRow) : [],
    }
  }

  async function save(state) {
    if (!file) { memory = state; return }
    await writeJson(file, { ...state, updatedAt: new Date(now()).toISOString() })
  }

  async function settings() {
    if (!settingsFile) return normalizeDedupeSettings(memorySettings)
    return normalizeDedupeSettings(await readJson(settingsFile, {}))
  }

  async function saveSettings(patch = {}) {
    return withLock(async () => {
      const next = normalizeDedupeSettings({ ...(await settings()), ...(isRow(patch) ? patch : {}) })
      if (settingsFile) await writeJson(settingsFile, next)
      else memorySettings = next
      return next
    })
  }

  // The key an item is remembered by, and until when.
  function identity(item, cfg, at) {
    const def = categoryDef(item.category, categories)
    const windowMs = (def.dedupeWindowMinutes || 0) * MINUTE
    if (item.dedupeKey) {
      const until = Number.isFinite(item.dedupeUntil) && item.dedupeUntil > at
        ? item.dedupeUntil
        : at + Math.max(cfg.keyWindowHours * HOUR, windowMs)
      return { key: String(item.dedupeKey), until }
    }
    if (!def.textDedupe || !windowMs) return { key: null, until: at }
    return { key: contentKey(item), until: at + windowMs }
  }

  // A reservation nobody confirmed (a crash mid-delivery) is not a sent item.
  const live = (r, at) => r.state !== 'reserved' || at - (Number(r.at) || 0) < RESERVE_MS
  const rank = (cfg, category) => {
    const i = cfg.storyCategories.indexOf(category)
    return i < 0 ? Number.POSITIVE_INFINITY : i
  }

  // The closest earlier story this one could be a repeat of: same link, or a
  // headline match from the same category or a more urgent one.
  function closestStory(sent, story, item, cfg, at) {
    const since = at - cfg.storyWindowHours * HOUR
    let best = null
    for (const record of sent) {
      if (!record.story || (Number(record.at) || 0) < since || !live(record, at)) continue
      if (item.entryId && record.entryId === item.entryId) continue
      const s = storyScore(story, record.story)
      if (s.different) continue
      if (!s.link && rank(cfg, record.category) > rank(cfg, item.category)) continue
      if (!best || s.score > best.score) best = { record, ...s }
    }
    if (!best) return null
    const same = best.score >= cfg.sameStoryScore && best.words >= cfg.minWordOverlap
    const borderline = !same && best.score >= cfg.borderlineScore
    return { ...best, same, borderline }
  }

  const pairOf = (story, earlier) => `${earlier.title}\u0000${story.title}`

  // Start a model check in the background. Nothing waits on it: the queued entry
  // that raised it is held and asks again on a later drain.
  function startCheck(pair, candidate, earlier) {
    if ([...checks.values()].filter((c) => c.state === 'pending').length >= MAX_CHECKS) return false
    checks.set(pair, { state: 'pending', at: now() })
    let timer
    Promise.race([
      Promise.resolve().then(() => tiebreak({ candidate, earlier })),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), tiebreakMs) }),
    ])
      .then((verdict) => (verdict === true || verdict === false ? verdict : null))
      .catch((e) => { log('dedupe model check failed, sending', e?.message || e); return null })
      .then((verdict) => {
        clearTimeout(timer)
        checks.set(pair, { state: 'done', verdict, at: now() })
      })
    return true
  }

  /**
   * Decide whether an item goes out. Returns one of:
   *
   *   { action: 'send', ticket }      — reserved; `confirm(ticket, { ok })` commits
   *                                     or releases it once the notifier knows.
   *   { action: 'suppress', reason, match }
   *   { action: 'defer', until }      — a queued item waiting on a model check.
   *
   * Two deliveries racing each other cannot both pass: the check and the
   * reservation are one step under the lock.
   */
  async function admit(item) {
    const cfg = await settings()
    const at = now()
    if (!cfg.enabled || isPinned(item.category, categories)) return { action: 'send', ticket: null }
    const { key, until } = identity(item, cfg, at)
    const story = cfg.storyCategories.includes(item.category) ? storyOf(item) : null
    if (!key && !story) return { action: 'send', ticket: null }

    return withLock(async () => {
      const state = await load()
      prune(state, cfg, at)
      const mine = (r) => item.entryId && r.entryId === item.entryId

      let match = null
      if (key) {
        const hit = state.sent.find((r) => r.key === key && r.until > at && !mine(r))
        if (hit) match = { record: hit, reason: 'same-key', score: 1, why: `already sent ${key}` }
      }
      if (!match && story) {
        const best = closestStory(state.sent, story, item, cfg, at)
        if (best?.same) match = { ...best, reason: 'same-story' }
        else if (best?.borderline && cfg.modelCheck && tiebreak) {
          const pair = pairOf(story, best.record.story)
          const check = checks.get(pair)
          if (check?.state === 'done' && check.verdict === true) {
            match = { ...best, reason: 'same-story', why: `${best.why}; model check said same` }
          } else if (!check && item.entryId && startCheck(pair, story, best.record.story)) {
            return { action: 'defer', until: at + MINUTE }
          } else if (check?.state === 'pending' && item.entryId) {
            return { action: 'defer', until: at + MINUTE }
          }
          // Done and not "same", too many checks waiting, or nothing to hold (a
          // direct push): the heuristic stands, and it said send.
        }
      }

      if (match) {
        match.record.similar = (match.record.similar || 0) + 1
        const row = {
          id: `s_${randomUUID().slice(0, 8)}`,
          at,
          category: item.category,
          title: String(item.title || '').slice(0, 160),
          body: String(item.body || '').slice(0, 300),
          url: item.url || null,
          key,
          reason: match.reason,
          score: match.score,
          why: match.why,
          duplicateOf: match.record.id,
          duplicateTitle: match.record.story?.title || match.record.title,
          // Null while the first is still going out; confirm() fills it in and
          // hands the row back to be counted on the bell's copy.
          ledgerId: match.record.ledgerId || null,
          entryId: item.entryId || null,
        }
        state.suppressed.unshift(row)
        state.suppressed = state.suppressed.slice(0, MAX_SUPPRESSED)
        await save(state)
        log(`notification suppressed (${match.reason}): ${row.title} — ${match.why}`)
        return { action: 'suppress', reason: match.reason, match: row }
      }

      const record = {
        id: `k_${randomUUID().slice(0, 8)}`,
        state: 'reserved',
        at,
        key,
        until,
        category: item.category,
        title: String(item.title || '').slice(0, 160),
        story,
        entryId: item.entryId || null,
        ledgerId: null,
        similar: 0,
      }
      // A retry replaces its own earlier record rather than adding a second.
      state.sent = state.sent.filter((r) => !mine(r))
      state.sent.push(record)
      state.sent = state.sent.slice(-MAX_SENT)
      await save(state)
      return { action: 'send', ticket: record.id }
    })
  }

  /**
   * The other half of `admit`. `ok` is whether the notification reached the bell
   * or a phone: false releases the reservation, so the next attempt is not a
   * repeat of one that never arrived. Returns the repeats suppressed while it was
   * in flight, now carrying `ledgerId`, for the notifier to count on the bell.
   */
  async function confirm(ticket, { ok = true, ledgerId = null } = {}) {
    if (!ticket) return { similar: [] }
    return withLock(async () => {
      const state = await load()
      const record = state.sent.find((r) => r.id === ticket)
      if (!record) return { similar: [] }
      if (!ok) {
        state.sent = state.sent.filter((r) => r !== record)
        await save(state)
        return { similar: [] }
      }
      record.state = 'sent'
      record.ledgerId = ledgerId
      const similar = state.suppressed.filter((r) => r.duplicateOf === record.id && !r.ledgerId)
      for (const r of similar) r.ledgerId = ledgerId
      await save(state)
      return { similar: ledgerId ? similar : [] }
    })
  }

  /**
   * Every key said and still inside its window: one read, for a planner to skip
   * them up front. Empty when the gate is off, because then nothing is held back.
   */
  async function sentKeys(at = now()) {
    const cfg = await settings()
    if (!cfg.enabled) return new Set()
    const state = await load()
    return new Set(state.sent.filter((r) => r.key && r.until > at && live(r, at)).map((r) => r.key))
  }

  /**
   * Hold a queued notification back for now. Each hold is `(entry) => falsy |
   * true | { until }`; the first to answer wins. `true` waits fifteen minutes.
   * The queue's catch-up window still applies: a hold longer than it should move
   * `until` past the time it was due, which is what `{ until }` does.
   */
  function addHold(fn) {
    if (typeof fn === 'function') holds.push(fn)
    return () => { const i = holds.indexOf(fn); if (i >= 0) holds.splice(i, 1) }
  }

  function shouldHold(entry, at = now()) {
    if (isPinned(entry.category, categories)) return null
    for (const fn of holds) {
      let verdict
      try { verdict = fn(entry) } catch (e) { log('notification hold threw, sending', e?.message || e); continue }
      if (!verdict) continue
      const until = Number.isFinite(verdict?.until) ? verdict.until : at + 15 * MINUTE
      return { until }
    }
    return null
  }

  async function suppressed({ since = 0, limit = 50 } = {}) {
    const state = await load()
    const rows = state.suppressed.filter((r) => (Number(r.at) || 0) >= since)
    return { count: rows.length, items: rows.slice(0, limit) }
  }

  function prune(state, cfg, at) {
    const storySince = at - cfg.storyWindowHours * HOUR
    state.sent = state.sent
      .filter((r) => live(r, at) && ((Number(r.until) || 0) > at || (r.story && (Number(r.at) || 0) >= storySince)))
      .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
      .slice(-MAX_SENT)
    state.suppressed = state.suppressed.filter((r) => at - (Number(r.at) || 0) < KEEP_SUPPRESSED_MS)
    for (const [pair, check] of checks) if (check.state === 'done' && at - check.at > VERDICT_MS) checks.delete(pair)
  }

  return {
    admit, confirm, sentKeys, addHold, shouldHold, suppressed, settings, saveSettings, now, file, settingsFile,
    isPinned: (category) => isPinned(category, categories),
  }
}
