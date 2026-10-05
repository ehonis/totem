// notify/plan.mjs — turn a day's facts into a day's notifications.
//
// The digest does not send a notification. It emits a *plan*: several entries
// scheduled across the day at the times they can still change what the owner does.
// A morning collection routinely finds five true things, and five things in one
// push is a push nobody reads.
//
// Pure. Takes facts and settings, returns entries and — just as importantly —
// what it dropped and why, because "why did I not get told about that" is a
// question the Logs view has to be able to answer.
import { categoryDef, isPinned, CATEGORIES } from './categories.mjs'
import { slotTimeOn, spaceOut, dayKey, normalizePlanSettings } from './schedule.mjs'

// A fact:
//   { kind, category, salience, slot?, subject?, title, body?, url?,
//     revalidate: { collector, factKey }, resolvedTitle? }
//
// `salience` is a 0..100 hand-assigned number from the collector. `kind` is what
// feedback weights attach to — finer than a category, so downvoting "weekly habit
// nudges" does not also silence "your streak ends tonight".

export const WEIGHT_FLOOR = 0.25
export const WEIGHT_CEILING = 2

export function planDay({
  facts = [],
  now,
  tz,
  settings,
  weights = {},
  source = 'daily-digest',
  planId = null,
  // Bushido brings its own table; see notify/categories.mjs.
  categories = CATEGORIES,
}) {
  const cfg = normalizePlanSettings(settings)
  const dropped = []

  const scored = facts.map((fact) => {
    const def = categoryDef(fact.category, categories)
    const pinned = isPinned(fact.category, categories)
    // Pinned facts are exempt from learned weights. This is the guardrail that
    // keeps feedback from turning into silence about the things that matter most.
    const weight = pinned ? 1 : clampWeight(weights[fact.kind])
    return {
      ...fact,
      pinned,
      weight,
      score: pinned ? Number.POSITIVE_INFINITY : (Number(fact.salience) || 0) * weight,
      slot: fact.slot || def.slot || 'morning',
      quietHours: def.quietHours,
    }
  })

  // Pinned first, then by weighted salience. Ties break on the earlier slot so the
  // ordering is stable and readable rather than dependent on collector order.
  scored.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (b.score !== a.score) return b.score - a.score
    return slotTimeOn(now, a.slot, tz, cfg.slots) - slotTimeOn(now, b.slot, tz, cfg.slots)
  })

  const kept = []
  for (const fact of scored) {
    if (kept.length >= cfg.cap) {
      dropped.push({ fact, reason: 'cap' })
      continue
    }
    kept.push(fact)
  }

  const desired = kept.map((fact) => ({
    ...fact,
    deliverAt: slotTimeOn(now, fact.slot, tz, cfg.slots),
  }))

  const spaced = spaceOut(desired, {
    minGapMinutes: cfg.minGapMinutes,
    quietHours: cfg.quietHours,
    tz,
    now,
  })

  const entries = []
  for (const item of spaced) {
    if (item.action === 'suppress') {
      dropped.push({ fact: item, reason: 'quiet-hours' })
      continue
    }
    // Spacing and quiet hours only ever move an entry later, which for most facts
    // is harmless and for some is nonsense: "your streak ends tonight", deferred
    // past midnight, is advice about a streak that has already broken. A fact that
    // stops being true at a deadline is dropped, not delivered wrong.
    if (Number.isFinite(item.expiresAt) && item.deliverAt > item.expiresAt) {
      dropped.push({ fact: item, reason: 'too-late' })
      continue
    }
    entries.push({
      category: item.category,
      factKind: item.kind,
      title: item.title,
      body: item.body || '',
      url: item.url || null,
      deliverAt: item.deliverAt,
      slot: item.slot,
      salience: item.salience,
      weight: item.weight,
      pinned: item.pinned,
      subject: item.subject || null,
      expiresAt: Number.isFinite(item.expiresAt) ? item.expiresAt : null,
      // Re-checked seconds before sending, hours after planning. This is what
      // stops "you're one away from finishing" arriving after it was finished.
      revalidate: item.revalidate || null,
      resolvedTitle: item.resolvedTitle || null,
    })
  }

  return {
    planId: planId || `plan_${dayKey(now, tz)}_${source}`,
    planDate: dayKey(now, tz),
    source,
    generatedAt: now,
    settings: cfg,
    entries: entries.sort((a, b) => a.deliverAt - b.deliverAt),
    dropped,
  }
}

function clampWeight(raw) {
  const n = Number(raw)
  // A cold start is exactly neutral. No learning from a single grumpy Tuesday.
  if (!Number.isFinite(n) || n <= 0) return 1
  return Math.min(Math.max(n, WEIGHT_FLOOR), WEIGHT_CEILING)
}

// A later run supersedes the undelivered entries of an earlier plan for the same
// date rather than adding to them. Without this the evening run duplicates every
// morning fact still outstanding.
export function supersede(existingEntries, plan) {
  const keep = existingEntries.filter(
    (e) => e.planDate !== plan.planDate || e.state === 'delivered' || e.state === 'sending',
  )
  const superseded = existingEntries.filter((e) => !keep.includes(e))
  return { keep, superseded }
}
