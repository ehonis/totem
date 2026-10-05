// notify/weights.mjs — what the feedback adds up to.
//
// Derived, never authored: every number here is recomputed from
// `data/notification-feedback.jsonl`, which is append-only. Delete the derived
// file and nothing is lost. That is the whole reason a changed vote is a second
// row rather than an edit.
//
// A weight multiplies a fact kind's salience in the ranker. It decides what makes
// the daily cap — not what a notification says, and never whether a pinned fact is
// sent at all. A system that can learn its way to silence is indistinguishable
// from one that is broken, so:
//
//   * weights are bounded, 0.25×–2.0×. A kind can become rare; it cannot be muted.
//   * a cold start is exactly 1.0. No learning from a single grumpy Tuesday.
//   * feedback decays over ~90 days, so last spring does not outvote last week.
//   * pinned categories ignore all of it (see notify/plan.mjs).
import { isPinned, CATEGORIES } from './categories.mjs'

export const WEIGHT_FLOOR = 0.25
export const WEIGHT_CEILING = 2
export const HALF_LIFE_DAYS = 90
// Below this many pieces of evidence the multiplier stays neutral. Four is enough
// to be a pattern and few enough to respond within a week of real use.
export const MIN_EVIDENCE = 4

// What each kind of evidence is worth. An explicit vote counts for much more than
// a behavioural signal, because he meant it; `acted` is the strongest implicit one
// because it is the only measure of whether nudging actually works.
const EVIDENCE = {
  vote_up: 3,
  vote_down: -3,
  acted: 2,
  opened: 1,
  ignored: -1,
}

const DAY = 86_400_000

/**
 * Roll the feedback log up into per-fact-kind stats and multipliers.
 *
 * `rows` is the parsed JSONL. Pure — the clock comes in as `now` — so the decay
 * and the thresholds are testable without waiting ninety days.
 */
export function deriveWeights(rows = [], { now = Date.now(), halfLifeDays = HALF_LIFE_DAYS, categories = CATEGORIES } = {}) {
  const byKind = new Map()

  for (const row of rows) {
    // A reset is a tombstone, not a delete: the log stays append-only, and
    // everything before it for that kind simply stops counting. A reset with no
    // factKind clears the lot. This is what makes "put it back to neutral" a
    // one-click action that loses no history.
    if (row?.event === 'reset') {
      if (row.factKind) byKind.delete(row.factKind)
      else byKind.clear()
      continue
    }

    const kind = row?.factKind
    if (!kind) continue

    // Exponential decay on age, so a preference stated last week outweighs one
    // from six months ago without ever being erased.
    const ageDays = Math.max(0, (now - (row.ts || now)) / DAY)
    const recency = Math.pow(0.5, ageDays / halfLifeDays)

    const stats = byKind.get(kind) || {
      kind, category: row.category || null,
      up: 0, down: 0, opened: 0, ignored: 0, acted: 0, delivered: 0,
      score: 0, evidence: 0,
    }
    if (row.event === 'vote') stats[row.vote === 'up' ? 'up' : 'down'] += 1
    else if (row.event in stats) stats[row.event] += 1
    if (row.category) stats.category = row.category

    // A kind with only bookkeeping rows still gets an entry — the panel should be
    // able to say "sent 12 times, no opinion yet" — but contributes no score.
    const weight = evidenceValue(row)
    if (weight !== null) {
      stats.score += weight * recency
      stats.evidence += Math.abs(weight) * recency
    }
    byKind.set(kind, stats)
  }

  const weights = {}
  const detail = []
  for (const stats of byKind.values()) {
    const multiplier = multiplierFor(stats)
    weights[stats.kind] = multiplier
    detail.push({
      ...stats,
      score: round(stats.score),
      evidence: round(stats.evidence),
      multiplier,
      pinned: isPinned(stats.category || '', categories),
      // Said in words, because a number nobody can explain is a number nobody
      // trusts — and this one quietly decides what he stops hearing about.
      because: explain(stats, multiplier),
    })
  }
  detail.sort((a, b) => a.multiplier - b.multiplier || b.evidence - a.evidence)
  return { weights, detail, computedAt: now }
}

function evidenceValue(row) {
  if (row.event === 'vote') return row.vote === 'up' ? EVIDENCE.vote_up : row.vote === 'down' ? EVIDENCE.vote_down : null
  if (row.event === 'acted') return EVIDENCE.acted
  if (row.event === 'opened') return EVIDENCE.opened
  if (row.event === 'ignored') return EVIDENCE.ignored
  // `delivered` and `failed` are bookkeeping, not opinion.
  return null
}

// How much decayed score it takes to get most of the way to a bound. Deliberately
// several strong signals rather than one: four downvotes should visibly matter,
// and a single one should not.
const SATURATION = 12

function multiplierFor(stats) {
  if (stats.evidence < MIN_EVIDENCE) return 1
  // Saturating on the RAW score, not on score/evidence. A ratio normalises the
  // strength of the signal away — four "opened" and four explicit upvotes both
  // come out as +1 — which made a glance worth as much as an opinion.
  const pull = Math.tanh(stats.score / SATURATION)
  const multiplier = pull >= 0
    ? 1 + pull * (WEIGHT_CEILING - 1)
    : 1 + pull * (1 - WEIGHT_FLOOR)
  return round(Math.min(Math.max(multiplier, WEIGHT_FLOOR), WEIGHT_CEILING))
}

function explain(stats, multiplier) {
  if (stats.evidence < MIN_EVIDENCE) return 'Not enough feedback yet — neutral.'
  const bits = []
  if (stats.up) bits.push(`${stats.up} up`)
  if (stats.down) bits.push(`${stats.down} down`)
  if (stats.acted) bits.push(`${stats.acted} acted on`)
  if (stats.ignored) bits.push(`${stats.ignored} ignored`)
  const evidence = bits.join(', ') || 'mixed signals'
  if (multiplier <= WEIGHT_FLOOR) return `${evidence} — sent as rarely as it can be.`
  if (multiplier < 0.9) return `${evidence} — sent less often.`
  if (multiplier > 1.1) return `${evidence} — sent more readily.`
  return `${evidence} — no change.`
}

const round = (n) => Math.round(n * 100) / 100

/**
 * Mark delivered notifications that were never opened as ignored.
 *
 * Delivered-and-not-opened is a stronger negative than a dismissal — it means it
 * was seen on a lock screen and skipped — but it can only be known in hindsight,
 * so it is derived here rather than recorded at delivery. `graceMs` is how long a
 * notification has to be opened before it counts as ignored.
 */
export function ignoredSince(entries, { now = Date.now(), graceMs = 6 * 3_600_000 } = {}) {
  return entries.filter((e) => e.state === 'delivered'
    && e.deliveredAt
    && !e.openedAt
    && now - e.deliveredAt > graceMs
    && !e.ignoredCounted)
}

/**
 * The one line a digest can say about itself.
 *
 * A system that silently learns to stay quiet is indistinguishable from a broken
 * one, so crossing into "sent less often" is worth saying out loud once.
 */
export function weightChanges(before = {}, after = {}) {
  const changes = []
  for (const [kind, now] of Object.entries(after)) {
    const was = before[kind] ?? 1
    const crossedDown = was >= 0.9 && now < 0.9
    const crossedUp = was <= 1.1 && now > 1.1
    if (crossedDown) changes.push({ kind, direction: 'down', from: was, to: now })
    else if (crossedUp) changes.push({ kind, direction: 'up', from: was, to: now })
  }
  return changes
}
