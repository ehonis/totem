// notify/timex-collabs.mjs — daily Timex collaboration watch.
//
// Timex drops collabs across press, retailers, and blogs; there is no single
// official "collabs" RSS. Google News queries plus a Timex-site search are
// enough to catch "Timex x …" and "… collab" headlines without an API key.
//
// Behaviour (by design):
//   * Runs once a day via the timex-collab-watch job.
//   * Pushes only when a headline is NEW (watermark per item id).
//   * Silent days when nothing new — no "all clear" spam.
//   * Every Sunday, after the daily pass, one weekly rollup of checks + finds.

import { googleNewsUrl, parseFeed, stripOutletSuffix } from './feed.mjs'

const DAY = 86_400_000

/** Headline must mention Timex and read like a collab, not every new dial color. */
const COLLAB_HINT =
  /\b(collab(?:oration)?s?|partnership|teams?\s+up|team-up|team\s+up)\b/i
const CROSS_BRAND = /\btimex\s*[x×]\s*|\s*[x×]\s*timex\b/i

const QUERIES = [
  'Timex collab OR Timex collaboration OR "Timex x"',
  'when:14d site:timex.com collab OR collaboration OR " x Timex" OR "Timex x"',
]

const timeout = (ms) => AbortSignal.timeout(ms)

async function getText(url, fetchImpl, ms = 12_000) {
  const r = await fetchImpl(url, {
    signal: timeout(ms),
    headers: {
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
      'user-agent': 'totem-bridge/1.0',
    },
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.text()
}

/** Pull a partner name from common headline shapes when we can. */
export function partnerFromTitle(title) {
  const t = stripOutletSuffix(String(title || ''))
  let m = t.match(/^(.+?)\s+[x×]\s+Timex\b/i)
  if (m) return m[1].replace(/\s+['']s\s*$/i, '').trim()
  m = t.match(/\bTimex\s+[x×]\s+(.+?)(?:\s+[-–—:]|$)/i)
  if (m) return m[1].trim()
  m = t.match(/\bTimex(?:'s)?\s+(?:Latest\s+)?(.+?)\s+Collab/i)
  if (m) return m[1].trim()
  return null
}

export function isTimexCollabHeadline(title) {
  const t = stripOutletSuffix(String(title || ''))
  if (!/\btimex\b/i.test(t)) return false
  if (COLLAB_HINT.test(t) || CROSS_BRAND.test(t)) return true
  // Retail product pages: "Brand x Timex … Gift Set"
  if (/\bx\s+timex\b/i.test(t) && /\b(gift\s+set|collection|heritage|limited)\b/i.test(t)) return true
  return false
}

function formatWhen(at) {
  if (!at || !Number.isFinite(at)) return 'date unknown'
  return new Date(at).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** ISO week id for weekly summary dedupe (YYYY-Www). */
export function isoWeekId(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms))
  const y = Number(parts.find((p) => p.type === 'year').value)
  const m = Number(parts.find((p) => p.type === 'month').value)
  const d = Number(parts.find((p) => p.type === 'day').value)
  const utc = Date.UTC(y, m - 1, d)
  const dayNum = new Date(utc).getUTCDay() || 7
  const thursday = utc + (4 - dayNum) * DAY
  const weekYear = new Date(thursday).getUTCFullYear()
  const yearStart = Date.UTC(weekYear, 0, 1)
  const week = Math.ceil(((thursday - yearStart) / DAY + 1) / 7)
  return `${weekYear}-W${String(week).padStart(2, '0')}`
}

function localWeekday(ms, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(ms))
}

function localDateKey(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms))
  const y = parts.find((p) => p.type === 'year').value
  const mo = parts.find((p) => p.type === 'month').value
  const d = parts.find((p) => p.type === 'day').value
  return `${y}-${mo}-${d}`
}

export function emptyState() {
  return { seen: {}, checks: [], lastWeeklySummaryWeek: null }
}

/**
 * Fetch and diff collab headlines. Returns notification payloads + next state.
 * Does not touch the queue — bridge enqueues after this returns.
 */
export async function scanTimexCollabs({
  state = emptyState(),
  now = Date.now(),
  tz = 'America/New_York',
  fetchImpl = globalThis.fetch,
  log = () => {},
} = {}) {
  const seen = { ...(state.seen || {}) }
  const items = []
  const queryErrors = []

  for (const query of QUERIES) {
    const url = googleNewsUrl(query)
    try {
      const xml = await getText(url, fetchImpl)
      for (const row of parseFeed(xml, 25)) {
        if (!isTimexCollabHeadline(row.title)) continue
        const id = row.id || row.url || row.title
        items.push({
          id,
          title: stripOutletSuffix(row.title),
          url: row.url,
          at: row.at,
          partner: partnerFromTitle(row.title),
        })
      }
    } catch (e) {
      queryErrors.push(`${query.slice(0, 40)}…: ${e.message || e}`)
      log(`timex collab query failed: ${e.message || e}`)
    }
  }

  // Same story from two queries → one notification.
  const byId = new Map()
  for (const item of items) {
    if (!byId.has(item.id)) byId.set(item.id, item)
  }
  const unique = [...byId.values()].sort((a, b) => (b.at || 0) - (a.at || 0))

  const notifications = []
  let newCount = 0
  const bootstrapping = !Object.keys(seen).length && unique.length > 0
  for (const item of unique) {
    if (seen[item.id]) continue
    seen[item.id] = now
    if (bootstrapping) continue
    newCount += 1
    const partner = item.partner
    const withWho = partner ? ` with ${partner}` : ''
    notifications.push({
      category: 'news.timex',
      factKind: 'timex.collab',
      title: 'Timex collab',
      body: `${item.title}${withWho}. Reported ${formatWhen(item.at)}.`,
      url: item.url,
      deliverAt: now,
      subject: item.id,
      dedupeKey: `timex-collab:${item.id}`,
    })
  }

  const dateKey = localDateKey(now, tz)
  const checks = Array.isArray(state.checks) ? [...state.checks] : []
  checks.push({
    date: dateKey,
    at: now,
    newCount,
    candidates: unique.length,
    errors: queryErrors.length ? queryErrors : undefined,
  })
  // Keep ~60 days of check log for debugging; weekly summary only needs 7.
  while (checks.length > 60) checks.shift()

  const next = { seen, checks, lastWeeklySummaryWeek: state.lastWeeklySummaryWeek || null }

  let weekly = null
  if (localWeekday(now, tz) === 'Sun') {
    const weekId = isoWeekId(now, tz)
    if (next.lastWeeklySummaryWeek !== weekId) {
      const weekChecks = checks.filter((c) => {
        const t = Date.parse(`${c.date}T12:00:00`)
        return Number.isFinite(t) && now - t < 8 * DAY
      })
      const totalNew = weekChecks.reduce((n, c) => n + (c.newCount || 0), 0)
      const errorDays = weekChecks.filter((c) => c.errors?.length).length
      const names = unique
        .filter((i) => i.at && i.at > now - 8 * DAY)
        .slice(0, 5)
        .map((i) => i.partner || i.title.split(/[-–—:]/)[0].trim())
      let body = `Timex collab watch: ${weekChecks.length} check(s) this week`
      body += totalNew ? `, ${totalNew} new headline(s)` : ', nothing new'
      if (names.length) body += `. Recent: ${names.join('; ')}`
      if (errorDays) body += `. ${errorDays} day(s) had fetch errors`
      weekly = {
        category: 'news.timex',
        factKind: 'timex.collab.weekly',
        title: 'Timex collab week',
        body,
        url: 'https://timex.com',
        deliverAt: now,
        subject: weekId,
        dedupeKey: `timex-collab-weekly:${weekId}`,
      }
      next.lastWeeklySummaryWeek = weekId
    }
  }

  return {
    notifications,
    weekly,
    next,
    newCount,
    candidateCount: unique.length,
    queryErrors,
    bootstrapped: bootstrapping ? unique.length : 0,
  }
}
