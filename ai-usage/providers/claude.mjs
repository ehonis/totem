/**
 * Claude Code accounts.
 *
 * Each account is an isolated Claude home directory (see the `claude-t3-profiles`
 * skill). On Linux the login writes `<home>/.claude/.credentials.json`, but T3's
 * "Claude HOME path" field points at the flat config dir, which produces
 * `<home>/.credentials.json` instead. We accept either and use whichever
 * actually holds a `claudeAiOauth` block.
 */
import { readdir, stat } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { readJson, writeJsonAtomic, meter, fetchJson, expandHome } from '../util.mjs';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

// Public OAuth client id used by Claude Code itself. Extracted from the shipped
// binary rather than guessed; a wrong id makes refresh fail with invalid_client.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

const OAUTH_BETA = 'oauth-2025-04-20';
const USER_AGENT = 'ai-usage/1.0 (local quota dashboard)';

// Refresh once we are inside this window of the stated expiry, so a poll never
// races the token going stale mid-request.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const PLAN_LABELS = {
  max: 'Max',
  pro: 'Pro',
  team: 'Team',
  enterprise: 'Enterprise',
  free: 'Free',
};

/** Candidate credential paths for a profile home, in priority order. */
function credentialPaths(home) {
  return [join(home, '.credentials.json'), join(home, '.claude', '.credentials.json')];
}

/** Locate the credential file inside `home` that actually has an OAuth block. */
async function findCredentials(home) {
  for (const path of credentialPaths(home)) {
    const data = await readJson(path);
    if (data?.claudeAiOauth?.accessToken || data?.claudeAiOauth?.refreshToken) {
      return { path, data };
    }
  }
  return null;
}

/**
 * Config-file path (`.claude.json`) matching a given credentials location.
 *
 * `.claude.json` always sits *beside* the `.claude` directory, so when the
 * credentials live inside one we step up a level; for the flat T3 layout the
 * credentials dir is itself the config dir.
 */
function configPathFor(credPath) {
  const dir = dirname(credPath);
  return basename(dir) === '.claude'
    ? join(dirname(dir), '.claude.json')
    : join(dir, '.claude.json');
}

/**
 * Auto-discover Claude homes: the default `~/.claude`, plus any `~/.t3-*`
 * profile directory that carries Claude credentials.
 */
export async function discover() {
  const homeDir = process.env.HOME ?? '';
  const found = [];
  const seen = new Set();

  const consider = async (dir, label) => {
    if (seen.has(dir)) return;
    const creds = await findCredentials(dir);
    if (!creds) return;
    seen.add(dir);
    found.push({ backend: 'claude', home: dir, label });
  };

  await consider(join(homeDir, '.claude'), 'claude-default');

  let entries = [];
  try {
    entries = await readdir(homeDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^\.t3-.*claude/i.test(entry.name)) continue;
    await consider(join(homeDir, entry.name), entry.name.replace(/^\./, ''));
  }

  return found;
}

/**
 * Exchange the stored refresh token for a fresh access token and persist it.
 *
 * Anthropic rotates the refresh token on every use, so the write-back is not
 * optional: dropping the response would lock the profile out until re-login.
 * We merge into the existing file so sibling keys (mcpOAuth, etc.) survive.
 */
async function refreshToken(credPath, fileData) {
  const oauth = fileData.claudeAiOauth ?? {};
  if (!oauth.refreshToken) throw new Error('no refresh token stored');

  const res = await fetchJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  const updated = {
    ...oauth,
    accessToken: res.access_token ?? oauth.accessToken,
    refreshToken: res.refresh_token ?? oauth.refreshToken,
    expiresAt: res.expires_in ? Date.now() + res.expires_in * 1000 : oauth.expiresAt,
    scopes: res.scope ? res.scope.split(' ') : oauth.scopes,
  };
  if (res.subscription_type) updated.subscriptionType = res.subscription_type;

  await writeJsonAtomic(credPath, { ...fileData, claudeAiOauth: updated });
  return updated;
}

// How long each window is. Carried on the meter so consumers can reason about
// pace — "55% of the week in two days" needs to know the week is seven days, and
// `resets_at` alone only says when it ends.
const WINDOW_MINUTES = { session: 5 * 60, weekly_all: 7 * 24 * 60, weekly_scoped: 7 * 24 * 60 };

/** Turn the API's `limits[]` entries into UI meters, newest schema first. */
function metersFromPayload(payload) {
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  const meters = [];

  for (const limit of limits) {
    let label;
    if (limit.kind === 'session') {
      label = '5-hour limit';
    } else if (limit.kind === 'weekly_all') {
      label = '7-day limit';
    } else if (limit.kind === 'weekly_scoped') {
      const model = limit.scope?.model?.display_name;
      const surface = limit.scope?.surface;
      label = `7-day ${model ?? surface ?? 'scoped'}`;
    } else {
      label = String(limit.kind ?? 'limit').replace(/_/g, ' ');
    }
    meters.push(
      meter(`${limit.kind}:${limit.scope?.model?.display_name ?? ''}`, label, limit.percent, limit.resets_at, {
        severity: limit.severity ?? 'normal',
        isActive: Boolean(limit.is_active),
        windowMinutes: WINDOW_MINUTES[limit.kind] ?? null,
      }),
    );
  }

  // Fall back to the flat fields if `limits` is ever absent.
  if (meters.length === 0) {
    const flat = [
      ['five_hour', '5-hour limit', 5 * 60],
      ['seven_day', '7-day limit', 7 * 24 * 60],
      ['seven_day_opus', '7-day Opus', 7 * 24 * 60],
      ['seven_day_sonnet', '7-day Sonnet', 7 * 24 * 60],
    ];
    for (const [key, label, windowMinutes] of flat) {
      const entry = payload[key];
      if (entry?.utilization === undefined || entry?.utilization === null) continue;
      meters.push(meter(key, label, entry.utilization, entry.resets_at, { windowMinutes }));
    }
  }

  const extra = payload.extra_usage;
  if (extra?.is_enabled && extra.utilization !== null && extra.utilization !== undefined) {
    meters.push(meter('extra_usage', 'Extra usage', extra.utilization, null));
  }

  return meters;
}

/**
 * Fetch one Claude account. Refreshes the token when it is expired (or about to
 * be), and retries once on a 401 in case the stored expiry was optimistic.
 */
export async function fetchAccount(account) {
  const home = expandHome(account.home);
  const id = `claude:${account.label}`;
  const base = {
    id,
    backend: 'claude',
    label: account.label,
    sourceFile: null,
    fetchedAt: Date.now(),
  };

  const creds = await findCredentials(home);
  if (!creds) {
    return { ...base, status: 'error', error: `No Claude credentials under ${home}` };
  }
  base.sourceFile = creds.path.replace(process.env.HOME ?? '', '~');

  let oauth = creds.data.claudeAiOauth;
  let fileData = creds.data;
  let refreshed = false;

  const doRefresh = async () => {
    oauth = await refreshToken(creds.path, fileData);
    fileData = { ...fileData, claudeAiOauth: oauth };
    refreshed = true;
  };

  const expiresAt = Number(oauth.expiresAt ?? 0);
  if (!oauth.accessToken || (expiresAt && expiresAt - REFRESH_SKEW_MS <= Date.now())) {
    try {
      await doRefresh();
    } catch (err) {
      const detail = typeof err.body === 'object' ? JSON.stringify(err.body) : err.body;
      return {
        ...base,
        status: 'expired',
        error: `Token expired and refresh failed (${err.message}${detail ? `: ${detail}` : ''}). Re-login: HOME=${home} claude auth login`,
      };
    }
  }

  const request = () =>
    fetchJson(USAGE_URL, {
      headers: {
        authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': OAUTH_BETA,
        'user-agent': USER_AGENT,
        accept: 'application/json',
      },
    });

  let payload;
  try {
    payload = await request();
  } catch (err) {
    if (err.status === 401 && !refreshed) {
      try {
        await doRefresh();
        payload = await request();
      } catch (retryErr) {
        return {
          ...base,
          status: 'expired',
          error: `Unauthorized after refresh (${retryErr.message}). Re-login: HOME=${home} claude auth login`,
        };
      }
    } else {
      return { ...base, status: 'error', error: `${err.message}` };
    }
  }

  const config = await readJson(configPathFor(creds.path));
  const email = config?.oauthAccount?.emailAddress ?? null;
  const org = config?.oauthAccount?.organizationName ?? null;
  const subscription = oauth.subscriptionType ?? 'unknown';

  return {
    ...base,
    status: 'ok',
    fetchedAt: Date.now(),
    tokenRefreshed: refreshed,
    email,
    org,
    plan: PLAN_LABELS[subscription] ?? subscription,
    planDetail: oauth.rateLimitTier ?? null,
    meters: metersFromPayload(payload),
    detailUrl: 'https://claude.ai/settings/usage',
  };
}

/** Force a token refresh regardless of the stored expiry. */
export async function forceRefresh(account) {
  const home = expandHome(account.home);
  const creds = await findCredentials(home);
  if (!creds) throw new Error(`No Claude credentials under ${home}`);
  await refreshToken(creds.path, creds.data);
}
