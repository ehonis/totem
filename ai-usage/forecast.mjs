/**
 * Where AI subscription usage is heading, and when a job of a given size fits.
 * Pure functions over the poller's snapshot and CLIProxy's normalised history;
 * ai-usage/mcp.mjs serves them as totem_usage_forecast and totem_usage_plan.
 *
 * The projection follows the CLIProxy tab's graphs (web/src/cliproxy/pool/
 * poolModel.ts) so an agent and the owner read the same story:
 *  - The pace is each account's own rise in used % over the last few hours of
 *    readings (3 by default, the graphs' default), a reset counted as a fresh start.
 *  - A provider's CLIProxy logins are one pool: the pace of all of them is routed,
 *    soonest weekly reset first, to whichever login still has room, as the proxy
 *    does. Logins outside CLIProxy have no history, so they are projected idle.
 *  - A login is usable only while both its 5-hour and its weekly window have room;
 *    spending a 5-hour window also spends the week, at the ratio its own readings
 *    show (weekly points per 5-hour point).
 *  - A 5-hour window that has not started, or has just reset, starts on first use.
 *    A weekly window resets on its own schedule.
 *  - Quiet hours and off days, in the owner's time zone, spend nothing.
 *
 * Every percent is the account's own unless named "pool": a pool percent is one
 * 5-hour window of the provider's largest plan (Claude plans weighted by price,
 * as the graphs do: Pro 1, Max 5x 5, Max 20x 10).
 */

import { isScopedMeter } from './pools.mjs';
import { localParts, localStamp, providerLabel, resetMs } from './report.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FIVE_HOURS = 5 * HOUR;
const WEEK = 7 * DAY;

export const FORECAST_DEFAULTS = Object.freeze({ burnWindowHours: 3, futureFactor: 1, horizonHours: 168, pace: 'blend' });
/**
 * 'recent' runs the last few hours' pace for the whole horizon, as the graphs do;
 * 'week' runs each login's average over its last 7 days of readings (nights and idle
 * days included); 'blend' (default) runs the recent pace for BLEND_HOURS, then the
 * week's average, because a busy afternoon repeated around the clock for a week
 * reads as a wall of caps that never comes.
 */
export const PACES = Object.freeze(['blend', 'recent', 'week']);
const BLEND_HOURS = 5;
export const BURN_WINDOW_MAX_HOURS = 72;
export const HORIZON_MAX_HOURS = 14 * 24;
/** How far back the weekly-per-5-hour ratio is measured. */
const RATIO_LOOKBACK = 7 * DAY;
/** Used when no login of a provider has enough readings to measure it. */
export const FALLBACK_WEEKLY_PER_FIVE = 0.1;
const STEP = 5 * MINUTE;
const EMPTY = 0.5;
const DROP = 5;
const MIN_COVERED = 15 * MINUTE;
const CLAUDE_PRICE_WEIGHT = { 1: 1, 5: 5, 20: 10 };

/** What a job costs, as a share of one 5-hour window on the provider's largest plan. */
export const JOB_SIZES = Object.freeze({ small: 5, medium: 20, large: 50, full: 100 });

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const round1 = (n) => Math.round(n * 10) / 10;
const clamp = (n) => Math.max(0, Math.min(100, n));

// ---- Inputs -------------------------------------------------------------------

/** 'five' for a short (≤ 1 day) all-models window, 'weekly' for a 7-day one. */
export function windowClass(minutes, key = '') {
  if (finite(minutes) && minutes > 0) {
    if (minutes <= 24 * 60) return 'five';
    if (minutes >= 7 * 24 * 60 && minutes <= 8 * 24 * 60) return 'weekly';
    return null;
  }
  if (/^(session:|five_hour|primary)$/.test(key)) return 'five';
  if (/^(weekly_all:|seven_day|secondary|weekly)$/.test(key)) return 'weekly';
  return null;
}

function planWeight(account) {
  if (account.backend !== 'claude') return 1;
  const multiple = /(?:max\s*|max_)(\d+)x/i.exec(String(account.plan || ''));
  const size = finite(account.planSize) && account.planSize > 0 ? account.planSize : multiple ? Number(multiple[1]) : 1;
  return CLAUDE_PRICE_WEIGHT[size] ?? size;
}

/** "23-7" → { startHour: 23, endHour: 7 }; anything else → null. */
export function parseQuietHours(value) {
  if (value && typeof value === 'object' && Number.isInteger(value.startHour) && Number.isInteger(value.endHour)) return value;
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(String(value ?? ''));
  if (!m) return null;
  const startHour = Number(m[1]);
  const endHour = Number(m[2]);
  if (startHour > 23 || endHour > 24 || startHour === endHour % 24) return null;
  return { startHour, endHour: endHour % 24 };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Idle in the owner's zone: an off day, or inside the quiet block. */
function idleAt(t, { tz, quietHours, offDays }) {
  if (!quietHours && !offDays?.length) return false;
  const p = localParts(t, tz);
  if (offDays?.length && offDays.includes(WEEKDAYS.indexOf(p.weekday))) return true;
  if (!quietHours) return false;
  const hour = p.hour + Number(p.minute) / 60;
  const { startHour: a, endHour: b } = quietHours;
  return a < b ? hour >= a && hour < b : hour >= a || hour < b;
}

/** An ISO time with an offset, or "YYYY-MM-DD HH:MM" in the owner's zone. */
export function parseWhen(value, tz) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h = '0', mi = '0'] = m.slice(1);
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi);
  // Find the instant whose wall clock in tz reads `wall`; twice covers a DST edge.
  let guess = wall;
  for (let i = 0; i < 2; i += 1) {
    const p = localParts(guess, tz);
    const [py, pm, pd] = p.date.split('-').map(Number);
    const seen = Date.UTC(py, pm - 1, pd, p.hour, Number(p.minute));
    guess += wall - seen;
  }
  return guess;
}

// ---- Pace from history ------------------------------------------------------------

/** One window class's readings for one account, oldest first. */
function classSeries(samples, provider, cls) {
  const out = [];
  for (const s of samples) {
    for (const [id, w] of Object.entries(s.windows || {})) {
      if (!w || !finite(w.used)) continue;
      if (/fable|opus|sonnet/i.test(id)) continue;
      if (windowClass(w.windowMinutes, id) !== cls) continue;
      if (provider === 'codex' && id === 'weekly' && Object.keys(s.windows).includes('secondary')) continue;
      out.push({ t: s.t, used: w.used, reset: resetMs(w.resetAtMs) });
      break;
    }
  }
  return out;
}

/** Did a window reset between readings a and b? */
function resetBetween(a, b) {
  if (a.reset && b.t >= a.reset) return true;
  if (a.reset && b.reset && b.reset - a.reset > 15 * MINUTE) return true;
  return !a.reset && b.used < a.used - DROP;
}

/**
 * Points gained per hour over [from, to] and the hours the readings cover. Gains are
 * measured from the window's high-water mark, so a passive and an active reading a
 * point apart do not count as use; a reset starts the count again from 0. The pair
 * that straddles `from` counts in proportion. Null when under 15 minutes are covered.
 */
export function paceOf(series, { from, to }) {
  const points = series.filter((p) => p.t <= to);
  let total = 0;
  let first = null;
  let level = points[0]?.used ?? 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (b.t <= a.t) { level = Math.max(level, b.used); continue; }
    const fresh = resetBetween(a, b);
    const gained = fresh ? Math.max(0, b.used) : Math.max(0, b.used - level);
    level = fresh ? b.used : Math.max(level, b.used);
    if (b.t <= from) continue;
    total += gained * ((b.t - Math.max(a.t, from)) / (b.t - a.t));
    first = first ?? Math.max(a.t, from);
  }
  if (first === null) {
    const inside = points.find((p) => p.t >= from);
    if (!inside) return { perHour: null, coveredHours: 0, gained: 0 };
    first = inside.t;
  }
  const covered = to - first;
  if (covered < MIN_COVERED) return { perHour: null, coveredHours: round1(covered / HOUR), gained: 0 };
  return { perHour: total / (covered / HOUR), coveredHours: round1(covered / HOUR), gained: total };
}

// ---- Accounts -------------------------------------------------------------------------

function liveWindow(meter, observedAt) {
  const used = finite(meter.usedPct) ? meter.usedPct : null;
  const remaining = finite(meter.remainingPct) ? meter.remainingPct : used === null ? null : 100 - used;
  let reset = resetMs(meter.resetsAt);
  const period = finite(meter.windowMinutes) && meter.windowMinutes > 0 ? meter.windowMinutes * MINUTE : null;
  // A reading taken before its window's reset that has since passed: the window refilled.
  let rem = remaining === null ? null : clamp(remaining);
  if (rem !== null && reset && reset <= observedAt.now) {
    rem = 100;
    reset = null;
  }
  return { remaining: rem, reset, periodMs: period };
}

/** The accounts the forecast can reason about, with their live windows and pace. */
export function forecastAccounts(snapshot, samples, { now, burnWindowHours, provider = null }) {
  const out = [];
  for (const a of snapshot?.accounts || []) {
    if (provider && a.backend !== provider) continue;
    const observed = { now, at: finite(a.fetchedAt) ? a.fetchedAt : now };
    const windows = {};
    const caps = [];
    const other = [];
    for (const m of a.meters || []) {
      if (isScopedMeter(m)) {
        if (m.key !== 'extra_usage') caps.push(m);
        continue;
      }
      const cls = windowClass(m.windowMinutes, String(m.key ?? ''));
      if (cls && !windows[cls]) windows[cls] = { key: m.key, label: m.label, ...liveWindow(m, observed) };
      else if (!cls) other.push(m);
    }
    if (windows.five) windows.five.periodMs ||= FIVE_HOURS;
    if (windows.weekly) windows.weekly.periodMs ||= WEEK;
    const mine = (samples || []).filter((s) => s.accountId === a.id);
    const pace = {};
    const lookback = { from: now - burnWindowHours * HOUR, to: now };
    for (const cls of ['five', 'weekly']) {
      const series = classSeries(mine, a.backend, cls);
      const w = windows[cls];
      // The live reading closes the series, so the pace runs right up to now.
      if (w && w.remaining !== null && finite(a.fetchedAt) && (!series.length || a.fetchedAt > series[series.length - 1].t)) {
        series.push({ t: Math.min(now, a.fetchedAt), used: 100 - w.remaining, reset: w.reset });
      }
      pace[cls] = { ...paceOf(series, lookback), long: paceOf(series, { from: now - RATIO_LOOKBACK, to: now }) };
    }
    const fiveLong = pace.five.long.gained;
    const weeklyLong = pace.weekly.long.gained;
    out.push({
      id: String(a.id),
      provider: a.backend,
      name: String(a.displayName || a.label || a.id),
      plan: a.plan ? String(a.plan) : null,
      source: a.source === 'cliproxy' ? 'cliproxy' : 'local',
      state: a.state ?? null,
      disabled: Boolean(a.disabled),
      usable: !a.disabled && !a.authProblem && a.state !== 'disabled',
      weight: planWeight(a),
      windows,
      caps,
      other,
      pace,
      hasHistory: mine.length > 0,
      ratio: fiveLong >= 5 && weeklyLong > 0 ? weeklyLong / fiveLong : null,
    });
  }
  return out;
}

// ---- Simulation --------------------------------------------------------------------

/**
 * Steps every account of one group forward from now. Each group is one CLIProxy
 * pool, or one login on its own. Returns the timeline and what happened on it.
 */
function simulate(group, { now, horizonMs, futureFactor, idle, pace = 'blend' }) {
  const biggest = Math.max(...group.map((a) => a.weight), 1e-9);
  const state = group.map((a) => {
    const five = a.windows.five;
    const weekly = a.windows.weekly;
    return {
      a,
      share: a.weight / biggest,
      ratio: a.ratio,
      five: five && five.remaining !== null ? { rem: five.remaining, reset: five.reset, period: five.periodMs, first: five.reset } : null,
      weekly: weekly && weekly.remaining !== null ? { rem: weekly.remaining, reset: weekly.reset, period: weekly.periodMs, first: weekly.reset } : null,
    };
  });
  // The pace of every login, in pool percent per hour of 5-hour capacity.
  const poolPace = (pick) => state.reduce((sum, s) => {
    const five = pick(s.a.pace.five);
    const weekly = pick(s.a.pace.weekly);
    const ratio = s.ratio ?? FALLBACK_WEEKLY_PER_FIVE;
    // A login with no 5-hour pace but a weekly one still spends: express it in 5-hour points.
    const perHour = finite(five) ? five : finite(weekly) ? weekly / ratio : 0;
    return sum + perHour * s.share;
  }, 0);
  const measured = poolPace((p) => p.perHour);
  const average = poolPace((p) => p.long.perHour);
  const factor = Math.max(0, futureFactor);
  const demandAt = (t) => {
    if (pace === 'recent') return measured * factor;
    if (pace === 'week') return average * factor;
    return (t - now < BLEND_HOURS * HOUR ? measured : average) * factor;
  };

  const room = (s) => {
    if (!s.a.usable) return 0;
    const five = s.five ? s.five.rem : 100;
    const weekly = s.weekly ? s.weekly.rem / (s.ratio ?? FALLBACK_WEEKLY_PER_FIVE) : Infinity;
    if (!s.five && !s.weekly) return 0;
    return Math.max(0, Math.min(five, weekly));
  };
  const usableNow = (s) => s.a.usable && (!s.five || s.five.rem > EMPTY) && (!s.weekly || s.weekly.rem > EMPTY) && Boolean(s.five || s.weekly);

  const timeline = [];
  const events = new Map(state.map((s) => [s.a.id, { fiveOutAt: null, weeklyOutAt: null, weeklyAtReset: null, fiveAtReset: null }]));
  const blocked = [];
  let open = null;
  let unmet = 0;
  const snapshotAt = (t) => ({
    t,
    accounts: state.map((s) => ({ five: s.five ? s.five.rem : null, weekly: s.weekly ? s.weekly.rem : null, fiveReset: s.five?.reset ?? null })),
  });

  const end = now + horizonMs;
  let prev = now;
  for (let t = now; t <= end; t += STEP) {
    if (t > now) {
      const dtHours = (t - prev) / HOUR;
      let need = idle((t + prev) / 2) ? 0 : demandAt(prev) * dtHours;
      if (need > 0) {
        const order = state.filter(usableNow).sort((x, y) =>
          (x.weekly?.reset ?? Infinity) - (y.weekly?.reset ?? Infinity)
          || (x.five?.reset ?? Infinity) - (y.five?.reset ?? Infinity)
          || x.a.id.localeCompare(y.a.id));
        for (const s of order) {
          const take = Math.min(need, room(s) * s.share);
          if (take <= 0) continue;
          const points = take / s.share;
          if (s.five) {
            s.five.rem -= points;
            if (!s.five.reset) s.five.reset = prev + s.five.period;
          }
          if (s.weekly) {
            s.weekly.rem -= points * (s.ratio ?? FALLBACK_WEEKLY_PER_FIVE);
            if (!s.weekly.reset) s.weekly.reset = prev + s.weekly.period;
          }
          need -= take;
          if (need <= 1e-9) break;
        }
        unmet += Math.max(0, need);
      }
      for (const s of state) {
        const ev = events.get(s.a.id);
        if (s.five && s.five.reset && s.five.reset <= t) {
          // 5-hour room the week cannot back is no room at all.
          const weeklyRoom = s.weekly ? s.weekly.rem / (s.ratio ?? FALLBACK_WEEKLY_PER_FIVE) : Infinity;
          if (ev.fiveAtReset === null && s.five.reset === s.five.first) ev.fiveAtReset = Math.max(0, Math.min(s.five.rem, weeklyRoom));
          s.five.rem = 100;
          s.five.reset = null; // the next window starts on first use
        }
        if (s.weekly && s.weekly.reset && s.weekly.reset <= t) {
          if (ev.weeklyAtReset === null && s.weekly.reset === s.weekly.first) ev.weeklyAtReset = Math.max(0, s.weekly.rem);
          s.weekly.rem = 100;
          s.weekly.reset += s.weekly.period;
        }
      }
      prev = t;
    }
    for (const s of state) {
      const ev = events.get(s.a.id);
      if (s.five && ev.fiveOutAt === null && s.five.rem <= EMPTY && (!s.five.first || t < s.five.first)) ev.fiveOutAt = t;
      if (s.weekly && ev.weeklyOutAt === null && s.weekly.rem <= EMPTY && (!s.weekly.first || t < s.weekly.first)) ev.weeklyOutAt = t;
    }
    const anyUsable = state.some(usableNow);
    if (!anyUsable && !open) open = { from: t, to: null };
    if (anyUsable && open) { open.to = t; blocked.push(open); open = null; }
    timeline.push(snapshotAt(t));
  }
  if (open) { open.to = null; blocked.push(open); }

  return { state, timeline, events, blocked, measuredPerHour: measured, averagePerHour: average, unmet, biggest };
}

function groupsOf(accounts) {
  const groups = new Map();
  for (const a of accounts) {
    if (a.disabled || (!a.windows.five && !a.windows.weekly)) continue;
    const key = a.source === 'cliproxy' ? `${a.provider}:pool` : a.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  return [...groups.entries()].map(([key, list]) => ({ key, provider: list[0].provider, pooled: key.endsWith(':pool'), accounts: list }));
}

/** A provider's measured weekly-per-5-hour ratio, filled in for logins without one. */
function fillRatios(accounts) {
  const byProvider = new Map();
  for (const a of accounts) {
    const t = byProvider.get(a.provider) || { five: 0, weekly: 0 };
    t.five += a.pace.five.long.gained * a.weight;
    t.weekly += a.pace.weekly.long.gained * a.weight;
    byProvider.set(a.provider, t);
  }
  for (const a of accounts) {
    if (a.ratio !== null) { a.ratioSource = 'measured'; continue; }
    const t = byProvider.get(a.provider);
    if (t && t.five >= 5 && t.weekly > 0) { a.ratio = t.weekly / t.five; a.ratioSource = 'provider'; } else { a.ratio = FALLBACK_WEEKLY_PER_FIVE; a.ratioSource = 'assumed'; }
  }
}

// ---- Forecast -----------------------------------------------------------------------

function normalizeOptions(opts) {
  const burnWindowHours = Math.min(BURN_WINDOW_MAX_HOURS, Math.max(1, Number(opts.burnWindowHours) || FORECAST_DEFAULTS.burnWindowHours));
  const futureFactor = finite(Number(opts.futureFactor)) && opts.futureFactor !== null && opts.futureFactor !== ''
    ? Math.min(5, Math.max(0, Number(opts.futureFactor))) : FORECAST_DEFAULTS.futureFactor;
  const horizonHours = Math.min(HORIZON_MAX_HOURS, Math.max(1, Number(opts.horizonHours) || FORECAST_DEFAULTS.horizonHours));
  const quietHours = parseQuietHours(opts.quietHours);
  const offDays = Array.isArray(opts.offDays)
    ? [...new Set(opts.offDays.map((d) => (typeof d === 'string' ? WEEKDAYS.findIndex((w) => w.toLowerCase() === d.slice(0, 3).toLowerCase()) : d))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    : [];
  const pace = PACES.includes(opts.pace) ? opts.pace : FORECAST_DEFAULTS.pace;
  return { burnWindowHours, futureFactor, horizonHours, quietHours, offDays, pace };
}

/** Runs every group once; the forecast and the plan both read this. */
export function project(snapshot, samples, opts = {}) {
  const now = opts.now ?? Date.now();
  const tz = opts.tz || 'UTC';
  const o = normalizeOptions(opts);
  const accounts = forecastAccounts(snapshot, samples, { now, burnWindowHours: o.burnWindowHours, provider: opts.provider ?? null });
  fillRatios(accounts);
  const idle = (t) => idleAt(t, { tz, quietHours: o.quietHours, offDays: o.offDays });
  const groups = groupsOf(accounts).map((g) => ({ ...g, sim: simulate(g.accounts, { now, horizonMs: o.horizonHours * HOUR, futureFactor: o.futureFactor, idle, pace: o.pace }) }));
  return { now, tz, options: o, accounts, groups };
}

const stampOf = (tz) => (ms) => (finite(ms) ? localStamp(ms, tz) : null);
const hoursFrom = (now) => (ms) => (finite(ms) ? round1((ms - now) / HOUR) : null);

function windowForecast(w, ev, pace, cls, stamp, inH) {
  if (!w || w.remaining === null) return null;
  const outAt = cls === 'five' ? ev.fiveOutAt : ev.weeklyOutAt;
  const atReset = cls === 'five' ? ev.fiveAtReset : ev.weeklyAtReset;
  return {
    window: cls === 'five' ? '5-hour' : 'weekly',
    remainingPct: round1(w.remaining),
    resetsAt: stamp(w.reset),
    resetsInHours: inH(w.reset),
    startsOnFirstUse: cls === 'five' && !w.reset,
    pacePctPerHour: finite(pace.perHour) ? round1(pace.perHour) : null,
    paceCoveredHours: pace.coveredHours,
    spentNow: w.remaining <= EMPTY,
    runsOutAt: w.remaining <= EMPTY ? null : stamp(outAt),
    runsOutInHours: w.remaining <= EMPTY ? null : inH(outAt),
    weekAveragePctPerHour: finite(pace.long.perHour) ? round1(pace.long.perHour) : null,
    unusedAtResetPct: atReset === null || !w.reset ? null : round1(atReset),
  };
}

/** The forecast answer: per account, per provider, and how it was worked out. */
export function buildForecast(snapshot, samples, opts = {}) {
  const p = project(snapshot, samples, opts);
  const { now, tz, options: o } = p;
  const stamp = stampOf(tz);
  const inH = hoursFrom(now);
  const names = snapshot?.providers || {};
  const accounts = [];
  const providers = [];
  const summary = [];

  for (const g of p.groups) {
    const { sim } = g;
    const pname = providerLabel(g.provider, names);
    const mine = [];
    for (const s of sim.state) {
      const a = s.a;
      const ev = sim.events.get(a.id);
      const five = windowForecast(a.windows.five, ev, a.pace.five, 'five', stamp, inH);
      const weekly = windowForecast(a.windows.weekly, ev, a.pace.weekly, 'weekly', stamp, inH);
      const levels = [five, weekly].filter(Boolean);
      const usableNowPct = levels.length && a.usable ? Math.min(...levels.map((w) => w.remainingPct)) : 0;
      const binding = five && weekly ? (weekly.remainingPct <= five.remainingPct ? 'weekly' : '5-hour') : levels[0]?.window ?? null;
      const spare = weekly && weekly.unusedAtResetPct !== null && weekly.unusedAtResetPct >= 5 ? weekly.unusedAtResetPct : null;
      const fiveSpare = five && five.unusedAtResetPct !== null && five.unusedAtResetPct >= 10 ? five.unusedAtResetPct : null;
      let line = `${pname} (${a.name}): ${round1(usableNowPct)}% usable now`;
      if (binding === 'weekly' && five) line += ' (the week binds)';
      if (weekly?.spentNow) line += `; weekly spent until ${weekly.resetsAt ?? 'its reset'}`;
      else if (five?.spentNow) line += `; 5-hour spent until ${five.resetsAt ?? 'its reset'}`;
      if (!weekly?.spentNow && weekly?.runsOutAt) line += `; weekly runs out ${weekly.runsOutAt}, resets ${weekly.resetsAt}`;
      else if (!five?.spentNow && five?.runsOutAt) line += `; 5-hour runs out ${five.runsOutAt}, resets ${five.resetsAt}`;
      if (fiveSpare !== null) line += `; ~${fiveSpare}% of its 5-hour window will reset unused at ${five.resetsAt}`;
      if (spare !== null) line += `; ~${spare}% of its week will reset unused at ${weekly.resetsAt}`;
      if (!a.hasHistory) line += '; no recorded history, projected idle';
      mine.push({
        accountId: a.id,
        provider: g.provider,
        providerName: pname,
        name: a.name,
        plan: a.plan,
        source: a.source,
        pooled: g.pooled,
        poolShare: round1(s.share * 100),
        state: a.state,
        usableNowPct: round1(usableNowPct),
        binding,
        weeklyPerFiveHourPoint: Math.round(a.ratio * 1000) / 1000,
        weeklyPerFiveHourSource: a.ratioSource,
        windows: [five, weekly].filter(Boolean),
        modelCaps: a.caps.map((m) => ({ label: String(m.label ?? m.key), remainingPct: finite(m.remainingPct) ? round1(m.remainingPct) : finite(m.usedPct) ? round1(100 - m.usedPct) : null, resetsAt: stamp(resetMs(m.resetsAt)) })),
        spareBeforeResetPct: spare,
        fiveHourSparePct: fiveSpare,
        summary: line,
      });
    }
    accounts.push(...mine);

    const blockedSpans = sim.blocked.map((b) => ({ from: stamp(b.from), to: b.to ? stamp(b.to) : null, fromInHours: inH(b.from), hours: b.to ? round1((b.to - b.from) / HOUR) : null }));
    const firstBlocked = sim.blocked[0] || null;
    const capacity = sim.state.reduce((sum, s) => sum + s.share * 100, 0);
    const usableNow = sim.timeline[0].accounts.reduce((sum, lv, i) => {
      const s = sim.state[i];
      if (!s.a.usable) return sum;
      const fiveRoom = lv.five ?? 100;
      const weeklyRoom = lv.weekly === null ? Infinity : lv.weekly / (s.ratio ?? FALLBACK_WEEKLY_PER_FIVE);
      return sum + Math.max(0, Math.min(fiveRoom, weeklyRoom, 100)) * s.share;
    }, 0);
    const spare = mine.filter((x) => x.spareBeforeResetPct !== null)
      .map((x) => ({ accountId: x.accountId, name: x.name, pct: x.spareBeforeResetPct, before: x.windows.find((w) => w.window === 'weekly')?.resetsAt }));
    const groupName = g.pooled ? `${pname} pool (${g.accounts.length} login${g.accounts.length === 1 ? '' : 's'})` : `${pname} (${g.accounts[0].name})`;
    let line = `${groupName}: ${round1(sim.measuredPerHour)} pool %/h over the last ${o.burnWindowHours} h, ${round1(sim.averagePerHour)} on an average hour this week`;
    if (o.futureFactor !== 1) line += ` (projected at ×${o.futureFactor})`;
    line += firstBlocked
      ? `; every login capped from ${stamp(firstBlocked.from)}${firstBlocked.to ? ` to ${stamp(firstBlocked.to)}` : ' past the horizon'}`
      : `; capacity lasts through the next ${o.horizonHours} h`;
    if (spare.length) line += `; spare to use before it resets: ${spare.map((x) => `${x.name} ~${x.pct}% by ${x.before}`).join(', ')}`;
    summary.push(line);
    providers.push({
      provider: g.provider,
      providerName: pname,
      pooled: g.pooled,
      accounts: g.accounts.map((a) => a.id),
      capacityPoolPct: round1(capacity),
      usableNowPoolPct: round1(usableNow),
      pacePoolPctPerHour: round1(sim.measuredPerHour),
      weekAveragePoolPctPerHour: round1(sim.averagePerHour),
      allCappedAt: firstBlocked ? stamp(firstBlocked.from) : null,
      allCappedInHours: firstBlocked ? inH(firstBlocked.from) : null,
      blockedSpans,
      unservedPoolPct: round1(sim.unmet),
      spare,
      summary: line,
    });
  }

  const other = p.accounts.filter((a) => a.disabled || (!a.windows.five && !a.windows.weekly)).map((a) => ({
    accountId: a.id, provider: a.provider, name: a.name,
    reason: a.disabled ? 'switched off in the proxy' : 'no 5-hour or weekly window to project (a monthly or other cycle)',
    windows: a.other.map((m) => ({ label: String(m.label ?? m.key), remainingPct: finite(m.remainingPct) ? round1(m.remainingPct) : finite(m.usedPct) ? round1(100 - m.usedPct) : null, resetsAt: stamp(resetMs(m.resetsAt)) })),
  }));

  return {
    timeZone: tz,
    now: stamp(now),
    horizon: { hours: o.horizonHours, until: stamp(now + o.horizonHours * HOUR) },
    assumptions: {
      burnWindowHours: o.burnWindowHours,
      futureFactor: o.futureFactor,
      pace: o.pace,
      quietHours: o.quietHours ? `${o.quietHours.startHour}-${o.quietHours.endHour}` : null,
      offDays: o.offDays.map((d) => WEEKDAYS[d]),
      routing: 'soonest weekly reset first, within each CLIProxy pool',
    },
    summary,
    providers,
    accounts,
    unprojected: other,
    method: forecastMethod(o),
  };
}

function forecastMethod(o) {
  return [
    `Pace: each login's rise in used % over the last ${o.burnWindowHours} h of recorded readings (a reset counts as a fresh start), as the CLIProxy tab's graphs measure it, and over its last 7 days (the week average, nights and idle days included). Under 15 minutes of readings is no pace.`,
    o.pace === 'recent'
      ? 'Projected at the recent pace for the whole horizon, as the dashboard\'s graphs do: a busy stretch repeated around the clock, so pessimistic past the next few hours.'
      : o.pace === 'week'
        ? 'Projected at each login\'s 7-day average pace for the whole horizon.'
        : `Projected at the recent pace for the next ${BLEND_HOURS} h, then at each login's 7-day average. The dashboard's graphs run the recent pace throughout, so their run-out times past a few hours are earlier than these.`,
    'A provider\'s CLIProxy logins are one pool: the sum of their paces is routed to the login whose weekly window resets soonest, then the next, as the proxy spreads requests. Logins outside CLIProxy have no history and are projected idle.',
    'A login serves only while both its 5-hour and weekly windows have room. Spending 5-hour points spends the week at the ratio its own last 7 days show (weeklyPerFiveHourPoint; "provider" borrows the provider\'s, "assumed" is 0.1).',
    'A 5-hour window that has not started, or has just reset, starts on first use; a weekly window resets on its schedule.',
    o.quietHours || o.offDays.length ? 'Quiet hours and off days spend nothing.' : 'No quiet hours were given, so the pace runs around the clock.',
    'Pool percent is one 5-hour window of the provider\'s largest plan (Claude weighted by price: Pro 1, Max 5x 5, Max 20x 10). Every other percent is the login\'s own.',
    'unusedAtResetPct and spare are what the projection leaves in a window when it resets: capacity a scheduled job can use at no cost to the owner.',
  ];
}

// ---- Plan -----------------------------------------------------------------------------

/**
 * When and where a job of `fiveHourPct` (pool percent: share of one 5-hour window
 * on the largest plan) fits, given the projected use by everything else.
 */
export function buildPlan(snapshot, samples, opts = {}) {
  const p = project(snapshot, samples, { ...opts, provider: opts.provider ?? null });
  const { now, tz } = p;
  const stamp = stampOf(tz);
  const inH = hoursFrom(now);
  const names = snapshot?.providers || {};
  const size = JOB_SIZES[opts.size] ? opts.size : null;
  const cost = Math.min(1000, Math.max(0.5, Number(opts.fiveHourPct) || JOB_SIZES[size || 'medium']));
  const reserve = Math.min(90, Math.max(0, finite(Number(opts.reservePct)) && opts.reservePct !== null && opts.reservePct !== '' ? Number(opts.reservePct) : 10));
  const notBefore = Math.max(now, parseWhen(opts.notBefore, tz) ?? (finite(Number(opts.afterHours)) ? now + Number(opts.afterHours) * HOUR : now));
  const deadline = parseWhen(opts.deadline, tz) ?? (finite(Number(opts.withinHours)) && Number(opts.withinHours) > 0 ? now + Number(opts.withinHours) * HOUR : null);
  const providersWanted = ['claude', 'codex'].includes(opts.provider) ? [opts.provider] : ['claude', 'codex'];
  const accountWanted = typeof opts.accountId === 'string' && opts.accountId.trim() ? opts.accountId.trim() : null;

  const candidates = [];
  const tooBig = [];
  for (const g of p.groups) {
    if (!providersWanted.includes(g.provider)) continue;
    const { sim } = g;
    sim.state.forEach((s, i) => {
      const a = s.a;
      if (accountWanted && a.id !== accountWanted) return;
      if (!a.usable) return;
      const need5 = cost / s.share;
      const needW = opts.weeklyPct != null && finite(Number(opts.weeklyPct)) ? Number(opts.weeklyPct) : need5 * (s.ratio ?? FALLBACK_WEEKLY_PER_FIVE);
      if (s.five && need5 > 100) { tooBig.push({ a, need5 }); return; }
      const ratio = s.ratio ?? FALLBACK_WEEKLY_PER_FIVE;
      for (const point of sim.timeline) {
        if (point.t < notBefore) continue;
        const lv = point.accounts[i];
        const five = lv.five ?? 100;
        const weekly = lv.weekly ?? 100;
        // The reserve is what the owner keeps of a window the job shares; a job as big
        // as a whole window may take a fresh one.
        const fiveFits = five - reserve >= need5 || (five >= 99.5 && need5 > 100 - reserve);
        if (fiveFits && weekly - reserve * ratio >= needW) {
          const ev = sim.events.get(a.id);
          const weeklyReset = a.windows.weekly?.reset ?? null;
          const spare = ev.weeklyAtReset !== null && weeklyReset && point.t < weeklyReset ? ev.weeklyAtReset : null;
          const start = sim.timeline[0].accounts[i];
          const after = (lv.weekly ?? 0) > (start.weekly ?? 0) + 1 ? 'week' : five > (start.five ?? 100) + 1 ? 'five' : null;
          candidates.push({ g, s, a, t: point.t, five, weekly, need5, needW, spare, weeklyReset, after });
          break;
        }
      }
    });
  }

  // Earliest first; at the same time, the login whose week would go to waste first.
  const score = (c) => [c.t, -(c.spare ?? -1), c.weeklyReset ?? Infinity, -c.five];
  candidates.sort((x, y) => {
    const a = score(x);
    const b = score(y);
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
    return x.a.id.localeCompare(y.a.id);
  });

  const describe = (c) => {
    const pname = providerLabel(c.a.provider, names);
    const startsNow = c.t <= now + STEP;
    const atEarliest = c.t <= notBefore + STEP;
    const why = [];
    if (startsNow) why.push('fits now');
    else if (atEarliest) why.push(`fits at ${stamp(c.t)}, the earliest asked for`);
    else why.push(`fits from ${stamp(c.t)}, ${c.after === 'week' ? 'once its weekly window resets' : c.after === 'five' ? 'once its 5-hour window resets' : 'once the projected use leaves room'}`);
    why.push(`${round1(c.five)}% of its 5-hour and ${round1(c.weekly)}% of its week left then (the job takes ~${round1(c.need5)}% and ~${round1(c.needW)}%)`);
    if (c.spare !== null && c.spare >= 5) why.push(`~${round1(c.spare)}% of its week would otherwise reset unused at ${stamp(c.weeklyReset)}`);
    return {
      provider: c.a.provider,
      providerName: pname,
      accountId: c.a.id,
      name: c.a.name,
      plan: c.a.plan,
      pooled: c.g.pooled,
      startsNow,
      atEarliest,
      startAt: stamp(c.t),
      startAtIso: new Date(c.t).toISOString(),
      startInHours: inH(c.t),
      fiveHourLeftPct: round1(c.five),
      weeklyLeftPct: round1(c.weekly),
      jobFiveHourPct: round1(c.need5),
      jobWeeklyPct: round1(c.needW),
      spareBeforeResetPct: c.spare === null ? null : round1(c.spare),
      why: why.join('; '),
    };
  };

  // Searched past the deadline too, so a miss can say when it would fit.
  const inTime = candidates.filter((c) => deadline === null || c.t <= deadline);
  const late = deadline !== null && !inTime.length && candidates.length ? describe(candidates[0]) : null;
  const best = inTime[0] ? describe(inTime[0]) : null;
  const seen = new Set(best ? [best.accountId] : []);
  const alternatives = [];
  for (const c of inTime.slice(1)) {
    if (seen.has(c.a.id)) continue;
    seen.add(c.a.id);
    alternatives.push(describe(c));
    if (alternatives.length >= 3) break;
  }

  const job = `a ${size ? `${size} ` : ''}job (~${round1(cost)}% of one 5-hour window on the largest plan)`;
  let summary;
  if (best) {
    const target = best.pooled ? `${best.providerName} through CLIProxy (likely ${best.name})` : `${best.providerName} (${best.name})`;
    summary = best.startsNow ? `Run ${job} now on ${target}.`
      : best.atEarliest ? `Run ${job} at ${best.startAt} (in ${best.startInHours} h), the earliest asked for, on ${target}.`
        : `Run ${job} at ${best.startAt} (in ${best.startInHours} h) on ${target}; nothing fits sooner.`;
    if (best.spareBeforeResetPct !== null && best.spareBeforeResetPct >= 5) summary += ` It uses capacity that would otherwise reset unused.`;
  } else if (tooBig.length && !candidates.length) {
    summary = `${job[0].toUpperCase()}${job.slice(1)} is bigger than one 5-hour window on every login: split it into smaller pieces.`;
  } else {
    summary = `Nothing fits ${job} ${deadline !== null ? `before ${stamp(deadline)}` : `in the next ${p.options.horizonHours} h`} at the current pace.`;
    if (late) summary += ` The first fit after that is ${late.startAt} (in ${late.startInHours} h) on ${late.providerName} (${late.name}).`;
  }

  return {
    timeZone: tz,
    now: stamp(now),
    job: {
      size,
      fiveHourPct: round1(cost),
      weeklyPct: opts.weeklyPct != null && finite(Number(opts.weeklyPct)) ? Number(opts.weeklyPct) : null,
      reservePct: reserve,
      notBefore: stamp(notBefore),
      deadline: stamp(deadline),
    },
    fits: Boolean(best),
    best,
    alternatives,
    afterDeadline: late,
    tooBig: tooBig.map(({ a, need5 }) => ({ accountId: a.id, name: a.name, jobFiveHourPct: round1(need5) })),
    summary,
    assumptions: {
      burnWindowHours: p.options.burnWindowHours,
      futureFactor: p.options.futureFactor,
      pace: p.options.pace,
      quietHours: p.options.quietHours ? `${p.options.quietHours.startHour}-${p.options.quietHours.endHour}` : null,
      offDays: p.options.offDays.map((d) => WEEKDAYS[d]),
    },
    method: [
      'Every login is stepped forward in 5-minute steps with everything else spending at its recent pace (see usage__forecast\'s method). The job fits a login at the first step where its 5-hour and weekly windows both hold the job plus the reserve left for the owner.',
      'The job\'s cost is pool percent: a share of one 5-hour window on the provider\'s largest plan. A smaller plan needs proportionally more of its own window; its weekly cost follows that login\'s weekly-per-5-hour ratio unless weeklyPct is given.',
      'At the same start time, the login whose weekly window would otherwise reset with capacity unused is preferred, then the one resetting soonest.',
      'Through CLIProxy the proxy picks the login per request, so a pooled answer names the login with room, not one you can force; "startsNow" with any pooled login means the pool has room.',
      'A job that runs longer than a 5-hour window, or a pace that changes, moves this answer: read it again just before starting.',
    ],
  };
}
