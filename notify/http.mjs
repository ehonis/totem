/**
 * The `/api/push*` adapter.
 *
 * Mounted in `bridge.mjs` beside the todo and goal handlers. Same contract they
 * offer: a thin parse of the request into a store or notifier call, structured
 * errors, and no business logic of its own.
 *
 * One route is deliberately different. `POST /api/push/rotate` is called by the
 * service worker when iOS rotates a subscription, and a service worker has no
 * bearer token to send — so it is mounted *before* the auth check and authorises
 * itself by naming the endpoint it is replacing. Knowing a live endpoint is the
 * capability; an attacker who already has one gains nothing by swapping it for
 * another they control, because the ledger and the settings page both show the
 * device list. `PUSH_PUBLIC_PATHS` is exported so the bridge cannot forget.
 */
import { generateVapidKeys } from './push.mjs'
import { deriveWeights } from './weights.mjs'
import { CATEGORIES } from './categories.mjs'

const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' }
const MAX_BODY = 64 * 1024

export const PUSH_PUBLIC_PATHS = ['/api/push/rotate']

function send(res, status, body) {
  res.writeHead(status, JSON_TYPE)
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (!bytes) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body must be valid JSON')
  }
}

// Never return the private key, and never return the raw p256dh/auth of a device:
// together they are enough to push to the phone from anywhere.
const deviceDto = (sub) => ({
  id: sub.id,
  label: sub.label,
  state: sub.state,
  createdAt: sub.createdAt,
  updatedAt: sub.updatedAt,
  lastDeliveredAt: sub.lastDeliveredAt,
  expiredAt: sub.expiredAt,
  lastError: sub.lastError || null,
  // Enough to recognise a device in a list, not enough to send to it.
  endpointHint: `${String(sub.endpoint).slice(0, 40)}…`,
  host: safeHost(sub.endpoint),
})

function safeHost(endpoint) {
  try { return new URL(endpoint).host } catch { return null }
}

export function createPushHttpHandler({ store, notifier, vapidPublicKey = null, categories = CATEGORIES }) {
  if (!store) throw new TypeError('createPushHttpHandler requires store')
  if (!notifier) throw new TypeError('createPushHttpHandler requires notifier')

  return async function pushHttpHandler(req, res, suppliedUrl) {
    const url = suppliedUrl instanceof URL ? suppliedUrl : new URL(req.url, 'http://localhost')
    const path = url.pathname
    if (!path.startsWith('/api/push')) return false

    try {
      // What the client needs before it can subscribe, plus enough state for the
      // settings page to tell the truth about why a toggle is unavailable.
      if (req.method === 'GET' && path === '/api/push/key') {
        send(res, 200, {
          publicKey: vapidPublicKey,
          configured: notifier.configured(),
        })
        return true
      }

      if (req.method === 'GET' && path === '/api/push/subscriptions') {
        const subs = await store.listSubscriptions()
        send(res, 200, {
          configured: notifier.configured(),
          devices: subs.map(deviceDto),
          active: subs.filter((s) => s.state === 'active').length,
        })
        return true
      }

      if (req.method === 'POST' && path === '/api/push/subscribe') {
        const body = await readJson(req)
        const subscription = body.subscription || body
        if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
          send(res, 400, { error: 'subscription must carry endpoint and keys.p256dh/auth' })
          return true
        }
        const saved = await store.saveSubscription({
          subscription,
          label: body.label || null,
          userAgent: body.userAgent || req.headers['user-agent'] || null,
        })
        send(res, 200, { device: deviceDto(saved) })
        return true
      }

      if (req.method === 'POST' && path === '/api/push/unsubscribe') {
        const body = await readJson(req)
        if (!body.endpoint) {
          send(res, 400, { error: 'endpoint is required' })
          return true
        }
        send(res, 200, await store.removeSubscription(body.endpoint))
        return true
      }

      // Unauthenticated by necessity — see the module header.
      if (req.method === 'POST' && path === '/api/push/rotate') {
        const body = await readJson(req)
        const subscription = body.subscription
        if (!body.oldEndpoint || !subscription?.endpoint) {
          send(res, 400, { error: 'oldEndpoint and subscription are required' })
          return true
        }
        const known = (await store.listSubscriptions()).some((s) => s.endpoint === body.oldEndpoint)
        if (!known) {
          // An endpoint this server has never seen is not a rotation.
          send(res, 404, { error: 'unknown subscription' })
          return true
        }
        const saved = await store.saveSubscription({ subscription, label: body.label || null })
        if (body.oldEndpoint !== subscription.endpoint) await store.removeSubscription(body.oldEndpoint)
        send(res, 200, { device: deviceDto(saved) })
        return true
      }

      // The test button. Goes through exactly the same notifier the queue drain
      // uses, so a test that works proves the real path works.
      if (req.method === 'POST' && path === '/api/push/test') {
        const body = await readJson(req)
        const result = await notifier.deliver({
          title: body.title || 'Totem test',
          body: body.body || `Sent from the dashboard at ${new Date().toLocaleTimeString()}.`,
          url: body.url || '/settings/notifications',
          category: 'reminder.adhoc',
          endpoint: body.endpoint || null,
          // Lets a test compare the two display paths on a real device.
          declarative: body.declarative !== false,
        })
        send(res, result.ok ? 200 : 502, {
          ok: result.ok,
          reason: result.reason,
          delivered: result.delivered || 0,
          results: (result.results || []).map((r) => ({
            label: r.label, ok: r.ok, status: r.status, gone: r.gone, error: r.error || null,
          })),
        })
        return true
      }

      // Recorded when the app is opened from a notification. The single strongest
      // feedback signal, and it costs the user nothing.
      if (req.method === 'POST' && path === '/api/push/opened') {
        const body = await readJson(req)
        if (!body.entryId) {
          send(res, 400, { error: 'entryId is required' })
          return true
        }
        const entry = await store.markOpened(body.entryId)
        if (entry) {
          await store.recordFeedback({
            entryId: entry.id, category: entry.category, factKind: entry.factKind,
            planId: entry.planId, slot: entry.slot || null, event: 'opened',
          })
        }
        send(res, 200, { ok: Boolean(entry) })
        return true
      }

      // What the bell shows: every notification that has been raised, whether or
      // not it ever reached a phone, with its rating and enough context to rate it.
      if (req.method === 'GET' && path === '/api/push/history') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200)
        const [ledger, queue] = await Promise.all([
          store.ledger({ limit }),
          store.listQueue({ limit: 300 }),
        ])
        const byId = new Map(queue.map((e) => [e.id, e]))
        const items = ledger.items.map((item) => {
          const entry = item.entryId ? byId.get(item.entryId) : null
          const factKind = item.factKind || entry?.factKind || null
          return {
            ...item,
            factKind,
            // Only a notification that came from a fact can teach anything: an
            // ad-hoc reminder he set himself is not a preference to learn from.
            ratable: Boolean(factKind),
            feedback: entry?.feedback || null,
            openedAt: entry?.openedAt || null,
            state: entry?.state || 'recorded',
          }
        })
        send(res, 200, {
          items,
          unread: ledger.unread,
          // Upcoming, so the bell can answer "what is it going to tell me".
          upcoming: queue
            .filter((e) => e.state === 'pending')
            .sort((a, b) => a.deliverAt - b.deliverAt)
            .slice(0, 20)
            .map((e) => ({
              id: e.id, title: e.title, body: e.body, deliverAt: e.deliverAt,
              category: e.category, factKind: e.factKind, source: e.source,
            })),
        })
        return true
      }

      if (req.method === 'POST' && path === '/api/push/read') {
        const body = await readJson(req)
        send(res, 200, await store.markRead(Array.isArray(body.ids) ? body.ids : null))
        return true
      }

      // What the feedback has added up to, in numbers and in words.
      if (req.method === 'GET' && path === '/api/push/weights') {
        const { detail, computedAt } = deriveWeights(await store.readFeedback(), { categories })
        send(res, 200, {
          computedAt,
          categories: Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, v.label])),
          weights: detail,
        })
        return true
      }

      // Derived, so resetting is deleting an opinion rather than editing history:
      // the feedback log is append-only and a reset writes a tombstone into it.
      if (req.method === 'POST' && path === '/api/push/weights/reset') {
        const body = await readJson(req)
        await store.recordFeedback({
          category: null,
          factKind: body.factKind || null,
          event: 'reset',
        })
        send(res, 200, { ok: true, factKind: body.factKind || null })
        return true
      }

      if (req.method === 'POST' && path === '/api/push/feedback') {
        const body = await readJson(req)
        if (!body.entryId || !['up', 'down'].includes(body.vote)) {
          send(res, 400, { error: 'entryId and vote (up|down) are required' })
          return true
        }
        const row = await store.recordFeedback({
          entryId: body.entryId,
          category: body.category || null,
          factKind: body.factKind || null,
          event: 'vote',
          vote: body.vote,
          reasons: Array.isArray(body.reasons) ? body.reasons : [],
        })
        send(res, 200, { ok: true, at: row.ts })
        return true
      }

      send(res, 404, { error: `no push route for ${req.method} ${path}` })
      return true
    } catch (error) {
      send(res, 400, { error: error.message || 'push request failed' })
      return true
    }
  }
}

// Exported so `node notify/cli.mjs keys` and the bridge share one implementation.
export { generateVapidKeys }
