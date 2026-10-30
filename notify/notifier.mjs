// notify/notifier.mjs — "say this, now, on every device that still exists."
//
// The one place a notification actually goes out. Both the test button and the
// queue drain call `deliver`, so there is no second code path that can behave
// differently from the one being tested by hand.
//
// Delivery is fan-out across devices and is deliberately forgiving: one dead phone
// must not stop a live one from being told, and a device the push service says is
// gone is expired rather than retried forever.
//
// Two transports, one fan-out: a browser on the Home Screen is a Web Push
// subscription, the native iPhone app is an APNs device token (apns.mjs). Every
// category, quiet hour and queue rule is upstream of this, so both get the same
// notifications.
//
// And one gate, before either: every delivery asks notify/dedupe.mjs whether it
// has already been said, by key or by story. Being the one place a push goes out
// is what makes that a guarantee rather than a convention each caller keeps.
import { sendPush, pushPayload } from './push.mjs'
import { apnsDismissPayload, apnsPayload } from './apns.mjs'
import { createDedupeGate } from './dedupe.mjs'

export function createNotifier({
  store,
  vapid = null,
  sendImpl = sendPush,
  // createApnsSender(...) when APNS_* is set; null keeps the native app off.
  apns = null,
  // The dedupe gate (notify/dedupe.mjs). The bridge passes one backed by a file;
  // without one, an in-memory gate still holds back repeats within a process.
  gate = createDedupeGate(),
  log = () => {},
}) {
  const webConfigured = () => Boolean(vapid?.publicKey && vapid?.privateKey && vapid?.subject)
  const configured = () => webConfigured() || Boolean(apns)
  const isNative = (sub) => sub.transport === 'apns'
  // A device whose transport has no keys is skipped, not failed: Web Push keys
  // missing says nothing about whether the iPhone app can be reached.
  const reachable = (sub) => (isNative(sub) ? Boolean(apns) : webConfigured())
  // Tags of notifications the app was sent and nothing has taken down yet, so
  // dismiss() is a no-op (no push) unless there is something on the phone to
  // clear. In memory: after a restart the app's own check on opening
  // (mobile/src/shell/push.ts) clears what this forgot.
  const shown = new Set()

  // Send one message to every active device. Returns a per-device report rather
  // than a boolean, because "it went to the iPhone but the iPad is gone" is the
  // answer the Settings panel has to be able to show.
  async function deliver({
    title, body = '', url = null, category = 'reminder.adhoc', entryId = null, factKind = null, tag = null, endpoint = null, record = true, declarative = true,
    // What the gate identifies this by: an explicit key and how long it stays
    // said, and for news the story itself ({ title, url }). See notify/dedupe.mjs.
    dedupeKey = null, dedupeUntil = null, story = null,
  }) {
    // A test sent to one device is a test, not a notification: it is not recorded
    // and not remembered as said.
    let verdict = { action: 'send', ticket: null }
    if (!endpoint) {
      try {
        verdict = await gate.admit({ category, title, body, url, entryId, dedupeKey, dedupeUntil, story })
      } catch (e) {
        // A broken dedupe log must not become silence. Send it, and say so.
        log('dedupe gate failed, sending anyway', e?.message || e)
      }
    }
    if (verdict.action === 'suppress') {
      // Folded into the one he already has: the bell's copy counts it. One still
      // going out has no bell copy yet; its confirm() hands this back to count.
      if (verdict.match?.ledgerId) await countSimilar(verdict.match.ledgerId, [{ title, body, url }])
      return { ok: false, suppressed: true, reason: verdict.reason, duplicateOf: verdict.match?.duplicateOf || null, retryable: false, delivered: 0, results: [] }
    }
    if (verdict.action === 'defer') {
      // Waiting on the model check (dedupe.mjs). Only queued entries are deferred;
      // the drain puts this one back until `until`.
      return { ok: false, deferred: true, until: verdict.until, reason: 'dedupe-check', retryable: false, delivered: 0, results: [] }
    }

    // `reached`: whether the bell or a phone has it. Not reached releases the
    // gate's reservation, so a retry, or tomorrow's plan, is not called a repeat
    // of a notification that never arrived.
    const remember = async (reached) => {
      const item = record ? await store.record({ category, title, body, url, entryId, factKind, level: 'info' }) : null
      try {
        const { similar } = await gate.confirm(verdict.ticket, { ok: reached, ledgerId: item?.id || null })
        if (similar?.length) await countSimilar(item.id, similar)
      } catch (e) {
        log('dedupe confirm failed', e?.message || e)
      }
    }

    if (!configured()) {
      // Still recorded. A push that could not be sent is not a notification that
      // did not happen — the bell is the complete record.
      await remember(record)
      return { ok: false, reason: 'not-configured', results: [] }
    }

    const all = await store.listSubscriptions()
    const targets = all.filter((s) => s.state === 'active' && reachable(s) && (!endpoint || s.endpoint === endpoint))
    if (!targets.length) {
      await remember(record)
      return { ok: false, reason: 'no-devices', results: [] }
    }

    const unread = record ? (await store.ledger({ limit: 1 })).unread + 1 : 0
    const payload = pushPayload({ title, body, url, entryId, badge: unread, category, declarative })
    const nativePayload = apnsPayload({ title, body, url, entryId, badge: unread, category, tag })

    const results = await Promise.all(targets.map(async (sub) => {
      let result
      try {
        result = isNative(sub)
          ? await apns.send({ deviceToken: sub.token, environment: sub.environment || 'production', payload: nativePayload, collapseId: tag || null })
          : await sendImpl({
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
        if (isNative(sub) && tag) shown.add(tag)
      } else if (result.gone) {
        // On iOS this means the web app was removed from the Home Screen, or the
        // native app was deleted.
        await store.expireSubscription(sub.endpoint, `http ${result.status}`)
        log('push subscription gone', sub.label, result.status)
      } else {
        log('push failed', sub.label, result.status, result.error)
      }
      return { id: sub.id, label: sub.label, ...result }
    }))

    const delivered = results.filter((r) => r.ok).length
    await remember(delivered > 0)
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

  async function countSimilar(ledgerId, rows) {
    if (!store.noteSimilar) return
    for (const row of rows) {
      await store.noteSimilar(ledgerId, { title: row.title, body: row.body, url: row.url })
        .catch((e) => log('similar count failed', e?.message || e))
    }
  }

  // Take a notification back off every phone that showed it: the chat it was
  // about has been read, somewhere. Only the native app can do this; Web Push has
  // no silent push.
  async function dismiss(tag) {
    if (!apns || !tag || !shown.delete(tag)) return { ok: false, sent: 0 }
    const targets = (await store.listSubscriptions()).filter((s) => s.state === 'active' && isNative(s))
    const payload = apnsDismissPayload([tag])
    const results = await Promise.all(targets.map(async (sub) => {
      let result
      try {
        result = await apns.send({ deviceToken: sub.token, environment: sub.environment || 'production', payload, background: true })
      } catch (e) {
        result = { ok: false, gone: false, status: 0, error: e.message || String(e) }
      }
      if (result.gone) await store.expireSubscription(sub.endpoint, `http ${result.status}`)
      else if (!result.ok) log('push dismiss failed', sub.label, result.status, result.error)
      return result
    }))
    const sent = results.filter((r) => r.ok).length
    return { ok: sent > 0, sent }
  }

  // Drain the queue: everything due, revalidated, sent, and finished. Called by
  // the job tick. `revalidate` is injected so the collectors stay out of here.
  async function drain({ at = Date.now(), revalidate = null, limit = 10 } = {}) {
    const { claimed, expired } = await store.claimDue({ at, limit })
    const sent = []
    // Pinned first: nothing a story or a quota is waiting on should come before
    // a reminder or an approval code.
    claimed.sort((a, b) => Number(gate.isPinned?.(b.category) || false) - Number(gate.isPinned?.(a.category) || false))

    for (const entry of claimed) {
      let title = entry.title
      let body = entry.body
      let url = entry.url

      // Planned before the habit nudges were retired. Finished as stale rather
      // than cancelled, so the queue keeps its history.
      if (isRetiredNudge(entry)) {
        await store.finish(entry.id, { outcome: 'stale' })
        continue
      }

      // Something asked for this to wait (gate.addHold): back to pending, due
      // again at `until`, with the attempt it was just charged handed back.
      const hold = gate.shouldHold(entry, at)
      if (hold) {
        await store.finish(entry.id, { outcome: 'held', until: hold.until })
        continue
      }

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
        dedupeKey: entry.dedupeKey,
        dedupeUntil: entry.dedupeUntil,
        story: entry.story,
      })

      // Already said, by key or by story. Finished, not failed: there is nothing
      // to retry, and the queue row says which notification it was folded into.
      if (result.suppressed) {
        await store.finish(entry.id, { outcome: 'suppressed', error: result.duplicateOf ? `same as ${result.duplicateOf}` : result.reason })
        sent.push({ id: entry.id, ok: false, suppressed: true, title })
        continue
      }
      // A model check is deciding whether this repeats an earlier story; it is
      // asked again once that answer is in.
      if (result.deferred) {
        await store.finish(entry.id, { outcome: 'held', until: result.until })
        sent.push({ id: entry.id, ok: false, held: true, title })
        continue
      }

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

  return { deliver, dismiss, drain, configured, nativeConfigured: () => Boolean(apns), gate }
}

// Habit completion nudges ("streak ends tonight", "one more to finish", "short
// this week") are no longer raised; see notify/signals.mjs. Matched on any of the
// three marks a queued one carries, since the weekly one was filed under
// goal.nearcomplete and real goal nudges share that category.
const RETIRED_FACT_KINDS = new Set(['habit.streak-ending', 'habit.near-target', 'habit.behind-pace'])

export function isRetiredNudge(entry) {
  return entry.category === 'habit.slipping'
    || RETIRED_FACT_KINDS.has(entry.factKind)
    || entry.revalidate?.collector === 'habits'
}

function verdictSuffix(entry, at) {
  const minutes = Math.round((at - entry.deliverAt) / 60_000)
  if (minutes < 5) return ''
  if (minutes < 120) return `${minutes} min late`
  return `${Math.round(minutes / 60)} hours late`
}
