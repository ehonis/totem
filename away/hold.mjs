/**
 * Which queued notifications wait out an away day, and when they come back.
 *
 * Whether a category waits is its `away` column in notify/categories.mjs, stated per row:
 * 'send' for what the owner needs wherever they are (reminders they set, calendar alerts,
 * approvals, chat answers, birthdays, job failures, outside alerts, a machine going
 * offline), 'hold' for nudges (digests, goals, news, usage). An entry queued with
 * `quietHours: 'override'` is urgent whatever its category says. A category with no
 * `away` column is sent: a notification that is never held can be ignored, one wrongly
 * held is silently missing.
 *
 * The bridge registers `createAwayHold` with the dedupe gate (`gate.addHold`, notify/
 * dedupe.mjs). A held entry goes back to pending until the next local morning, when quiet
 * hours end, tagged `heldBy: 'away'`; the gate asks again then. So each day of a trip the
 * entry is held one more night, the first morning the owner is back it goes out, and a
 * span deleted or cut short frees what it held the next morning. The drain applies no
 * quiet hours of its own, so releasing at midnight would wake the phone. A tagged entry
 * also skips the queue's missed-delivery cutoff (notify/store.mjs): an outage at 07:00
 * must not lose a week's backlog. Its own `expiresAt` still bounds it.
 *
 * On the way back `releasedAfterAway` thins the backlog without losing anything distinct:
 * of the digests it keeps only the newest of each kind (a digest restates the day, so the
 * last one covers the rest), and of anything else only exact repeats (the same
 * `dedupeKey`). Two different goal nudges, two usage warnings or two stories all arrive.
 */

import { addDays, todayKey } from '../goals/periods.mjs';
import { zonedToUtc } from '../jobs/schedule.mjs';
import { categoryDef } from '../notify/categories.mjs';
import { awayOn } from './days.mjs';

export const HELD_BY = 'away';

export function isUrgent(entry) {
  if (entry?.quietHours === 'override') return true;
  return categoryDef(entry?.category).away !== 'hold';
}

export function heldWhileAway(entry, { spans, at = Date.now(), tz }) {
  if (!entry || isUrgent(entry)) return false;
  return Boolean(awayOn(spans, todayKey(new Date(at), tz)));
}

/** The next local morning after `at`: quiet hours' end (or 00:00) on the following day. */
export function nextMorning(at, tz, quietHours = null) {
  const day = addDays(todayKey(new Date(at), tz), 1);
  const [hour, minute] = (quietHours?.end || '00:00').split(':').map(Number);
  return zonedToUtc({ year: +day.slice(0, 4), month: +day.slice(5, 7), day: +day.slice(8, 10), hour, minute }, tz);
}

/** The gate's hold hook: `{ until, tag }` for a nudge on an away day, null otherwise. */
export function createAwayHold({ spans, tz, quietHours = null, now = () => Date.now() }) {
  return (entry, at = now()) => {
    if (!heldWhileAway(entry, { spans: spans(), at, tz })) return null;
    return { until: nextMorning(at, tz, quietHours), tag: HELD_BY };
  };
}

// What makes two held entries the same notification. Digests are one per slot and the
// newest supersedes the rest; anything else only by its exact dedupe key.
const sameAs = (e) => (String(e.category || '').startsWith('digest.') ? `category:${e.category}` : e.dedupeKey ? `key:${e.dedupeKey}` : null);

/**
 * Ids of released entries to finish unsent: of the entries held over an absence and due
 * now, the older copies of the same notification. Nothing distinct is dropped.
 */
export function releasedAfterAway(entries, { at = Date.now() } = {}) {
  const groups = new Map();
  for (const e of entries || []) {
    if (e.state !== 'pending' || e.heldBy !== HELD_BY || e.deliverAt > at) continue;
    const key = sameAs(e);
    if (key) groups.set(key, [...(groups.get(key) || []), e]);
  }
  const drop = [];
  for (const list of groups.values()) {
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    drop.push(...list.slice(1).map((e) => e.id));
  }
  return drop;
}
