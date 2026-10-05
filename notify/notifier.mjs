// notify/notifier.mjs — "say this, now, on every device that still exists."
//
// The one place a notification actually goes out. Both the test button and the
// queue drain call `deliver`, so there is no second code path that can behave
// differently from the one being tested by hand.
//
// Delivery is fan-out across devices and is deliberately forgiving: one dead phone
// must not stop a live one from being told, and a device the push service says is
// gone is expired rather than retried forever.
import { sendPush, pushPayload } from './push.mjs'

export function createNotifier({
  store,
  vapid = null,
  sendImpl = sendPush,
  log = () => {},
}) {
  const configured = () => Boolean(vapid?.publicKey && vapid?.privateKey && vapid?.subject)

  // Send one message to every active device. Returns a per-device report rather
  // than a boolean, because "it went to the iPhone but the iPad is gone" is the
  // answer the Settings panel has to be able to show.
  async function deliver({ title, body = '', url = null, category = 'reminder.adhoc', entryId = null, factKind = null, tag = null, endpoint = null, record = true, declarative = true }) {
    if (!configured()) {
      // Still recorded. A push that could not be sent is not a notification that
      // did not happen — the bell is the complete record.
      if (record) await store.record({ category, title, body, url, entryId, factKind, level: 'info' })
      return { ok: false, reason: 'not-configured', results: [] }
    }

    const all = await store.listSubscriptions()
    const targets = all.filter((s) => s.state === 'active' && (!endpoint || s.endpoint === endpoint))
    if (!targets.length) {
      if (record) await store.record({ category, title, body, url, entryId, factKind, level: 'info' })
      return { ok: false, reason: 'no-devices', results: [] }
    }

    const unread = record ? (await store.ledger({ limit: 1 })).unread + 1 : 0
    const payload = pushPayload({ title, body, url, entryId, badge: unread, category, declarative })

    const results = await Promise.all(targets.map(async (sub) => {
      let result
      try {
        result = await sendImpl({
          subscription: { endpoint: sub.endpoint, keys: sub.keys },
          payload,
          vapid,
          // A topic lets the push service collapse an undelivered message with its
          // replacement, which is what a moved reminder should do.
          topic: tag || undefined,
        })
      } catch (e) {
        result = { ok: false, gone: false, retryable: true, status: 0, error: e.message || String(e) }
      }

      if (result.ok) {
        await store.markDelivered(sub.endpoint)
      } else if (result.gone) {
        // On iOS this means the web app was removed from the Home Screen.
        await store.expireSubscription(sub.endpoint, `http ${result.status}`)
        log('push subscription gone', sub.label, result.status)
      } else {
        log('push failed', sub.label, result.status, result.error)
      }
      return { id: sub.id, label: sub.label, ...result }
    }))

    if (record) await store.record({ category, title, body, url, entryId, factKind, level: 'info' })

    const delivered = results.filter((r) => r.ok).length
    return {
      ok: delivered > 0,
      reason: delivered ? null : (results.every((r) => r.gone) ? 'all-devices-gone' : 'send-failed'),
      // Worth retrying only if some device failed in a way that might not repeat.
      // A malformed request fails identically forever; three attempts at it only
      // delay the error reaching the logs.
      retryable: results.some((r) => !r.ok && r.retryable),
      delivered,
      results,
      error: results.find((r) => !r.ok)?.error || null,
    }
  }

  // Drain the queue: everything due, revalidated, sent, and finished. Called by
  // the job tick. `revalidate` is injected so the collectors stay out of here.
  async function drain({ at = Date.now(), revalidate = null, limit = 10 } = {}) {
    const { claimed, expired } = await store.claimDue({ at, limit })
    const sent = []

    for (const entry of claimed) {
      let title = entry.title
      let body = entry.body
      let url = entry.url

      // Seconds before sending, hours after planning: is this still true?
      if (revalidate && entry.revalidate) {
        let verdict
        try {
          verdict = await revalidate(entry)
        } catch (e) {
          // A collector that throws fails closed. Sending something that could not
          // be verified is the failure this check exists to prevent.
          log('revalidation threw', entry.id, e.message || e)
          verdict = { state: 'stale' }
        }
        if (verdict?.state === 'stale') {
          await store.finish(entry.id, { outcome: 'stale' })
          continue
        }
        // Still true, different numbers — the ride happened after the plan was
        // built. Take the collector's freshly rendered sentence rather than the
        // one written hours ago about a number that has since moved. The AI's
        // wording is dropped with it: it was written against the old figure, and
        // the model is deliberately not on this path.
        if (verdict?.state === 'changed') {
          title = verdict.title || title
          body = verdict.body || ''
          url = verdict.url || url
        }
        if (verdict?.state === 'resolved') {
          if (!entry.resolvedTitle) {
            await store.finish(entry.id, { outcome: 'stale' })
            continue
          }
          title = entry.resolvedTitle
          body = verdict.body || ''
        }
      }

      // Inside the grace window but late: say what it was for, rather than reading
      // as a nudge about now.
      if (entry.late && verdictSuffix(entry, at)) body = [body, verdictSuffix(entry, at)].filter(Boolean).join(' · ')

      const result = await deliver({
        title,
        body,
        url,
        category: entry.category,
        entryId: entry.id,
        factKind: entry.factKind,
        tag: entry.dedupeKey,
      })

      await store.finish(entry.id, {
        outcome: result.ok ? 'delivered' : 'failed',
        error: result.ok ? null : (result.error || result.reason || 'send failed'),
        // What was actually sent, not what was planned: the queue and the bell
        // must not show a percentage the push never contained.
        body,
        url,
        // No devices and no keys are not transient either: there is nothing to
        // retry against, and burning three attempts on it turns a configuration
        // problem into a fake delivery failure.
        retryable: result.ok ? false : Boolean(result.retryable),
        title,
      })
      await store.recordFeedback({
        entryId: entry.id,
        category: entry.category,
        factKind: entry.factKind,
        planId: entry.planId,
        slot: entry.slot || null,
        event: result.ok ? 'delivered' : 'failed',
      })
      sent.push({ id: entry.id, ok: result.ok, title })
    }

    return { sent, expired: expired.length, claimed: claimed.length }
  }

  return { deliver, drain, configured }
}

function verdictSuffix(entry, at) {
  const minutes = Math.round((at - entry.deliverAt) / 60_000)
  if (minutes < 5) return ''
  if (minutes < 120) return `${minutes} min late`
  return `${Math.round(minutes / 60)} hours late`
}
