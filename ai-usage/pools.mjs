/**
 * What each account can still serve, and what each provider's accounts add up to.
 *
 * Computed once in the poller so the pills, the quick panel, the CLIProxy tab,
 * the phone and the nudges all read the same answer.
 *
 * An account's headroom is its tightest *all-models* window (the 5-hour and the
 * weekly one), not the 5-hour alone: an account spent for the week has a fresh
 * 5-hour window and still serves nothing. Model-scoped windows (a weekly Fable or
 * Opus cap) and extra usage only badge the account.
 *
 * State, first match wins:
 *   disabled  switched off in the proxy
 *   error     could not be read, or its login needs signing in again
 *   limited   a main window is spent, or the proxy is cooling the whole login down
 *   low       under 25% left
 *   ok
 *
 * A provider's pool answers "can I keep working": the best usable account's
 * headroom, how many of its accounts are usable, and when the first limited one
 * comes back.
 */

export const SPENT_PCT = 99;
export const LOW_LEFT_PCT = 25;

/** Windows that cap one model or surface rather than the whole account. */
export function isScopedMeter(meter) {
  const key = String(meter?.key ?? '');
  return /^(weekly_scoped|seven_day_(opus|sonnet|oauth_apps|cowork)|extra_usage)/.test(key);
}

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

export function annotateAccount(account, now = Date.now()) {
  const meters = (account.meters || []).filter((m) => finite(m.remainingPct) && !isScopedMeter(m));
  const headroomPct = meters.length ? Math.min(...meters.map((m) => m.remainingPct)) : null;
  // An unlimited plan's included usage running out caps nothing.
  const spent = meters.filter((m) => 100 - m.remainingPct >= SPENT_PCT && !m.unlimited && !account.unlimited);
  const cooldownUntil = finite(account.cooldownUntil) && account.cooldownUntil > now ? account.cooldownUntil : null;

  let state = 'ok';
  let limitedUntil = null;
  if (account.disabled) state = 'disabled';
  else if (account.status && account.status !== 'ok' && !account.stale) state = 'error';
  else if (account.authProblem) state = 'error';
  else if (spent.length || cooldownUntil) {
    state = 'limited';
    const backs = [...spent.map((m) => m.resetsAt).filter(finite), ...(cooldownUntil ? [cooldownUntil] : [])];
    // Back when every spent window has refilled and the cooldown is over.
    limitedUntil = backs.length ? Math.max(...backs) : null;
  } else if (headroomPct !== null && headroomPct < LOW_LEFT_PCT) state = 'low';

  return {
    ...account,
    headroomPct: headroomPct === null ? null : Math.round(headroomPct * 10) / 10,
    state,
    limitedUntil,
  };
}

const usable = (a) => a.state === 'ok' || a.state === 'low';

/** One entry per backend that has at least one account. */
export function buildPools(accounts) {
  const byBackend = new Map();
  for (const account of accounts) {
    if (!byBackend.has(account.backend)) byBackend.set(account.backend, []);
    byBackend.get(account.backend).push(account);
  }
  const pools = [];
  for (const [backend, list] of byBackend) {
    const live = list.filter(usable);
    const best = live
      .filter((a) => finite(a.headroomPct))
      .reduce((top, a) => (!top || a.headroomPct > top.headroomPct ? a : top), null);
    const backs = list.filter((a) => a.state === 'limited' && finite(a.limitedUntil)).map((a) => a.limitedUntil);
    pools.push({
      backend,
      total: list.length,
      usable: live.length,
      bestId: best?.id ?? null,
      headroomPct: best ? best.headroomPct : null,
      nextBackAt: backs.length ? Math.min(...backs) : null,
      limited: list.filter((a) => a.state === 'limited').length,
      errors: list.filter((a) => a.state === 'error').length,
      disabled: list.filter((a) => a.state === 'disabled').length,
      proxied: list.some((a) => a.source === 'cliproxy'),
    });
  }
  return pools;
}
