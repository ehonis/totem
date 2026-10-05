// notify/revalidate.mjs — is this still true, seconds before it is sent?
//
// A plan is built in the morning and fires through the day. Between the two, the
// habit gets logged, the task gets done, the ride happens. Sending the nudge
// anyway is the single most obvious way for Totem to look broken, so every
// planned entry is re-checked at the moment of delivery.
//
// Four verdicts, and the last two are the ones that earn this file:
//
//   fresh    — the fact still holds, numbers and all. Send what was planned.
//   changed  — the same fact, different numbers. Send the *current* sentence.
//   stale    — it no longer holds, and there is nothing nice to say. Silence.
//   resolved — it no longer holds *because he did the thing*. Send the other copy,
//              once: "done for the week — 4 of 4".
//
// `changed` exists because of a real notification: "50 Miles Biked — at 73%,
// 3 days left", planned at 07:15 for 18:00, after a ride that had already taken it
// past 73%. The percentage was baked into the text at plan time and nothing
// re-read it. Dropping it would have been wrong too — he was closer, not finished.
// So an entry now carries two keys: an IDENTITY ("the near-complete nudge for this
// goal"), which is what makes it the same notification, and a FACT KEY, which
// carries the numbers. Identity matches and fact key doesn't → re-render from the
// fresh fact and send that.
//
// Note what gets thrown away in that case: the AI's wording. The rewrite was
// written at plan time against the old number and cannot be trusted to describe
// the new one, and the model is deliberately not on the delivery path. The
// collector's own sentence is flatter and correct, and correct wins.
//
// Failing closed is deliberate. Anything this cannot verify is treated as stale,
// because a notification that could not be checked is exactly the one not worth
// the trust it spends.
const dateKeyUtc = (ms) => new Date(ms).toISOString().slice(0, 10)

// The prefix both keys share ("weekly:3-year-journal:4" → "weekly") is the shape
// of the fact. The id is `entry.subject`, never parsed back out of the key —
// that's what lets a key gain a number without breaking a resolver.
const shapeOf = (rev) => String(rev?.identity || rev?.factKey || '').split(':')[0]

export function createRevalidator({ collect, log = () => {} }) {
  // One collection per drain, not one per entry: a tick with four due entries
  // should read the habits file once.
  return async function revalidateBatch({ at = Date.now() } = {}) {
    let snapshot
    try {
      snapshot = await collect({ now: at })
    } catch (e) {
      log('revalidation snapshot failed', e?.message || e)
      // Fail closed: nothing gets sent this tick rather than everything getting
      // sent unverified.
      return async () => ({ state: 'stale' })
    }

    const byFactKey = new Set()
    const byIdentity = new Map()
    for (const fact of snapshot.facts || []) {
      if (fact.revalidate?.factKey) byFactKey.add(fact.revalidate.factKey)
      // First one wins: two facts sharing an identity would be a collector bug,
      // and silently preferring the last is the harder version to notice.
      if (fact.revalidate?.identity && !byIdentity.has(fact.revalidate.identity)) {
        byIdentity.set(fact.revalidate.identity, fact)
      }
    }

    return async function revalidate(entry) {
      const rev = entry.revalidate
      // An entry with no revalidation key was never a derived fact — an ad-hoc
      // reminder, a job failure, an approval code. Those are always still true.
      if (!rev?.factKey) return { state: 'fresh' }
      if (byFactKey.has(rev.factKey)) return { state: 'fresh' }

      // Same notification, different numbers. See the header.
      //
      // The fallback is for entries planned before identities existed and still
      // sitting in the queue at restart: their fact key is what the identity is
      // now, so a goal nudge queued this morning re-renders correctly instead of
      // falling through to a resolver that cannot check it.
      const moved = byIdentity.get(rev.identity || rev.factKey) || null
      if (moved) {
        return { state: 'changed', title: moved.title, body: moved.body || '', url: moved.url || null }
      }

      const resolver = RESOLVERS[rev.collector]
      if (!resolver) return { state: 'stale' }
      try {
        return resolver(entry, snapshot) || { state: 'stale' }
      } catch (e) {
        log('resolver threw', rev.collector, e?.message || e)
        return { state: 'stale' }
      }
    }
  }
}

// Each resolver answers one question: the fact stopped being true entirely — was
// that because he did it? Anything less certain than "yes" is stale. Note how
// little is left in them now: a fact whose numbers merely moved never reaches
// here, so these only have to recognise a finish.
const RESOLVERS = {
  habits(entry, { habits = [], entries = {}, now }) {
    const shape = shapeOf(entry.revalidate)
    const id = entry.subject

    // daily — the streak nudge. Resolved once it is logged.
    if (shape === 'daily') {
      const date = String(entry.revalidate.factKey).split(':').pop()
      // A stale date means the plan outlived its day; that is expiry, not a win.
      if (date !== dateKeyUtc(now)) return { state: 'stale' }
      const count = Number(entries?.[date]?.[id]?.count || 0)
      return count > 0 ? { state: 'resolved', body: 'Logged — streak intact.' } : { state: 'stale' }
    }

    // weekly — the "one more to finish" nudge.
    if (shape === 'weekly' || shape === 'weekly-behind') {
      const habit = habits.find((h) => h.id === id)
      if (!habit) return { state: 'stale' }
      const target = Math.max(1, Number(habit.target) || 1)
      const count = weekCount(entries, id, now)
      // Hit the target: that is the win this nudge existed to produce.
      if (count >= target) return { state: 'resolved', body: `${count} of ${target} for the week.` }
      return { state: 'stale' }
    }

    return { state: 'stale' }
  },

  tasks(entry, { tasks = null, now }) {
    if (!tasks) return { state: 'stale' }
    const today = dateKeyUtc(now)
    const due = tasks.filter((t) => t.dueDate === today
      && t.status !== 'done' && !t.completedAt && !t.archivedAt && !t.deletedAt)
    if (shapeOf(entry.revalidate) === 'due') {
      return due.length === 0
        ? { state: 'resolved', body: 'Everything due today is done.' }
        : { state: 'stale' }
    }
    return { state: 'stale' }
  },

  goals(entry, { goals = null }) {
    if (!goals) return { state: 'stale' }
    // No subject, no way to check — and "I could not check" must never become
    // "finished". An entry queued before the store persisted subjects lands here.
    if (!entry.subject) return { state: 'stale' }
    const goal = goals.find((g) => g.id === entry.subject)
    // Gone from this week's list, or explicitly complete: either way it is done.
    if (!goal || goal.complete) return { state: 'resolved', body: 'Finished.' }
    return { state: 'stale' }
  },

  // A birthday does not stop being true. A metric trend that changed is caught by
  // the identity check above and re-rendered; one that vanished entirely has no
  // "well done" to send.
  birthdays: () => ({ state: 'fresh' }),
  metrics: () => ({ state: 'stale' }),

  // Quota is nothing but a number, so every real change is a `changed`. Reaching
  // here means the meter stopped being worth mentioning — the window reset, or the
  // burn came back down. Both are good news nobody needs a push about.
  usage: () => ({ state: 'stale' }),
}

function weekCount(entries, habitId, now) {
  const d = new Date(now)
  const weekday = d.getUTCDay()
  const todayUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  let count = 0
  for (let i = 0; i <= weekday; i++) {
    count += Math.max(0, Number(entries?.[dateKeyUtc(todayUtc - (weekday - i) * 86_400_000)]?.[habitId]?.count || 0))
  }
  return count
}
