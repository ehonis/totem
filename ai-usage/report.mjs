/**
 * AI subscription usage, read for agents: the live meters, the recorded history,
 * and how often each account hit a cap. Pure functions over the poller's snapshot
 * (ai-usage/poller.mjs) and CLIProxy's normalised history (cliproxy/history.mjs);
 * ai-usage/mcp.mjs serves them as totem_usage_* on /mcp and usage__* in the gateway.
 *
 * A limit hit is one window period that reached SPENT_PCT, however many readings
 * it took there. A period is one window between resets: readings that name the
 * same reset time, or, where the reading carries none, that follow on without the
 * usage dropping. Blocked time runs from the first reading at the cap to that
 * window's reset, so it never counts time before the cap was seen. A missing
 * reading is "no data", never 0%.
 */

import { SPENT_PCT, LOW_LEFT_PCT, isScopedMeter } from './pools.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const HISTORY_MAX_DAYS = 21;
/** A stretch this long with no reading from an account is reported as a gap. */
export const GAP_HOURS = 6;
/** Most recent hits listed per window; the counts always cover all of them. */
const HITS_LISTED = 25;

const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };

// What CLIProxy records per provider (cliproxy/history.mjs). `all` windows cap the
// whole account; `model` ones cap one model (Fable's weekly allowance).
const WINDOWS = {
  claude: {
    five_hour: { label: '5-hour', minutes: 300, scope: 'all' },
    seven_day: { label: 'weekly', minutes: 10080, scope: 'all' },
    seven_day_fable: { label: 'weekly Fable', minutes: 10080, scope: 'model' },
  },
  codex: {
    primary: { label: '5-hour', minutes: 300, scope: 'all' },
    secondary: { label: 'weekly', minutes: 10080, scope: 'all' },
    weekly: { label: 'weekly', minutes: 10080, scope: 'all' },
  },
};
/** The window whose spend stands for "activity" in the busiest days and hours. */
const SHORT_WINDOW = { claude: 'five_hour', codex: 'primary' };

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const round1 = (n) => Math.round(n * 10) / 10;
const hours = (ms) => round1(ms / HOUR);

/** A reset time in ms. A value that can only be seconds is scaled up. */
export function resetMs(v) {
  if (!finite(v) || v <= 0) return null;
  return v < 1e11 ? v * 1000 : v;
}

export function providerLabel(provider, names = {}) {
  return (typeof names?.[provider] === 'string' && names[provider].trim()) || PROVIDER_NAMES[provider] || String(provider || 'unknown');
}

function minutesLabel(minutes) {
  if (minutes % 10080 === 0) return minutes === 10080 ? 'weekly' : `${minutes / 1440}-day`;
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

export function windowInfo(provider, id, minutes = null) {
  const known = WINDOWS[provider]?.[id];
  const length = finite(minutes) && minutes > 0 ? minutes : known?.minutes ?? null;
  const label = known?.scope === 'model'
    ? known.label
    : finite(minutes) && minutes > 0 ? minutesLabel(minutes) : known?.label ?? id;
  return { label, minutes: length, scope: known?.scope ?? 'all' };
}

// ---- Local time ---------------------------------------------------------------

const formatters = new Map();
function formatter(tz) {
  const zone = tz || 'UTC';
  if (!formatters.has(zone)) {
    try {
      formatters.set(zone, new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
      }));
    } catch {
      formatters.set(zone, formatter('UTC'));
    }
  }
  return formatters.get(zone);
}

export function localParts(ms, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: p.minute, weekday: p.weekday };
}

/** "2026-11-10 14:30" in the owner's time zone, or null. */
export function localStamp(ms, tz) {
  if (!finite(ms)) return null;
  const p = localParts(ms, tz);
  return `${p.date} ${String(p.hour).padStart(2, '0')}:${p.minute}`;
}

// ---- Live meters --------------------------------------------------------------

function meterStatus(meter, account) {
  if (!finite(meter.usedPct)) return 'no data';
  if (meter.usedPct >= SPENT_PCT && !meter.unlimited && !account.unlimited) return 'spent';
  const left = finite(meter.remainingPct) ? meter.remainingPct : 100 - meter.usedPct;
  return left < LOW_LEFT_PCT ? 'low' : 'ok';
}

const clip = (text, max = 200) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/**
 * Every account the poller shows, its meters and their status. Only names, plans
 * and numbers: the snapshot's credential paths, urls and raw headers stay behind.
 */
export function summarizeCurrent(snapshot, { tz, now = Date.now(), provider = null, redact = (s) => s } = {}) {
  const names = snapshot?.providers || {};
  const stamp = (ms) => localStamp(ms, tz);
  const accounts = (snapshot?.accounts || [])
    .filter((a) => !provider || a.backend === provider)
    .map((a) => {
      const meters = (a.meters || []).map((m) => ({
        key: String(m.key ?? ''),
        label: String(m.label ?? m.key ?? ''),
        scope: isScopedMeter(m) ? 'model' : 'all',
        usedPct: finite(m.usedPct) ? m.usedPct : null,
        remainingPct: finite(m.usedPct) ? (finite(m.remainingPct) ? m.remainingPct : round1(100 - m.usedPct)) : null,
        resetsAt: stamp(resetMs(m.resetsAt)),
        status: meterStatus(m, a),
      }));
      const spent = meters.filter((m) => m.status === 'spent');
      const name = String(a.displayName || a.label || a.id);
      const providerName = providerLabel(a.backend, names);
      let summary;
      if (a.state === 'disabled') summary = `${providerName} (${name}): switched off in the proxy.`;
      else if (a.state === 'error') summary = `${providerName} (${name}): could not be read${a.error ? ` (${clip(redact(a.error), 120)})` : ''}.`;
      else if (a.state === 'limited') {
        summary = `${providerName} (${name}): limited${spent.length ? ` (${spent.map((m) => m.label).join(', ')} spent)` : ''}`
          + `${finite(a.limitedUntil) ? ` until ${stamp(a.limitedUntil)}` : ''}.`;
      } else {
        summary = `${providerName} (${name}): ${finite(a.headroomPct) ? `${a.headroomPct}% left in its tightest window` : 'no reading yet'}`
          + `${a.state === 'low' ? ' (low)' : ''}.`;
      }
      return {
        id: String(a.id),
        provider: a.backend,
        providerName,
        name,
        plan: a.plan ? String(a.plan) : null,
        source: a.source === 'cliproxy' ? 'cliproxy' : 'local',
        state: a.state ?? null,
        headroomPct: finite(a.headroomPct) ? a.headroomPct : null,
        limitedUntil: stamp(a.limitedUntil),
        stale: Boolean(a.stale),
        error: a.error ? clip(redact(a.error)) : null,
        readAt: stamp(a.fetchedAt),
        meters,
        summary,
      };
    });
  const pools = (snapshot?.pools || [])
    .filter((p) => !provider || p.backend === provider)
    .map((p) => ({
      provider: p.backend,
      providerName: providerLabel(p.backend, names),
      accounts: p.total,
      usable: p.usable,
      limited: p.limited,
      errors: p.errors,
      disabled: p.disabled,
      bestHeadroomPct: finite(p.headroomPct) ? p.headroomPct : null,
      nextBackAt: stamp(p.nextBackAt),
    }));
  return {
    timeZone: tz || 'UTC',
    now: stamp(now),
    updatedAt: stamp(snapshot?.updatedAt),
    firstPollPending: Boolean(snapshot?.polling) && !accounts.length,
    thresholds: { spentPct: SPENT_PCT, lowLeftPct: LOW_LEFT_PCT },
    proxy: { configured: Boolean(snapshot?.proxy?.configured), reachable: snapshot?.proxy?.reachable ?? null },
    accounts,
    pools,
  };
}

// ---- History ------------------------------------------------------------------

export function clampDays(days, fallback) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(HISTORY_MAX_DAYS, Math.max(1 / 24, n));
}

/** The samples of one range, provider and account, oldest first. */
export function selectSamples(samples, { from, to, provider = null, accountId = null }) {
  return (samples || [])
    .filter((s) => s && finite(s.t) && s.t >= from && s.t <= to)
    .filter((s) => (!provider || s.provider === provider) && (!accountId || s.accountId === accountId))
    .sort((a, b) => a.t - b.t);
}

function byAccount(samples) {
  const out = new Map();
  for (const s of samples) {
    if (!out.has(s.accountId)) out.set(s.accountId, []);
    out.get(s.accountId).push(s);
  }
  return out;
}

function accountName(id, names) {
  const known = names.get(id);
  if (known) return known;
  return String(id).replace(/^[a-z]+:proxy:/, '');
}

/**
 * Readings per account, bucketed so the answer stays small: each bucket keeps the
 * highest reading of each window in it (a cap is what matters, so the peak is kept).
 */
export function downsampleHistory(samples, { from, to, tz, names = new Map(), maxPoints = 400 }) {
  const groups = byAccount(samples);
  const perAccount = Math.max(24, Math.floor(maxPoints / Math.max(1, groups.size)));
  const step = 15 * MINUTE;
  const bucketMs = Math.max(step, Math.ceil((to - from) / perAccount / step) * step);
  const accounts = [];
  for (const [accountId, list] of groups) {
    const provider = list[0].provider;
    const windows = {};
    const buckets = new Map();
    for (const s of list) {
      const key = Math.floor((s.t - from) / bucketMs);
      const bucket = buckets.get(key) || {};
      for (const [id, w] of Object.entries(s.windows || {})) {
        if (!finite(w?.used)) continue;
        windows[id] ||= windowInfo(provider, id, w.windowMinutes);
        bucket[id] = Math.max(bucket[id] ?? -1, w.used);
      }
      buckets.set(key, bucket);
    }
    const points = [...buckets.entries()].sort((a, b) => a[0] - b[0])
      .map(([key, peaks]) => ({ at: localStamp(from + key * bucketMs, tz), ...peaks }));
    accounts.push({
      accountId,
      provider,
      providerName: providerLabel(provider),
      name: accountName(accountId, names),
      windows,
      readings: list.length,
      firstReading: localStamp(list[0].t, tz),
      lastReading: localStamp(list[list.length - 1].t, tz),
      points,
    });
  }
  return { bucketMinutes: bucketMs / MINUTE, accounts };
}

// ---- Limit hits -----------------------------------------------------------------

function seriesOf(samples, id) {
  const out = [];
  for (const s of samples) {
    const w = s.windows?.[id];
    if (!w || !finite(w.used)) continue;
    out.push({ t: s.t, used: w.used, reset: resetMs(w.resetAtMs), minutes: finite(w.windowMinutes) ? w.windowMinutes : null });
  }
  return out;
}

const DROP = 5; // a fall bigger than this, with no reset time to go by, is a new window

function samePeriod(cur, s, windowMs) {
  const tolerance = Math.min(15 * MINUTE, windowMs / 10);
  const fell = s.used < cur.last.used - DROP;
  if (cur.reset && s.reset) return Math.abs(cur.reset - s.reset) <= tolerance;
  if (cur.reset) return s.t < cur.reset && !fell;
  if (s.reset) return !fell && s.reset - windowMs <= cur.first.t + tolerance;
  return !fell && s.t - cur.first.t < windowMs;
}

/** One window's readings, split into periods between resets. */
export function windowPeriods(series, windowMs) {
  const periods = [];
  let cur = null;
  for (const s of series) {
    // A reading taken after its own window's reset describes a window already over.
    if (s.reset && s.t >= s.reset) continue;
    if (cur && samePeriod(cur, s, windowMs)) {
      cur.samples.push(s);
      cur.last = s;
      cur.reset ||= s.reset;
    } else {
      cur = { first: s, last: s, reset: s.reset, samples: [s] };
      periods.push(cur);
    }
  }
  return periods;
}

/** A period's highest reading. A period that never rose above 0% was never used. */
export const peakOf = (p) => Math.max(...p.samples.map((s) => s.used));

/**
 * The hits in one window's periods. A hit's blocked time runs from its first
 * reading at the cap to the window's reset (clipped to `end`); with no reset time
 * known it runs to the last reading at the cap, which is a lower bound. A window
 * the next one replaced before its reset (a reset credit or grant) ends at its
 * last reading, also a lower bound.
 */
export function windowHits(periods, { end }) {
  const hits = [];
  for (const [i, p] of periods.entries()) {
    const capped = p.samples.filter((s) => s.used >= SPENT_PCT);
    if (!capped.length) continue;
    const start = capped[0].t;
    const next = periods[i + 1];
    const endedEarly = Boolean(p.reset && next && next.first.t < p.reset);
    const until = endedEarly ? p.last.t : p.reset ?? capped[capped.length - 1].t;
    const stop = Math.min(until, end);
    hits.push({
      start,
      until,
      resetKnown: Boolean(p.reset) && !endedEarly,
      endedEarly,
      ongoing: until > end,
      blockedMs: Math.max(0, stop - start),
      interval: [start, Math.max(start, stop)],
    });
  }
  return hits;
}

/** Merge [start, end] intervals; the total is each moment counted once. */
export function unionIntervals(intervals) {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const total = (intervals) => intervals.reduce((sum, [a, b]) => sum + (b - a), 0);

function covered(intervals, t) {
  return intervals.some(([a, b]) => t >= a && t < b);
}

/**
 * Time when every account of a provider that had started reporting was blocked
 * at once: the hours the provider could serve nothing.
 */
export function allBlockedIntervals(accounts) {
  if (!accounts.length) return [];
  const edges = new Set();
  for (const a of accounts) {
    edges.add(a.since);
    for (const [s, e] of a.blocked) { edges.add(s); edges.add(e); }
  }
  const points = [...edges].sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const mid = a + (b - a) / 2;
    const present = accounts.filter((x) => x.since <= mid);
    if (present.length && present.every((x) => covered(x.blocked, mid))) out.push([a, b]);
  }
  return unionIntervals(out);
}

// Stretches with no reading between the first reading and the end of the range.
// Before the first reading the account simply has no history yet (coverage says so).
function gapsOf(list, to, gapMs) {
  const gaps = [];
  let prev = list[0].t;
  for (const s of list) {
    if (s.t - prev > gapMs) gaps.push([prev, s.t]);
    prev = s.t;
  }
  if (to - prev > gapMs) gaps.push([prev, to]);
  return gaps;
}

function times(n) {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`;
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const dayCount = (n) => plural(n, 'day');

/** Points of the short window spent, by local day and hour of day. */
function activity(list, provider, tz) {
  const id = SHORT_WINDOW[provider];
  const days = new Map();
  const hoursOfDay = new Map();
  if (!id) return { days, hoursOfDay };
  const series = seriesOf(list, id);
  const info = windowInfo(provider, id, series.find((s) => s.minutes)?.minutes);
  for (const p of windowPeriods(series, (info.minutes || 300) * MINUTE)) {
    let before = 0;
    for (const s of p.samples) {
      const spent = Math.max(0, s.used - before);
      before = Math.max(before, s.used);
      if (!spent) continue;
      const { date, hour } = localParts(s.t, tz);
      days.set(date, (days.get(date) || 0) + spent);
      hoursOfDay.set(hour, (hoursOfDay.get(hour) || 0) + spent);
    }
  }
  return { days, hoursOfDay, window: info.label };
}

const top = (map, n, key) => [...map.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n)
  .map(([k, v]) => ({ [key]: k, pointsSpent: Math.round(v) }));

const hourLabel = (h) => `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`;

/**
 * The limit report: per account and window, how often the cap was reached, for
 * how long, and when; per provider, how long every account was capped at once.
 * `known` is every account the live poller shows, so those with no history can
 * be named rather than silently left out.
 */
export function limitReport(samples, { from, to, now = Date.now(), tz, names = new Map(), known = [], gapHours = GAP_HOURS, providerNames = {} }) {
  const end = Math.min(to, now);
  const stamp = (ms) => localStamp(ms, tz);
  const days = round1((end - from) / DAY);
  const groups = byAccount(samples);
  const accounts = [];
  const blockedByProvider = new Map();

  for (const [accountId, list] of groups) {
    const provider = list[0].provider;
    const providerName = providerLabel(provider, providerNames);
    const name = accountName(accountId, names);
    const ids = [...new Set(list.flatMap((s) => Object.keys(s.windows || {})))];
    const order = Object.keys(WINDOWS[provider] || {});
    ids.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    const windows = [];
    const accountBlocked = [];
    const hitHours = new Map();
    const hitDays = new Map();
    for (const id of ids) {
      const series = seriesOf(list, id);
      if (!series.length) continue;
      const info = windowInfo(provider, id, series.find((s) => s.minutes)?.minutes);
      const periods = windowPeriods(series, (info.minutes || 300) * MINUTE);
      const hits = windowHits(periods, { end });
      // An idle login reports a fresh window at 0% on every reading (Codex does); those were never used.
      const allPeaks = periods.map(peakOf);
      const peaks = allPeaks.filter((peak) => peak > 0);
      if (info.scope === 'all') accountBlocked.push(...hits.map((h) => h.interval));
      for (const h of hits) {
        const { hour, date } = localParts(h.start, tz);
        hitHours.set(hour, (hitHours.get(hour) || 0) + 1);
        hitDays.set(date, (hitDays.get(date) || 0) + 1);
      }
      const blocked = unionIntervals(hits.map((h) => h.interval));
      windows.push({
        window: id,
        label: info.label,
        windowMinutes: info.minutes,
        scope: info.scope,
        periodsUsed: peaks.length,
        hits: hits.length,
        blockedHours: hours(total(blocked)),
        peakPct: allPeaks.length ? Math.max(...allPeaks) : null,
        avgPeakPct: peaks.length ? round1(peaks.reduce((a, b) => a + b, 0) / peaks.length) : null,
        resetUnknownHits: hits.filter((h) => !h.resetKnown && !h.endedEarly).length,
        endedEarlyHits: hits.filter((h) => h.endedEarly).length,
        recentHits: hits.slice(-HITS_LISTED).reverse().map((h) => ({
          cappedAt: stamp(h.start),
          resetAt: h.resetKnown ? stamp(h.until) : null,
          blockedHours: hours(h.blockedMs),
          ongoing: h.ongoing,
          ...(h.endedEarly ? { endedEarly: true } : {}),
        })),
        hitsListed: Math.min(hits.length, HITS_LISTED),
      });
    }
    const blocked = unionIntervals(accountBlocked);
    const gaps = gapsOf(list, end, gapHours * HOUR);
    const coveredDays = round1((end - Math.max(from, list[0].t)) / DAY);
    const { days: activeDays, hoursOfDay, window: activityWindow } = activity(list, provider, tz);

    const account = {
      accountId,
      provider,
      providerName,
      name,
      coverage: {
        firstReading: stamp(list[0].t),
        lastReading: stamp(list[list.length - 1].t),
        readings: list.length,
        coveredDays,
        gapsOver: `${gapHours} h`,
        gapCount: gaps.length,
        gapHours: hours(total(gaps)),
        longestGaps: [...gaps].sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, 5)
          .map(([a, b]) => ({ from: stamp(a), to: stamp(b), hours: hours(b - a) })),
      },
      windows,
      totalBlockedHours: hours(total(blocked)),
      busiest: {
        measuredBy: activityWindow ? `points of the ${activityWindow} window spent` : null,
        days: top(activeDays, 5, 'date').map((d) => ({ ...d, caps: hitDays.get(d.date) || 0 })),
        capsReachedByDay: [...hitDays.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5)
          .map(([date, n]) => ({ date, caps: n })),
        hoursOfDay: top(hoursOfDay, 5, 'hour').map((h) => ({ hours: hourLabel(h.hour), pointsSpent: h.pointsSpent })),
        capsReachedByHour: [...hitHours.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 5)
          .map(([h, n]) => ({ hours: hourLabel(h), caps: n })),
      },
    };
    account.summary = accountSummary(account, days, coveredDays);
    accounts.push(account);
    if (!blockedByProvider.has(provider)) blockedByProvider.set(provider, []);
    // Every account with history counts from the start of the range: an idle login
    // records nothing, so its first reading is no proof it could not have served earlier.
    // That keeps "every account capped at once" a lower bound.
    blockedByProvider.get(provider).push({ since: from, blocked });
  }

  accounts.sort((a, b) => b.totalBlockedHours - a.totalBlockedHours || a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));

  const providers = [...blockedByProvider.entries()].map(([provider, list]) => {
    const all = allBlockedIntervals(list);
    const providerName = providerLabel(provider, providerNames);
    const mine = accounts.filter((a) => a.provider === provider);
    const hits = mine.reduce((n, a) => n + a.windows.filter((w) => w.scope === 'all').reduce((m, w) => m + w.hits, 0), 0);
    const allHours = hours(total(all));
    return {
      provider,
      providerName,
      accountsWithHistory: list.length,
      capHits: hits,
      accountBlockedHours: round1(mine.reduce((n, a) => n + a.totalBlockedHours, 0)),
      allAccountsBlockedHours: allHours,
      allAccountsBlockedSpans: all.length,
      summary: list.length === 1
        ? `${providerName}: one account with history, so its blocked time (~${allHours} h) was time with no ${providerName} at all.`
        : all.length
          ? `${providerName}: ${plural(list.length, 'account')} with history; all of them were capped at the same time for ~${allHours} h (${plural(all.length, 'stretch', 'stretches')}), when no ${providerName} account could serve.`
          : `${providerName}: ${plural(list.length, 'account')} with history; they were never all capped at the same time, so another account was always free (${round1(mine.reduce((n, a) => n + a.totalBlockedHours, 0))} h blocked across them).`,
    };
  });

  const withHistory = new Set(groups.keys());
  const noHistory = known
    .filter((a) => !withHistory.has(a.id))
    .map((a) => ({
      accountId: a.id,
      provider: a.backend,
      name: String(a.displayName || a.label || a.id),
      reason: a.source !== 'cliproxy'
        ? (a.backend === 'cursor'
          ? 'Cursor is read live only; no history is recorded for it.'
          : 'Not a CLIProxy login, so only live readings exist (usage__get_current).')
        : 'No readings from this login in the range.',
    }));

  return {
    timeZone: tz || 'UTC',
    range: { from: stamp(from), to: stamp(end), days },
    thresholds: { capPct: SPENT_PCT },
    accounts,
    providers,
    noHistory,
    method: [
      `Source: the quota readings CLIProxy recorded for its Claude and Codex logins (passive ones from the rate-limit headers of real requests, active ones when Totem polled). Times are ${tz || 'UTC'}.`,
      `A cap hit is one window period (between two resets) in which a reading reached ${SPENT_PCT}% used; several readings at the cap in the same window count once.`,
      'Blocked time runs from the first reading at the cap to that window\'s reset, so it is a lower bound: the cap may have been reached shortly before it was first seen. A hit with no reset time recorded, or whose window was reset early (a reset credit or grant), counts only until its last reading at the cap.',
      'An idle login can report a fresh window at 0% on every reading; windows that never rose above 0% are not counted as periods or in average peaks.',
      'A provider\'s "every account capped at once" counts only time when each of its accounts with readings in the range was blocked.',
      'An account\'s total blocked hours merge its 5-hour and weekly windows, so an overlap is counted once. Model-scoped windows (weekly Fable) are reported but not counted as the account being blocked.',
      `No readings means no data, not 0%: an idle login records nothing, so a gap over ${gapHours} h is listed rather than filled in.`,
      'Busiest days and hours add up the rise of the 5-hour window between readings; the first reading of a window counts in full, at the time it was taken.',
    ],
    summary: accounts.length
      ? accounts.map((a) => a.summary)
      : ['No usage history was recorded in this range.'],
  };
}

function accountSummary(account, days, coveredDays) {
  const main = account.windows.filter((w) => w.scope === 'all');
  const scoped = account.windows.filter((w) => w.scope === 'model');
  const head = `${account.providerName} (${account.name})`;
  const span = coveredDays < days - 0.05
    ? `in ${dayCount(coveredDays)} of readings (of the ${dayCount(days)} asked for)`
    : `in ${dayCount(days)}`;
  const coverage = `readings ${account.coverage.firstReading} → ${account.coverage.lastReading}`;
  const hit = main.filter((w) => w.hits);
  const extras = scoped.filter((w) => w.hits).map((w) => `${w.label} cap reached ${times(w.hits)}`);
  if (!hit.length) {
    const peaks = main.filter((w) => w.peakPct !== null).map((w) => `${w.label} peak ${w.peakPct}%`);
    return `${head}: never reached a cap ${span}${peaks.length ? ` (${peaks.join(', ')})` : ''}${extras.length ? `; ${extras.join('; ')}` : ''}; ${coverage}.`;
  }
  const parts = hit.map((w, i) => (i === 0
    ? `hit the ${w.label} cap ${times(w.hits)} ${span}, blocked ~${w.blockedHours} h`
    : `${w.label} cap reached ${times(w.hits)}, blocked ~${w.blockedHours} h`));
  const totalPart = hit.length > 1 ? `; ~${account.totalBlockedHours} h blocked in all, overlaps counted once` : '';
  return `${head}: ${parts.join('; ')}${totalPart}${extras.length ? `; ${extras.join('; ')}` : ''}; ${coverage}.`;
}
