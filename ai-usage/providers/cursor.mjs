/**
 * Cursor accounts.
 *
 * Auth lives in `~/.config/cursor/auth.json` ({ accessToken, refreshToken }),
 * written by `cursor-agent login`. Quota comes from the same endpoint the
 * editor's usage panel calls.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, meter, fetchJson, expandHome, toEpochMs } from '../util.mjs';

const USAGE_URL = 'https://api2.cursor.sh/auth/usage-summary';

const PLAN_LABELS = {
  pro: 'Pro',
  pro_student: 'Pro (Student)',
  pro_plus: 'Pro+',
  ultra: 'Ultra',
  free: 'Free',
  free_trial: 'Free trial',
  team: 'Team',
  enterprise: 'Enterprise',
};

/**
 * Auto-discover Cursor auth files: the standard XDG location plus any
 * `.config/cursor/auth.json` living inside a `~/.t3-` profile directory.
 */
export async function discover() {
  const homeDir = process.env.HOME ?? '';
  const found = [];

  const consider = async (file, label) => {
    const auth = await readJson(file);
    if (!auth?.accessToken) return;
    found.push({ backend: 'cursor', authFile: file, label });
  };

  await consider(join(homeDir, '.config', 'cursor', 'auth.json'), 'cursor-default');

  let entries = [];
  try {
    entries = await readdir(homeDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.t3-')) continue;
    await consider(
      join(homeDir, entry.name, '.config', 'cursor', 'auth.json'),
      `${entry.name.replace(/^\./, '')}-cursor`,
    );
  }

  return found;
}

export async function fetchAccount(account) {
  const authFile = expandHome(account.authFile);
  const base = {
    id: `cursor:${account.label}`,
    backend: 'cursor',
    label: account.label,
    sourceFile: authFile.replace(process.env.HOME ?? '', '~'),
    fetchedAt: Date.now(),
    detailUrl: 'https://cursor.com/dashboard',
  };

  const auth = await readJson(authFile);
  if (!auth?.accessToken) {
    return { ...base, status: 'error', error: `No accessToken in ${authFile}` };
  }

  let data;
  try {
    data = await fetchJson(USAGE_URL, {
      headers: { authorization: `Bearer ${auth.accessToken}`, accept: 'application/json' },
    });
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      return {
        ...base,
        status: 'expired',
        error: 'Cursor token rejected. Re-login with: cursor-agent login',
      };
    }
    return { ...base, status: 'error', error: err.message };
  }

  const plan = data.individualUsage?.plan ?? {};
  const onDemand = data.individualUsage?.onDemand ?? {};
  const cycleEnd = toEpochMs(data.billingCycleEnd);
  const cycleStart = toEpochMs(data.billingCycleStart);
  // The billing cycle IS the window here, so its real length comes from the two
  // dates rather than a guessed 30 days — cycles are not all the same length.
  const cycle = cycleStart && cycleEnd ? { windowMinutes: Math.round((cycleEnd - cycleStart) / 60_000) } : {};

  const meters = [];
  if (plan.totalPercentUsed !== undefined && plan.totalPercentUsed !== null) {
    meters.push(meter('total', 'Included usage', plan.totalPercentUsed, cycleEnd, cycle));
  }
  if (plan.autoPercentUsed !== undefined && plan.autoPercentUsed !== null) {
    meters.push(meter('auto', 'Auto models', plan.autoPercentUsed, cycleEnd, cycle));
  }
  if (plan.apiPercentUsed !== undefined && plan.apiPercentUsed !== null) {
    meters.push(meter('api', 'Named API models', plan.apiPercentUsed, cycleEnd, cycle));
  }
  if (onDemand.enabled && onDemand.limit) {
    meters.push(meter('ondemand', 'On-demand', (onDemand.used / onDemand.limit) * 100, cycleEnd, cycle));
  }

  // Cursor is unusual: `isUnlimited` accounts still report percentages that
  // don't cap anything, so flag it rather than silently showing a red bar.
  const notes = [];
  if (data.isUnlimited) notes.push('Plan is unlimited');
  const breakdown = plan.breakdown ?? {};
  if (breakdown.total) {
    notes.push(
      `Credits: ${breakdown.included ?? 0} included${breakdown.bonus ? ` + ${breakdown.bonus} bonus` : ''} = ${breakdown.total}`,
    );
  }

  return {
    ...base,
    status: 'ok',
    fetchedAt: Date.now(),
    email: null,
    plan: PLAN_LABELS[data.membershipType] ?? data.membershipType ?? 'unknown',
    planDetail: data.limitType ? `${data.limitType} limit` : null,
    meters,
    notes,
    cycle:
      data.billingCycleStart && data.billingCycleEnd
        ? { start: toEpochMs(data.billingCycleStart), end: cycleEnd }
        : null,
    unlimited: Boolean(data.isUnlimited),
    usedUnits: plan.used ?? null,
    limitUnits: plan.limit ?? null,
  };
}

/** Cursor tokens are long-lived; a plain refetch is the only refresh needed. */
export async function forceRefresh(account) {
  await fetchAccount(account);
}
