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
