// sources/http.mjs — the `/api/sources` adapter.
//
// Behind the /api/* auth gate:
//   GET /api/sources                       every source's health, grouped under the goals it feeds
//   GET /api/sources/runs?source=<id>      one source's newest runs (ids hold ':', so a query param)
import { describeSourceId, emptyHealth } from './health.mjs'

const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' }
const send = (res, status, body) => { res.writeHead(status, JSON_TYPE); res.end(JSON.stringify(body)) }

/**
 * The health payload, shared by the route and anything else that wants it.
 *
 * `goals()` returns `[{ id, title, periodType, periodStart, periodEnd, sources: [id] }]`
 * (the goal service's `sourcedGoals`); `metricSources` maps a metric's source kind
 * to the source id it reads, so a client can mark a metric without restating it.
 * A source a goal names that has never run is listed as `unknown` rather than left
 * out: "Strava has never been read" is the answer for a goal that shows no number.
 * A goal list that cannot be read leaves the sources ungrouped rather than failing.
 */
export function sourceHealthPayload({ runs, goals = () => [], metricSources = {}, now = () => Date.now() }) {
  let sourcedGoals = []
  try { sourcedGoals = goals() || [] } catch {}
  const byId = new Map(runs.health().map((h) => [h.source, h]))
  for (const goal of sourcedGoals) {
    for (const source of goal.sources) {
      if (!byId.has(source)) byId.set(source, emptyHealth(source))
    }
  }
  const sources = [...byId.values()].map((h) => {
    const { notifiedAt, ...shown } = h
    return {
      ...shown,
      ...describeSourceId(h.source),
      goals: sourcedGoals.filter((g) => g.sources.includes(h.source)).map((g) => ({ id: g.id, title: g.title })),
    }
  })
  const state = (id) => byId.get(id)?.state ?? 'unknown'
  return {
    generatedAt: new Date(now()).toISOString(),
    // Set when the run log could not be opened: health is off until a restart.
    disabled: runs.disabled ? runs.reason || 'the run log could not be opened' : null,
    sources,
    goals: sourcedGoals.map((g) => ({
      ...g,
      failing: g.sources.filter((id) => state(id) === 'failing'),
    })),
    metricSources,
  }
}

export function createSourceHttpHandler({ runs, goals, metricSources, now }) {
  return async function sourceHttpHandler(req, res, url) {
    const path = url.pathname
    if (path !== '/api/sources' && !path.startsWith('/api/sources/')) return false
    if (req.method !== 'GET') { send(res, 405, { error: 'GET only' }); return true }
    if (path === '/api/sources') {
      send(res, 200, sourceHealthPayload({ runs, goals, metricSources, now }))
      return true
    }
    if (path === '/api/sources/runs') {
      const source = url.searchParams.get('source')
      if (!source) { send(res, 400, { error: 'source is required' }); return true }
      send(res, 200, { source, runs: runs.runs(source, { limit: url.searchParams.get('limit') }) })
      return true
    }
    send(res, 404, { error: 'not found' })
    return true
  }
}
