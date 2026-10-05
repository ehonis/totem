// notify/digest.mjs — collect, rank, word, schedule.
//
// The digest job does not send a notification. It builds a *plan*: several
// notifications scheduled across the day at the times they can still change what
// the owner does. A morning collection routinely finds five true things, and five
// things in one push is a push nobody reads.
//
// The AI is in exactly one place — turning facts into sentences — and it is never
// on the critical path of a delivery. By the time an entry is due, its text has
// existed for hours. If the model is logged out, slow, or rate-limited, the
// deterministic wording the collectors already produced ships instead.
import { planDay } from './plan.mjs'
import { dayKey, normalizePlanSettings, dedupeKey as buildDedupeKey } from './schedule.mjs'

// Generous on purpose. This call happens at *plan* time — hours before the first
// notification is due — so the only thing a long budget costs is the digest job
// taking longer, and the only thing a short one costs is flatter wording. An
// agent CLI cold-starting a model does not answer in eight seconds.
const AI_BUDGET_MS = Number(process.env.DIGEST_AI_BUDGET_MS) || 90_000

export function createDigest({ collect, store, writeCopy = null, settings = () => ({}), log = () => {}, budgetMs = AI_BUDGET_MS, categories = undefined }) {
  // `writeCopy(facts)` returns [{title, body}] in the same order, or throws.
  // Injected rather than imported so the skill/provider plumbing stays in the
  // bridge and this file stays testable without an AI.

  return async function runDigest({ now = Date.now(), tz, source = 'daily-digest' } = {}) {
    const snapshot = await collect({ now })
    const facts = snapshot.facts || []
    if (!facts.length) {
      // A quiet day is a skipped run, not a push that says "nothing to report".
      return { status: 'skipped', output: 'nothing worth saying today', planned: 0 }
    }

    // The cap is a budget for the *day*, not for each run: the evening digest
    // replanning four more on top of the four the morning already sent is how a
    // notification budget quietly becomes twice what was asked for.
    const configured = normalizePlanSettings(settings())
    const today = dayKey(now, tz)
    const alreadySaid = (await store.listQueue({ limit: 500 }))
      .filter((e) => e.planDate === today && (e.state === 'delivered' || e.state === 'sending'))
    const sentToday = alreadySaid.length

    // Don't re-plan what has already gone out today. The evening run re-collects
    // the same facts the morning did, and without this the cap is spent planning
    // things he has already been told, which then get dropped at enqueue — a
    // wasted budget and an empty-looking evening.
    const saidKeys = new Set(alreadySaid.map((e) => e.dedupeKey).filter(Boolean))
    const unsaid = facts.filter((f) => {
      if (!f.subject) return true
      return !saidKeys.has(buildDedupeKey({
        category: f.category, factKind: f.kind, subject: f.subject, date: today,
      }))
    })

    const plan = planDay({
      facts: unsaid,
      now,
      tz,
      settings: { ...configured, cap: Math.max(0, configured.cap - sentToday) },
      weights: snapshot.weights || {},
      source,
      ...(categories ? { categories } : {}),
    })

    if (!plan.entries.length) {
      const why = sentToday >= configured.cap
        ? `${sentToday} already sent today, at the cap of ${configured.cap}`
        : (plan.dropped.map((d) => d.reason).join(', ') || 'nothing scheduled')
      return { status: 'skipped', output: `${facts.length} fact(s), none scheduled (${why})`, planned: 0 }
    }

    let voiced = 0
    if (writeCopy) {
      try {
        const copy = await withTimeout(writeCopy(plan.entries), budgetMs)
        applyCopy(plan.entries, copy, log)
        voiced = plan.entries.filter((e) => e.voiced).length
      } catch (e) {
        // Normal, tested path. The collectors' own wording is already correct
        // English; it is just flatter.
        log('digest copy fell back to templates', e?.message || e)
      }
    }

    const applied = await store.applyPlan(plan)
    return {
      status: 'ok',
      output: `${plan.entries.length} notification(s) planned${voiced ? `, ${voiced} in Totem's voice` : ' (template wording)'}`
        + `${plan.dropped.length ? `, ${plan.dropped.length} dropped` : ''}`,
      planned: plan.entries.length,
      dropped: plan.dropped.length,
      superseded: applied.superseded,
      plan,
    }
  }
}

// Per-entry, not all-or-nothing: one bad line falls back to its template while the
// rest keep the better wording.
function applyCopy(entries, copy, log) {
  if (!Array.isArray(copy) || copy.length !== entries.length) {
    throw new Error(`expected ${entries.length} line(s), got ${Array.isArray(copy) ? copy.length : typeof copy}`)
  }
  entries.forEach((entry, i) => {
    const line = copy[i]
    const title = typeof line?.title === 'string' ? line.title.trim() : ''
    if (!title) {
      log('digest line has no title, keeping template', i)
      return
    }
    // The structure assertion: every number and name in the original has to
    // survive. A model that drops the birthday, or rounds "3 of 4" to "nearly
    // done", loses its line rather than the fact.
    const rewritten = `${title} ${typeof line.body === 'string' ? line.body : ''}`
    if (!keepsFacts(entry, rewritten)) {
      log('digest line dropped a fact, keeping template', entry.factKind)
      return
    }
    entry.title = title.slice(0, 160)
    entry.body = (typeof line.body === 'string' ? line.body.trim() : '').slice(0, 600)
    entry.voiced = true
  })
}

// Every number and every capitalised name in the template has to appear in the
// rewrite. Deliberately crude: it catches the failure that matters (a fact
// silently disappearing) without trying to judge prose.
export function keepsFacts(entry, rewritten) {
  const original = `${entry.title} ${entry.body || ''}`
  const haystack = rewritten.toLowerCase()

  const numbers = original.match(/\d+(?:\.\d+)?/g) || []
  for (const n of numbers) {
    if (!haystack.includes(n.toLowerCase())) return false
  }
  // Names, as the collectors write them: a capitalised word that is not the first
  // word of a sentence and is not a unit.
  const names = original.match(/(?<![.!?]\s)(?<!^)\b[A-Z][a-z]{2,}\b/g) || []
  for (const name of names) {
    if (!haystack.includes(name.toLowerCase())) return false
  }
  return true
}

function withTimeout(promise, ms) {
  let timer
  // Not unref'd: the timer has to be able to fire. A hung provider with an
  // unref'd timeout means the budget never expires when nothing else is keeping
  // the loop alive, which is exactly the case this exists to survive.
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

// What the skill gets. Numbered so the model's line N maps to entry N, and
// stripped of everything it must not reason about (salience, slots, weights).
export function factsForPrompt(entries) {
  return entries.map((e, i) => `${i + 1}. ${e.title}${e.body ? ` — ${e.body}` : ''}`).join('\n')
}

// Tolerant of the three things a model reliably does wrong: a code fence, a
// leading "Here are the notifications:", and a JSON array instead of lines.
export function parseCopy(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/g, '').trim()
  try {
    const whole = JSON.parse(cleaned)
    if (Array.isArray(whole)) return whole
  } catch { /* not a single array; try line by line */ }

  const out = []
  for (const line of cleaned.split('\n')) {
    const trimmed = line.trim().replace(/^\d+[.)]\s*/, '')
    if (!trimmed.startsWith('{')) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch { /* a stray brace line; skip it rather than losing the run */ }
  }
  return out
}
