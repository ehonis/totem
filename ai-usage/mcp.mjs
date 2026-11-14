/**
 * AI subscription usage for agents: the live meters, the recorded history and the
 * limit report (ai-usage/report.mjs). Read-only. The bridge registers these on
 * /mcp as totem_usage_*; the gateway re-serves them as usage__*.
 *
 * Nothing here can change a login, refresh a token or spend a vendor's rate limit:
 * get_current reads the poller's last snapshot, and the history is CLIProxy's own
 * record, read through the same management call the CLIProxy tab's graphs use.
 */

import {
  HISTORY_MAX_DAYS, clampDays, downsampleHistory, limitReport, localStamp, selectSamples, summarizeCurrent,
} from './report.mjs';
import { BURN_WINDOW_MAX_HOURS, FORECAST_DEFAULTS, HORIZON_MAX_HOURS, JOB_SIZES, PACES, buildForecast, buildPlan } from './forecast.mjs';

const READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const S = { type: 'string' };
const N = { type: 'number' };
const B = { type: 'boolean' };
const O = { type: 'object' };
const LIST = (description) => ({ type: 'array', items: O, description });
const output = (properties, required = []) => ({
  type: 'object', properties: { fetchedAt: S, ...properties }, required: ['fetchedAt', ...required],
});

const PROVIDER = { type: 'string', enum: ['claude', 'codex', 'cursor'], description: 'Only this provider.' };
const ACCOUNT = { type: 'string', description: 'Only this account: an accountId from usage__get_current or an earlier answer.' };
const days = (fallback) => ({
  type: 'number', minimum: 0.05, maximum: HISTORY_MAX_DAYS,
  description: `Days back from now, at most ${HISTORY_MAX_DAYS} (all CLIProxy keeps). Default ${fallback}.`,
});

const WHEN = 'Use for questions about AI subscription usage, quotas, rate limits or hitting limits (Claude, Codex, Cursor).';
const SCHEDULE = 'Use before scheduling or starting AI work (a totem, a job, sub-agents, a long run) to pick when and on which provider it fits.';

// The forecast's tuning, shared by both forecast tools. Defaults match the CLIProxy tab's graphs.
const FORECAST_INPUTS = {
  burnWindowHours: {
    type: 'number', minimum: 1, maximum: BURN_WINDOW_MAX_HOURS,
    description: `Hours of readings the pace is measured over. Default ${FORECAST_DEFAULTS.burnWindowHours}, as the dashboard's graphs; 24 smooths a bursty day.`,
  },
  pace: {
    type: 'string', enum: [...PACES],
    description: 'Which pace to project: blend (default) runs the recent pace for 5 h, then each login\'s 7-day average; recent runs the recent pace throughout, as the dashboard\'s graphs (pessimistic past a few hours); week runs the 7-day average.',
  },
  futureFactor: { type: 'number', minimum: 0, maximum: 5, description: 'Multiply the measured pace from now on: 1 same (default), 2 double, 0.5 half, 0 nothing else runs.' },
  quietHours: { type: 'string', description: 'A nightly block with no use, in the owner\'s local hours, "start-end" (e.g. "23-7"). Default none: the pace runs around the clock.' },
  offDays: { type: 'array', items: { type: ['string', 'number'] }, description: 'Weekdays with no use: "Sat", "Sun" or 0–6 (0 = Sunday).' },
};
const TIME = { type: 'string', description: 'An ISO time with an offset, or "YYYY-MM-DD HH:MM" in the owner\'s time zone.' };

export const USAGE_MCP_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'totem_usage_get_current',
    title: 'Read AI usage now',
    description:
      `${WHEN} Every account Totem tracks right now: its provider, name and plan, each quota window's used %, `
      + 'when it resets (owner\'s local time) and its status (spent, low, ok, or no data), the account\'s state, and '
      + 'per provider how many accounts can still serve. A meter with no reading is "no data", never 0%.',
    inputSchema: { type: 'object', properties: { provider: PROVIDER }, additionalProperties: false },
    annotations: READ,
    outputSchema: output({
      timeZone: S,
      now: S,
      updatedAt: { type: ['string', 'null'], description: 'When the poller last read the vendors.' },
      firstPollPending: B,
      thresholds: O,
      proxy: O,
      accounts: LIST('{ id, provider, providerName, name, plan, source, state, headroomPct, limitedUntil, stale, error, readAt, meters[{ key, label, scope, usedPct, remainingPct, resetsAt, status }], summary }'),
      pools: LIST('Per provider: { accounts, usable, limited, errors, disabled, bestHeadroomPct, nextBackAt }'),
      error: S,
    }, ['accounts']),
  },
  {
    name: 'totem_usage_get_history',
    title: 'Read AI usage history',
    description:
      `${WHEN} Recorded quota readings for the CLIProxy Claude and Codex logins over the last days (default 7, at most `
      + `${HISTORY_MAX_DAYS}), per account, bucketed so the answer stays small: each point is the highest used % of each `
      + 'window in that bucket. Cursor and logins outside CLIProxy have no history. For how often a cap was hit, call '
      + 'usage__limit_report instead of counting points.',
    inputSchema: {
      type: 'object',
      properties: {
        days: days(7),
        provider: { ...PROVIDER, enum: ['claude', 'codex'] },
        accountId: ACCOUNT,
        maxPoints: { type: 'number', minimum: 50, maximum: 2000, description: 'Rough cap on points across all accounts. Default 400.' },
      },
      additionalProperties: false,
    },
    annotations: READ,
    outputSchema: output({
      supported: B,
      reason: S,
      timeZone: S,
      range: O,
      bucketMinutes: N,
      accounts: LIST('{ accountId, provider, providerName, name, windows{ id: { label, minutes, scope } }, readings, firstReading, lastReading, points[{ at, <window>: used % }] }'),
    }, ['supported']),
  },
  {
    name: 'totem_usage_limit_report',
    title: 'Report AI usage limit hits',
    description:
      `${WHEN} Evidence for "where am I hitting limits, on which account, how often": per account and window, how many `
      + 'times the cap was reached (one per window period, not per reading), when, how long it stayed blocked until the '
      + 'reset, total blocked hours, peak and average peak %, busiest days and hours; per provider, how long every account '
      + 'was capped at once; what the data covers (range, gaps, accounts with no history) and how it was counted. Lead '
      + 'with its `summary` lines and keep `method` with any figure you pass on. Default the last 21 days.',
    inputSchema: {
      type: 'object',
      properties: { days: days(HISTORY_MAX_DAYS), provider: { ...PROVIDER, enum: ['claude', 'codex'] }, accountId: ACCOUNT },
      additionalProperties: false,
    },
    annotations: READ,
    outputSchema: output({
      supported: B,
      reason: S,
      timeZone: S,
      range: O,
      thresholds: O,
      summary: { type: 'array', items: S, description: 'One plain-English line per account.' },
      accounts: LIST('{ accountId, provider, providerName, name, coverage, windows[{ window, label, scope, periodsUsed, hits, blockedHours, peakPct, avgPeakPct, recentHits[] }], totalBlockedHours, busiest, summary }'),
      providers: LIST('{ provider, accountsWithHistory, capHits, accountBlockedHours, allAccountsBlockedHours, summary }'),
      noHistory: LIST('Accounts tracked live with no recorded history, and why.'),
      method: { type: 'array', items: S, description: 'How every figure was counted. Pass it on with the numbers.' },
    }, ['supported']),
  },
  {
    name: 'totem_usage_forecast',
    title: 'Forecast AI usage',
    description:
      `${WHEN} ${SCHEDULE} Projects every Claude and Codex login forward at its recent pace (the same model as the `
      + 'dashboard\'s CLIProxy graphs): per login, each 5-hour and weekly window\'s % left, reset, pace in %/h, when it runs '
      + 'out before its reset, and how much would reset unused (spare a scheduled job can take at no cost); per provider, '
      + 'the pool\'s pace, when every login is capped at once and for how long, and the spare to use before resets. Lead '
      + 'with `summary`, and keep `method` with any figure you pass on. Default horizon 7 days.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { ...PROVIDER, enum: ['claude', 'codex'] },
        horizonHours: { type: 'number', minimum: 1, maximum: HORIZON_MAX_HOURS, description: `How far ahead, in hours. Default ${FORECAST_DEFAULTS.horizonHours}.` },
        ...FORECAST_INPUTS,
      },
      additionalProperties: false,
    },
    annotations: READ,
    outputSchema: output({
      timeZone: S,
      now: S,
      historyNote: S,
      horizon: O,
      assumptions: O,
      summary: { type: 'array', items: S, description: 'One line per provider pool or standalone login.' },
      providers: LIST('{ provider, pooled, accounts[], capacityPoolPct, usableNowPoolPct, pacePoolPctPerHour, weekAveragePoolPctPerHour, allCappedAt, allCappedInHours, blockedSpans[{ from, to, fromInHours, hours }], unservedPoolPct, spare[{ accountId, name, pct, before }], summary }'),
      accounts: LIST('{ accountId, provider, name, plan, source, pooled, poolShare, state, usableNowPct, binding, weeklyPerFiveHourPoint, windows[{ window, remainingPct, resetsAt, resetsInHours, startsOnFirstUse, pacePctPerHour, weekAveragePctPerHour, spentNow, runsOutAt, runsOutInHours, unusedAtResetPct }], modelCaps[], spareBeforeResetPct, fiveHourSparePct, summary }'),
      unprojected: LIST('Logins with nothing to project (switched off, or a monthly cycle like Cursor), with their windows.'),
      method: { type: 'array', items: S, description: 'How the projection was made. Pass it on with the numbers.' },
      error: S,
    }, ['summary', 'providers', 'accounts']),
  },
  {
    name: 'totem_usage_plan',
    title: 'Plan when AI work fits',
    description:
      `${SCHEDULE} Given a job's size, says when it fits and on which provider and login, with everything else projected `
      + 'at its recent pace and a reserve left for the owner: now if there is room, otherwise the first time a reset makes '
      + 'room, preferring a login whose week would otherwise reset unused. Sizes are shares of one 5-hour window on the '
      + `provider's largest plan: small ${JOB_SIZES.small}% (a quick single-agent task), medium ${JOB_SIZES.medium}% (a focused `
      + `multi-step coding task, default), large ${JOB_SIZES.large}% (several sub-agents or a long session), full ${JOB_SIZES.full}% `
      + '(a whole window); or give fiveHourPct. Returns `best` (startAt local, startAtIso for a scheduler, startsNow), up '
      + 'to three alternatives and `summary`. A job bigger than one window comes back as tooBig: split it. Re-check just '
      + 'before starting; the answer moves with the pace.',
    inputSchema: {
      type: 'object',
      properties: {
        size: { type: 'string', enum: Object.keys(JOB_SIZES), description: 'How big the job is. Default medium.' },
        fiveHourPct: { type: 'number', minimum: 0.5, maximum: 1000, description: 'The job\'s cost as % of one 5-hour window on the largest plan; overrides size.' },
        weeklyPct: { type: 'number', minimum: 0, maximum: 100, description: 'The job\'s cost as % of a login\'s week, if known; otherwise derived from its 5-hour cost.' },
        provider: { ...PROVIDER, enum: ['claude', 'codex'], description: 'Only this provider. Default: whichever fits first.' },
        accountId: ACCOUNT,
        reservePct: { type: 'number', minimum: 0, maximum: 90, description: 'Points of a 5-hour window to leave for the owner. Default 10.' },
        notBefore: TIME,
        afterHours: { type: 'number', minimum: 0, maximum: HORIZON_MAX_HOURS, description: 'Not before this many hours from now (instead of notBefore).' },
        deadline: TIME,
        withinHours: { type: 'number', minimum: 0.1, maximum: HORIZON_MAX_HOURS, description: 'Must start within this many hours (instead of deadline).' },
        horizonHours: { type: 'number', minimum: 1, maximum: HORIZON_MAX_HOURS, description: `How far ahead to look. Default ${FORECAST_DEFAULTS.horizonHours}.` },
        ...FORECAST_INPUTS,
      },
      additionalProperties: false,
    },
    annotations: READ,
    outputSchema: output({
      timeZone: S,
      now: S,
      historyNote: S,
      job: O,
      fits: B,
      best: { type: ['object', 'null'], description: '{ provider, accountId, name, plan, pooled, startsNow, atEarliest, startAt, startAtIso, startInHours, fiveHourLeftPct, weeklyLeftPct, jobFiveHourPct, jobWeeklyPct, spareBeforeResetPct, why }' },
      alternatives: LIST('Other logins, same shape as best, earliest first.'),
      afterDeadline: { type: ['object', 'null'], description: 'When nothing fits before the deadline: the first fit after it, same shape as best.' },
      tooBig: LIST('Logins where the job is more than one 5-hour window.'),
      summary: S,
      assumptions: O,
      method: { type: 'array', items: S },
      error: S,
    }, ['fits', 'summary']),
  },
]);

const HISTORY_TTL_MS = 60_000;

/**
 * `snapshot()` answers what /api/ai-usage does. `history()` answers CLIProxy's
 * normalised history ({ supported, samples }). `accounts()` lists every account the
 * poller knows, hidden ones included, so history can be named. `configured()` says
 * whether CLIProxy is set up. `redact` scrubs error text.
 */
export function createUsageMcpTools({
  snapshot, history, accounts = () => [], configured = () => true, tz = 'UTC',
  now = () => Date.now(), redact = (s) => s,
} = {}) {
  if (typeof snapshot !== 'function') throw new TypeError('createUsageMcpTools requires snapshot');
  if (typeof history !== 'function') throw new TypeError('createUsageMcpTools requires history');
  const zone = () => (typeof tz === 'function' ? tz() : tz);

  // A report and a history call in one turn read the proxy once.
  let cached = null;
  async function readHistory() {
    const at = now();
    if (cached && at - cached.at < HISTORY_TTL_MS) return cached.value;
    const value = await history();
    cached = { at, value };
    return value;
  }

  const names = () => new Map((accounts() || []).map((a) => [a.id, String(a.displayName || a.label || a.id)]));

  async function samplesFor(input, fallbackDays) {
    if (!configured()) {
      return { reason: 'CLIProxy is not set up, so no usage history is recorded. usage__get_current has the live readings.' };
    }
    let body;
    try {
      body = await readHistory();
    } catch (err) {
      return { reason: `CLIProxy's history could not be read: ${redact(String(err?.message || err)).slice(0, 200)}` };
    }
    if (!body?.supported) {
      return { reason: 'This CLIProxy keeps no quota history (no /quota/history endpoint), so only live readings exist.' };
    }
    const to = now();
    const from = to - clampDays(input.days, fallbackDays) * 86400_000;
    const provider = input.provider === 'claude' || input.provider === 'codex' ? input.provider : null;
    const accountId = typeof input.accountId === 'string' && input.accountId.trim() ? input.accountId.trim() : null;
    return { from, to, samples: selectSamples(body.samples, { from, to, provider, accountId }), provider, accountId };
  }

  // The forecast reads the live snapshot plus a week of history: the pace needs a few
  // hours, the weekly-per-5-hour ratio the week. Without history every login is idle.
  async function forecastInputs() {
    const snap = await snapshot();
    const got = await samplesFor({ days: 7 }, 7);
    if (got.reason) return { snap, samples: [], note: `${got.reason} So every login is projected idle: resets and what is left now are real, the pace is not.` };
    return { snap, samples: got.samples, note: null };
  }
  const forecastOptions = (input) => ({
    now: now(), tz: zone(),
    burnWindowHours: input.burnWindowHours, futureFactor: input.futureFactor, horizonHours: input.horizonHours, pace: input.pace,
    quietHours: input.quietHours, offDays: input.offDays,
  });
  const withState = (out, snap, note) => ({
    ...out,
    ...(note ? { historyNote: note } : {}),
    ...(snap?.ok === false ? { error: redact(String(snap.error || 'AI usage polling is unavailable')) } : {}),
  });

  return {
    async totem_usage_get_current(input = {}) {
      const snap = await snapshot();
      const provider = ['claude', 'codex', 'cursor'].includes(input.provider) ? input.provider : null;
      const out = summarizeCurrent(snap, { tz: zone(), now: now(), provider, redact });
      return snap?.ok === false ? { ...out, error: redact(String(snap.error || 'AI usage polling is unavailable')) } : out;
    },

    async totem_usage_get_history(input = {}) {
      const got = await samplesFor(input, 7);
      if (got.reason) return { supported: false, reason: got.reason, accounts: [] };
      const maxPoints = Math.min(2000, Math.max(50, Number(input.maxPoints) || 400));
      const { bucketMinutes, accounts: list } = downsampleHistory(got.samples, { from: got.from, to: got.to, tz: zone(), names: names(), maxPoints });
      const range = { from: localStamp(got.from, zone()), to: localStamp(got.to, zone()), days: Math.round((got.to - got.from) / 8640_000) / 10 };
      return { supported: true, timeZone: zone() || 'UTC', range, bucketMinutes, accounts: list };
    },

    async totem_usage_forecast(input = {}) {
      const { snap, samples, note } = await forecastInputs();
      const out = buildForecast(snap, samples, { ...forecastOptions(input), provider: ['claude', 'codex'].includes(input.provider) ? input.provider : null });
      return withState(out, snap, note);
    },

    async totem_usage_plan(input = {}) {
      const { snap, samples, note } = await forecastInputs();
      const out = buildPlan(snap, samples, {
        ...forecastOptions(input),
        size: input.size,
        fiveHourPct: input.fiveHourPct,
        weeklyPct: input.weeklyPct,
        provider: input.provider,
        accountId: input.accountId,
        reservePct: input.reservePct,
        notBefore: input.notBefore,
        afterHours: input.afterHours,
        deadline: input.deadline,
        withinHours: input.withinHours,
      });
      return withState(out, snap, note);
    },

    async totem_usage_limit_report(input = {}) {
      const got = await samplesFor(input, HISTORY_MAX_DAYS);
      if (got.reason) return { supported: false, reason: got.reason, summary: [got.reason], accounts: [], providers: [], noHistory: [], method: [] };
      const snap = await snapshot().catch(() => null);
      const known = (accounts() || []).filter((a) => (!got.provider || a.backend === got.provider) && (!got.accountId || a.id === got.accountId));
      const report = limitReport(got.samples, {
        from: got.from, to: got.to, now: now(), tz: zone(), names: names(), known, providerNames: snap?.providers || {},
      });
      return { supported: true, ...report };
    },
  };
}
