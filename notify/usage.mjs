// notify/usage.mjs — the quota meters, turned into the handful of things worth
// interrupting for.
//
// A collector like the ones in notify/signals.mjs, kept separate because its
// source is different: not the owner's own files but the vendors' rate-limit windows,
// as the ai-usage poller last read them. Pure over what it is handed — the caller
// passes `aiUsage.snapshot.accounts`, so nothing here waits on a network call.
//
// THE RULE THAT SHAPES THIS FILE: only raise a nudge whose truth outlives the gap
// between planning it and sending it. A digest plans at 07:15 and delivers at
// 15:30, and "your 5-hour window is at 82%" is not a fact with that shelf life —
// by 15:30 the window has reset and the sentence is a lie about a number nobody
// can check. So short windows raise only the one thing that stays true until they
// reset (they are spent), and everything with a pace or a trend in it is limited
// to windows measured in days.
//
// Everything here also carries an identity, so a percentage that moves between the
// plan and the push is re-worded at delivery rather than sent stale. See
// notify/revalidate.mjs.
import { localParts } from '../jobs/schedule.mjs'
import { dayKey, endOfDay } from './schedule.mjs'
import { fitTitle, bodyOf } from './text.mjs'

const MINUTE = 60_000
const DAY_MINUTES = 24 * 60

export const USAGE_DEFAULTS = {
  // Past this, the rest of the window is worth planning around.
  lowPct: 80,
  // Spent. Not 100 — vendors report 99.7 and call it done.
  spentPct: 99,
  // How far ahead of an even burn counts as "fast". 1.0 is exactly on pace for
  // the window to run out at the moment it resets, which is what a plan bought to
  // be used looks like; 1.6 is spending it half again as fast as that.
  burnRatio: 1.6,
  // Below this with the window nearly over, the subscription went unspent.
  idlePct: 30,
  // The window has to be long enough that a pace means something.
  minBurnHoursLeft: 12,
}

// A window shorter than a day is weather. See the header.
const isSlowWindow = (meter) => Number(meter.windowMinutes) >= DAY_MINUTES

export function usageFacts({
  accounts = [],
  now = Date.now(),
  tz,
  // `${backend}:${label}` is a profile directory name, which is a terrible thing
  // to read on a lock screen. The bridge passes the configured display name.
  nameOf = (account) => account.label || account.backend,
  options = {},
} = {}) {
  const cfg = { ...USAGE_DEFAULTS, ...options }
  const out = []

  for (const account of accounts) {
    // An account that could not be read has no numbers to be low. The Settings
    // panel is where a broken login belongs; a push about one is a push about
    // something he cannot act on from a lock screen.
    if (account.status && account.status !== 'ok') continue
    const who = nameOf(account)

    for (const meter of account.meters || []) {
      const used = Number(meter.usedPct)
      if (!Number.isFinite(used)) continue
      // Cursor's unlimited plans report percentages that cap nothing.
      if (meter.unlimited || account.unlimited) continue

      const label = meter.label || 'limit'
      const subject = `${account.id}:${meter.key}`
      const base = {
        subject,
        url: '/settings/providers#usage',
        // Every fact here is a statement about a number, so the number is in the
        // fact key and the identity is not.
        identityFor: (kind) => `usage:${subject}:${kind}`,
      }
      const resets = Number(meter.resetsAt) || null
      const resetsIn = resets ? resets - now : null
      const when = resetPhrase(resets, now, tz)

      // 1. Spent. True until the window resets, whatever the window's length, so
      //    this is the only thing a five-hour window may say.
      if (used >= cfg.spentPct) {
        out.push({
          kind: 'usage.spent',
          category: 'usage.blocked',
          salience: 80,
          slot: 'midday',
          subject,
          title: fitTitle('Quota spent', `${who} ${label}`),
          body: bodyOf(`${who}: the ${label.toLowerCase()} is used up${when ? `, ${when}` : ''}.`),
          url: base.url,
          // The moment it resets this stops being true, and a "you're out" that
          // arrives after the refill is the exact failure this file avoids.
          expiresAt: resets || endOfDay(now, tz),
          revalidate: { collector: 'usage', identity: base.identityFor('spent'), factKey: `${base.identityFor('spent')}:${Math.round(used)}` },
        })
        continue
      }

      if (!isSlowWindow(meter)) continue

      // 2. Running low, with the window still open. The most useful of the four.
      if (used >= cfg.lowPct) {
        out.push({
          kind: 'usage.low',
          category: 'usage.limit',
          salience: 55 + Math.min(Math.round(used - cfg.lowPct), 20),
          slot: 'afternoon',
          subject,
          title: fitTitle('Quota running low', `${who} ${Math.round(used)}%`),
          body: bodyOf(`${who}: ${Math.round(100 - used)}% of the ${label.toLowerCase()} left${when ? `, and it ${when}` : ''}.`),
          url: base.url,
          expiresAt: resets || endOfDay(now, tz),
          revalidate: { collector: 'usage', identity: base.identityFor('low'), factKey: `${base.identityFor('low')}:${Math.round(used)}` },
        })
        continue
      }

      // 3. Burning faster than the window can carry. Only while there is enough
      //    left to do something about it — past that it is just a countdown.
      const pace = paceRatio(meter, used, now)
      if (
        pace !== null
        && pace >= cfg.burnRatio
        && used >= 35
        && resetsIn !== null
        && resetsIn >= cfg.minBurnHoursLeft * 60 * MINUTE
      ) {
        out.push({
          kind: 'usage.burning',
          category: 'usage.limit',
          salience: 45 + Math.min(Math.round((pace - cfg.burnRatio) * 10), 15),
          slot: 'afternoon',
          subject,
          title: fitTitle('Quota going fast', who),
          body: bodyOf(
            `${who}: ${Math.round(used)}% of the ${label.toLowerCase()} gone with ${describeSpan(resetsIn)} to run`,
            `— about ${pace.toFixed(1)}× an even pace.`,
          ),
          url: base.url,
          expiresAt: endOfDay(now, tz),
          revalidate: { collector: 'usage', identity: base.identityFor('burning'), factKey: `${base.identityFor('burning')}:${Math.round(used)}` },
        })
        continue
      }

      // 4. Paid for and barely touched, with the window about to roll. Said once,
      //    near the end, because it is only true at the end.
      if (
        used <= cfg.idlePct
        && resetsIn !== null
        && resetsIn > 0
        && resetsIn <= 36 * 60 * MINUTE
        && Number(meter.windowMinutes) >= 3 * DAY_MINUTES
      ) {
        out.push({
          kind: 'usage.idle',
          category: 'usage.idle',
          salience: 30,
          slot: 'evening',
          subject,
          title: fitTitle('Quota going unused', who),
          body: bodyOf(`${who}: the ${label.toLowerCase()} ${when || 'resets soon'} and you have used ${Math.round(used)}% of it.`),
          url: base.url,
          expiresAt: resets,
          revalidate: { collector: 'usage', identity: base.identityFor('idle'), factKey: `${base.identityFor('idle')}:${Math.round(used)}` },
        })
      }
    }
  }

  return out
}

// How far ahead of an even burn this window is. 1.0 means the quota is being
// spent at exactly the rate that empties it as it resets. Null when the window's
// length or reset time is unknown, or so early in the window that the ratio is
// arithmetic noise rather than a trend.
export function paceRatio(meter, used, now) {
  const windowMs = Number(meter.windowMinutes) * MINUTE
  const resets = Number(meter.resetsAt)
  if (!Number.isFinite(windowMs) || windowMs <= 0 || !Number.isFinite(resets)) return null
  const elapsed = windowMs - (resets - now)
  if (elapsed <= 0) return null
  const fraction = elapsed / windowMs
  // The first tenth of a window makes every ratio enormous: one busy hour on a
  // Monday morning is not a week's trend.
  if (fraction < 0.1 || fraction >= 1) return null
  return (used / 100) / fraction
}

// "resets at 3 PM" / "resets Friday" / "resets in 40 minutes". Deliberately short:
// it is the tail of a body line, not a sentence of its own.
export function resetPhrase(resetsAt, now, tz) {
  if (!Number.isFinite(resetsAt) || resetsAt <= now) return ''
  const ms = resetsAt - now
  if (ms < 90 * MINUTE) return `resets in ${Math.max(1, Math.round(ms / MINUTE))} minutes`
  const p = localParts(resetsAt, tz)
  const hour = p.hour % 12 === 0 ? 12 : p.hour % 12
  const clock = `${hour}${p.minute ? `:${String(p.minute).padStart(2, '0')}` : ''} ${p.hour < 12 ? 'AM' : 'PM'}`
  if (dayKey(resetsAt, tz) === dayKey(now, tz)) return `resets at ${clock}`
  if (ms < 7 * 24 * 60 * MINUTE) return `resets ${WEEKDAYS[p.weekday]} at ${clock}`
  return `resets ${dayKey(resetsAt, tz)}`
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function describeSpan(ms) {
  const hours = Math.round(ms / (60 * MINUTE))
  if (hours < 36) return `${hours} hours`
  return `${Math.round(hours / 24)} days`
}
