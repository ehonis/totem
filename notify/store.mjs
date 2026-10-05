// notify/store.mjs — the queue, the devices, the ledger, and the feedback log.
//
// Four files, one write mutex, atomic tmp-then-rename writes. The same shape as
// jobs/store.mjs, for the same reason: two concurrent read-modify-writes on a JSON
// file is how you lose a reminder and never find out.
//
//   data/notification-queue.json      pending and recently-delivered entries
//   data/push-subscriptions.json      registered devices (gitignored: an endpoint
//                                     plus its keys is enough to push to the phone)
//   data/notifications.json           the ledger the bell reads (the existing ring)
//   data/notification-feedback.jsonl  append-only; the training data for weights
//
// The queue is not a job scheduler. A job is a recurring thing with a next run; a
// queue entry is one notification with one instant, claimed once and then done.
import { readFile, writeFile, rename, mkdir, appendFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { deliveryState, dedupeKey as buildDedupeKey, DEFAULT_CATCH_UP_MINUTES } from './schedule.mjs'
import { categoryDef, CATEGORIES } from './categories.mjs'

const MAX_LEDGER = 200
// A delivered entry is kept in the queue long enough to attribute feedback and a
// click to it; the ledger is the durable record after that.
const KEEP_DELIVERED_MS = 7 * 24 * 60 * 60_000
const MAX_ATTEMPTS = 3

export function createNotifyStore({
  queueFile,
  subscriptionsFile,
  ledgerFile,
  feedbackFile,
  log = () => {},
  now = () => Date.now(),
  catchUpMinutes = DEFAULT_CATCH_UP_MINUTES,
  categories = CATEGORIES,
}) {
  let chain = Promise.resolve()

  // Serialize every read-modify-write. Normalized to always settle so one thrown
  // error cannot wedge every later mutation behind a rejected promise.
  function withLock(fn) {
    const run = chain.then(() => fn())
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch {
      return fallback
    }
  }

  async function writeJson(file, value) {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify({ ...value, updatedAt: new Date().toISOString() }, null, 2))
    await rename(tmp, file)
  }

  const readQueue = async () => {
    const parsed = await readJson(queueFile, null)
    return Array.isArray(parsed?.entries) ? parsed.entries : []
  }
  const writeQueue = (entries) => writeJson(queueFile, { entries })

  // ---- queue --------------------------------------------------------------

  // Enqueue one entry. Returns { entry, deduped } — `deduped` when an equivalent
  // pending entry already existed, which is the normal case for a rescheduled
  // reminder and must replace rather than stack.
  async function enqueue(input) {
    return withLock(async () => {
      const entries = await readQueue()
      const at = now()
      const def = categoryDef(input.category, categories)
      // An explicit key from the caller always collapses — that is the rescheduled
      // reminder case. A key *derived* from the fact only collapses when the fact
      // is actually identifiable: a category name alone is not an identity, and
      // treating it as one silently merges two unrelated reminders into whichever
      // was enqueued last.
      const explicitKey = input.dedupeKey || null
      const derivedKey = input.subject
        ? buildDedupeKey({
          category: input.category,
          factKind: input.factKind,
          subject: input.subject,
          date: input.planDate,
        })
        : null
      const key = explicitKey || derivedKey

      const entry = {
        id: `n_${randomUUID().slice(0, 8)}`,
        createdAt: at,
        deliverAt: Number(input.deliverAt) || at,
        category: input.category,
        factKind: input.factKind || null,
        title: String(input.title || '').slice(0, 160),
        body: String(input.body || '').slice(0, 600),
        url: input.url || null,
        dedupeKey: key,
        // Kept, not just used to build the dedupe key: the revalidator reads it at
        // delivery to find the goal or habit this entry is about. Without it, a
        // resolver looking up `undefined` finds nothing and reports the thing
        // finished — which is how a goal gets congratulated for being at 73%.
        subject: input.subject || null,
        source: input.source || { kind: 'adhoc', id: null },
        planId: input.planId || null,
        planDate: input.planDate || null,
        revalidate: input.revalidate || null,
        resolvedTitle: input.resolvedTitle || null,
        expiresAt: Number.isFinite(input.expiresAt) ? input.expiresAt : null,
        quietHours: input.quietHours || def.quietHours,
        state: 'pending',
        attempts: 0,
        lastError: null,
        deliveredAt: null,
        openedAt: null,
        feedback: null,
      }

      // Replace, don't stack. A reminder moved from 3pm to 4pm is one reminder.
      // `dedupeWindowMinutes: 0` means "never collapse automatically", which is
      // what every per-instance category wants.
      const windowMs = (def.dedupeWindowMinutes || 0) * 60_000
      let clash = null
      if (explicitKey) {
        clash = entries.find((e) => e.dedupeKey === explicitKey && e.state === 'pending')
      } else if (derivedKey && windowMs > 0) {
        clash = entries.find((e) => e.dedupeKey === derivedKey && e.state === 'pending'
          && Math.abs(e.deliverAt - entry.deliverAt) <= windowMs)
      }
      if (clash) {
        Object.assign(clash, {
          deliverAt: entry.deliverAt,
          title: entry.title,
          body: entry.body,
          url: entry.url,
          revalidate: entry.revalidate,
          resolvedTitle: entry.resolvedTitle,
          expiresAt: entry.expiresAt,
        })
        await writeQueue(entries)
        return { entry: clash, deduped: true }
      }

      entries.push(entry)
      await writeQueue(entries)
      return { entry, deduped: false }
    })
  }

  // Replace an earlier plan's undelivered entries for the same date rather than
  // adding to them, then enqueue the new ones. One call so a crash between the two
  // halves cannot leave the day both cleared and unplanned.
  async function applyPlan(plan) {
    return withLock(async () => {
      const entries = await readQueue()
      // Supersede every *undelivered* planned entry for this day, whichever run
      // planned it — not just this run's own. The evening digest re-collects the
      // same facts the morning did, so scoping this to one source made it add a
      // second copy of everything still outstanding. Ad-hoc reminders carry no
      // planDate and are never touched.
      const kept = entries.filter(
        (e) => e.planDate !== plan.planDate || e.state !== 'pending',
      )
      const superseded = entries.length - kept.length
      const at = now()
      const seen = new Set(kept.map((e) => e.dedupeKey).filter(Boolean))
      for (const e of plan.entries) {
        const def = categoryDef(e.category, categories)
        // Only a fact that names its subject has an identity worth deduping on.
        // "a habit is slipping" is a class of thing; "the journal habit, today"
        // is a thing.
        const dedupeKey = e.subject
          ? buildDedupeKey({ category: e.category, factKind: e.factKind, subject: e.subject, date: plan.planDate })
          : null
        // Belt and braces: an entry already delivered today must not be said again
        // because a later plan rediscovered the same fact.
        if (dedupeKey && seen.has(dedupeKey)) continue
        if (dedupeKey) seen.add(dedupeKey)
        kept.push({
          id: `n_${randomUUID().slice(0, 8)}`,
          createdAt: at,
          deliverAt: e.deliverAt,
          category: e.category,
          factKind: e.factKind || null,
          title: e.title,
          body: e.body || '',
          url: e.url || null,
          dedupeKey,
          subject: e.subject || null,
          source: plan.source,
          planId: plan.planId,
          planDate: plan.planDate,
          revalidate: e.revalidate || null,
          resolvedTitle: e.resolvedTitle || null,
          expiresAt: Number.isFinite(e.expiresAt) ? e.expiresAt : null,
          quietHours: def.quietHours,
          state: 'pending',
          attempts: 0,
          lastError: null,
          deliveredAt: null,
          openedAt: null,
          feedback: null,
        })
      }
      await writeQueue(kept)
      return {
        planId: plan.planId,
        enqueued: kept.filter((e) => e.planId === plan.planId).length,
        superseded,
        skipped: plan.entries.length - kept.filter((e) => e.planId === plan.planId).length,
      }
    })
  }

  // Everything due now, claimed in one atomic step so a second drain running
  // concurrently cannot pick up the same entry. Claiming marks `sending` before any
  // network call — the opposite order double-delivers after a crash.
  async function claimDue({ at = now(), limit = 10 } = {}) {
    return withLock(async () => {
      const entries = await readQueue()
      const graceMs = catchUpMinutes * 60_000
      const claimed = []
      const expired = []

      for (const entry of entries) {
        if (entry.state !== 'pending') continue
        if (claimed.length >= limit) break

        // Past its own deadline: dropped rather than delivered wrong.
        if (Number.isFinite(entry.expiresAt) && at > entry.expiresAt) {
          entry.state = 'expired'
          expired.push(entry)
          continue
        }

        const state = deliveryState(entry.deliverAt, at, graceMs)
        if (state === 'pending') continue
        if (state === 'missed') {
          // The box was off. One late run, not a backlog burst.
          entry.state = 'missed'
          expired.push(entry)
          continue
        }
        entry.state = 'sending'
        entry.attempts += 1
        entry.late = at - entry.deliverAt > 5 * 60_000
        claimed.push(entry)
      }

      if (claimed.length || expired.length) await writeQueue(entries)
      return { claimed, expired }
    })
  }

  // The other half of claimDue. `outcome` is 'delivered' | 'failed' | 'stale' —
  // stale being a revalidation miss, which is a success of the design, not a fault.
  async function finish(id, { outcome, error = null, title = null, body = null, url = null, retryable = true } = {}) {
    return withLock(async () => {
      const entries = await readQueue()
      const entry = entries.find((e) => e.id === id)
      if (!entry) return null
      if (outcome === 'delivered') {
        entry.state = 'delivered'
        entry.deliveredAt = now()
        // The delivered text can differ from the planned text: a resolved entry
        // sends its other copy, and one whose numbers moved is re-worded seconds
        // before it goes out. Store what was sent — a queue row that disagrees
        // with the phone is a bug report waiting to be filed.
        if (title) entry.title = title
        if (body !== null) entry.body = body
        if (url) entry.url = url
      } else if (outcome === 'stale') {
        entry.state = 'stale'
      } else {
        entry.lastError = error ? String(error).slice(0, 300) : 'failed'
        // Returned to pending to be retried; abandoned once it has had its three,
        // or immediately when the failure is one that cannot come good on its own
        // (a malformed request, no registered device, no VAPID keys).
        entry.state = (!retryable || entry.attempts >= MAX_ATTEMPTS) ? 'failed' : 'pending'
      }
      await writeQueue(entries)
      return entry
    })
  }

  async function listQueue({ state = null, limit = 200 } = {}) {
    const entries = await readQueue()
    const filtered = state ? entries.filter((e) => e.state === state) : entries
    return filtered.sort((a, b) => a.deliverAt - b.deliverAt).slice(0, limit)
  }

  async function cancel(id) {
    return withLock(async () => {
      const entries = await readQueue()
      const next = entries.filter((e) => !(e.id === id && e.state === 'pending'))
      const removed = entries.length - next.length
      if (removed) await writeQueue(next)
      return { removed }
    })
  }

  // Delivered entries are kept a week so a click or a rating can still be
  // attributed to them, then dropped. The ledger is the durable record.
  async function prune({ at = now() } = {}) {
    return withLock(async () => {
      const entries = await readQueue()
      const next = entries.filter((e) => {
        if (e.state === 'pending' || e.state === 'sending') return true
        const when = e.deliveredAt || e.deliverAt || e.createdAt
        return at - when < KEEP_DELIVERED_MS
      })
      const removed = entries.length - next.length
      if (removed) await writeQueue(next)
      return { removed }
    })
  }

  // ---- devices ------------------------------------------------------------

  async function listSubscriptions() {
    const parsed = await readJson(subscriptionsFile, null)
    return Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : []
  }

  async function saveSubscription({ subscription, label = null, userAgent = null }) {
    const endpoint = subscription?.endpoint
    if (!endpoint) throw new Error('subscription has no endpoint')
    return withLock(async () => {
      const subs = await listSubscriptions()
      const at = now()
      const existing = subs.find((s) => s.endpoint === endpoint)
      if (existing) {
        // Re-subscribing on the same device refreshes its keys and revives it —
        // which is exactly what pushsubscriptionchange does.
        Object.assign(existing, {
          keys: subscription.keys,
          label: label || existing.label,
          userAgent: userAgent || existing.userAgent,
          state: 'active',
          expiredAt: null,
          updatedAt: at,
        })
        await writeJson(subscriptionsFile, { subscriptions: subs })
        return existing
      }
      const record = {
        id: `d_${randomUUID().slice(0, 8)}`,
        endpoint,
        keys: subscription.keys || null,
        label: label || 'This device',
        userAgent: userAgent || null,
        state: 'active',
        createdAt: at,
        updatedAt: at,
        lastDeliveredAt: null,
        expiredAt: null,
      }
      subs.push(record)
      await writeJson(subscriptionsFile, { subscriptions: subs })
      return record
    })
  }

  // A 404 or 410 from the push service means the web app was removed from the
  // Home Screen. Recorded as expired, not deleted: Settings has to be able to say
  // "that device is gone" rather than quietly showing nothing.
  async function expireSubscription(endpoint, reason = 'gone') {
    return withLock(async () => {
      const subs = await listSubscriptions()
      const sub = subs.find((s) => s.endpoint === endpoint)
      if (!sub) return null
      sub.state = 'expired'
      sub.expiredAt = now()
      sub.lastError = reason
      await writeJson(subscriptionsFile, { subscriptions: subs })
      return sub
    })
  }

  async function markDelivered(endpoint) {
    return withLock(async () => {
      const subs = await listSubscriptions()
      const sub = subs.find((s) => s.endpoint === endpoint)
      if (!sub) return null
      sub.lastDeliveredAt = now()
      await writeJson(subscriptionsFile, { subscriptions: subs })
      return sub
    })
  }

  async function removeSubscription(endpoint) {
    return withLock(async () => {
      const subs = await listSubscriptions()
      const next = subs.filter((s) => s.endpoint !== endpoint)
      const removed = subs.length - next.length
      if (removed) await writeJson(subscriptionsFile, { subscriptions: next })
      return { removed }
    })
  }

  // ---- ledger -------------------------------------------------------------

  // Every notification lands here whether or not it was ever pushed. The bell reads
  // this, and a push that could not be delivered is still recorded — that is the
  // difference between a quiet day and a broken one.
  async function record({ category = 'job.failed', level = 'info', title, body = '', url = null, entryId = null, jobId = null, factKind = null }) {
    const item = {
      id: `l_${randomUUID().slice(0, 8)}`,
      ts: now(),
      level,
      category,
      title: String(title || '').slice(0, 160),
      body: String(body || '').slice(0, 600),
      url,
      entryId,
      jobId,
      // Copied onto the ledger rather than looked up through the queue entry: the
      // entry is superseded by the next plan and pruned after a week, and a
      // notification he can no longer rate is feedback silently lost.
      factKind,
      read: false,
    }
    await withLock(async () => {
      const parsed = await readJson(ledgerFile, null)
      const items = Array.isArray(parsed?.items) ? parsed.items : []
      items.unshift(item)
      await writeJson(ledgerFile, { items: items.slice(0, MAX_LEDGER) })
    }).catch((e) => log('ledger write failed', e.message || e))
    return item
  }

  async function ledger({ limit = 50 } = {}) {
    const parsed = await readJson(ledgerFile, null)
    const items = Array.isArray(parsed?.items) ? parsed.items : []
    return { items: items.slice(0, limit), unread: items.filter((i) => !i.read).length }
  }

  async function markRead(ids = null) {
    return withLock(async () => {
      const parsed = await readJson(ledgerFile, null)
      const items = Array.isArray(parsed?.items) ? parsed.items : []
      for (const item of items) if (!ids || ids.includes(item.id)) item.read = true
      await writeJson(ledgerFile, { items })
      return { ok: true, unread: items.filter((i) => !i.read).length }
    })
  }

  // ---- feedback -----------------------------------------------------------

  // Append-only, and the source of truth. The derived weights file can always be
  // deleted and rebuilt from this; the reverse is not true, which is why a vote is
  // never edited in place.
  async function recordFeedback({ entryId = null, category, factKind = null, planId = null, slot = null, event, vote = null, reasons = [] }) {
    const row = {
      ts: now(), entryId, category, factKind, planId, slot, event,
      vote: vote || null,
      reasons: Array.isArray(reasons) ? reasons.slice(0, 5) : [],
    }
    await mkdir(dirname(feedbackFile), { recursive: true })
    await appendFile(feedbackFile, `${JSON.stringify(row)}\n`)

    // The vote is mirrored onto the queue entry so the bell can render it without
    // replaying the log. The log stays authoritative.
    if (entryId && event === 'vote') {
      await withLock(async () => {
        const entries = await readQueue()
        const entry = entries.find((e) => e.id === entryId)
        if (!entry) return
        entry.feedback = { vote: row.vote, reasons: row.reasons, at: row.ts }
        await writeQueue(entries)
      }).catch((e) => log('feedback mirror failed', e.message || e))
    }
    return row
  }

  // Set once the entry has been counted as ignored, so a sweep every 30 seconds
  // does not record the same negative over and over and bury a kind.
  async function markIgnoredCounted(entryId) {
    return withLock(async () => {
      const entries = await readQueue()
      const entry = entries.find((e) => e.id === entryId)
      if (!entry || entry.ignoredCounted) return entry || null
      entry.ignoredCounted = true
      await writeQueue(entries)
      return entry
    })
  }

  async function markOpened(entryId) {
    return withLock(async () => {
      const entries = await readQueue()
      const entry = entries.find((e) => e.id === entryId)
      if (!entry || entry.openedAt) return entry || null
      entry.openedAt = now()
      await writeQueue(entries)
      return entry
    })
  }

  async function readFeedback() {
    try {
      const text = await readFile(feedbackFile, 'utf8')
      return text.split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)
    } catch {
      return []
    }
  }

  return {
    queueFile, subscriptionsFile, ledgerFile, feedbackFile,
    enqueue, applyPlan, claimDue, finish, listQueue, cancel, prune,
    listSubscriptions, saveSubscription, expireSubscription, markDelivered, removeSubscription,
    record, ledger, markRead,
    recordFeedback, markOpened, markIgnoredCounted, readFeedback,
  }
}
