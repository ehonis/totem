/**
 * The date-grounding block every prompt carries (AGENTS.md §5 "Date grounding"): the local
 * date and time, a 14-day table of weekday/date pairs, and the owner's away spans.
 *
 * The table is built from day keys (`todayKey` once, then `addDays`), never by adding 24
 * hours to an instant: on the night clocks spring forward, "now + 24 h" lands two local
 * days later and the table used to skip a day.
 */

import { addDays, todayKey } from '../goals/periods.mjs';
import { awayOn, clipLabel, describeSpan, relevantSpans, spanDays } from './days.mjs';

// A day key formatted as a calendar date. Noon UTC read back in UTC: no zone can move it.
const dayLabel = (key) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
}).format(new Date(`${key}T12:00:00Z`));

// The block goes into every prompt, the phone path included, so the away part is
// capped whatever the owner has entered: a few spans, short labels, the rest by tool.
const MAX_LISTED = 5;
const TABLE_LABEL = 30;
const LIST_LABEL = 40;

// Said even with nothing listed: a fresh install is exactly when a trip in an email is
// news, and the agent reading it needs to know the dates go to the owner first.
const PROPOSE_RULE =
  'If an email or the calendar shows the owner travelling or taking time off on dates not marked here, ' +
  'propose it with away__propose (totem_away_propose on Totem\'s MCP server); it is not settled until the owner accepts.';

export function dateGroundingBlock({ now = new Date(), tz, spans = [] } = {}) {
  const nowLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(now);
  const today = todayKey(now, tz);
  const upcoming = Array.from({ length: 14 }, (_, i) => {
    const key = addDays(today, i);
    const away = awayOn(spans, key);
    return `${dayLabel(key)} = ${key}${away ? ` (AWAY: ${clipLabel(away.label, TABLE_LABEL)})` : ''}`;
  }).join('; ');
  return (
    `LOCAL DATE CONTEXT: now is ${nowLabel} in ${tz}. ` +
    `Upcoming local dates: ${upcoming}. ` +
    'When the user uses a relative date like today, tomorrow, this Saturday, Saturday, this Thursday, next Thursday, next week, next week Thursday, or this weekend, resolve it to an explicit YYYY-MM-DD by looking it up in the table above (match the weekday name, then read off its ISO date). "Next <weekday>" means the soonest future occurrence of that weekday that is in the week after the current one. ' +
    'Before creating or moving any calendar event or dated task, verify the chosen weekday and ISO date are the same pair shown in the table. If they do not match, stop and correct the date before acting. ' +
    'When creating a Totem task, pass the resolved calendar date as dueDate "YYYY-MM-DD". Totem tasks are date-based; put a specific time in the description when it matters. Never pass a relative natural-language due string like "next thursday".' +
    awayParagraph(spans, today)
  );
}

function awayParagraph(spans, today) {
  const relevant = relevantSpans(spans, today);
  if (!relevant.length) return ` AWAY: none coming up. ${PROPOSE_RULE}`;
  const listed = relevant.slice(0, MAX_LISTED);
  const now = listed.filter((s) => s.start <= today);
  const later = listed.filter((s) => s.start > today);
  const parts = [];
  if (now.length) {
    parts.push(`Away today: ${now.map((s) => `${describeSpan(s, { maxLabel: LIST_LABEL })}, day ${spanDays(s, today)} of ${spanDays(s)}`).join('; ')}.`);
  }
  if (later.length) parts.push(`Coming up: ${later.map((s) => describeSpan(s, { maxLabel: LIST_LABEL })).join('; ')}.`);
  if (relevant.length > listed.length) parts.push(`+${relevant.length - listed.length} more (away__list).`);
  return (
    ` AWAY: ${parts.join(' ')} ` +
    'Do not schedule, set due dates or plan reminders on an AWAY day unless the owner names that day; if a requested date is one, say so first. ' +
    PROPOSE_RULE
  );
}
