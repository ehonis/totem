import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic, expandHome } from './util.mjs';
import * as claude from './providers/claude.mjs';
import * as codex from './providers/codex.mjs';
import * as cursor from './providers/cursor.mjs';

export const PROVIDERS = { claude, codex, cursor };

// Everything the dashboard's "AI usage settings" panel writes lives here: which
// profiles to poll, what to call them, and the subscription overrides the
// Subscriptions cards render. There is no port/host here any more — this runs
// inside the bridge, so it has no socket of its own.
const CONFIG_PATH = fileURLToPath(new URL('../data/ai-usage.json', import.meta.url));

const DEFAULTS = {
  pollIntervalSeconds: 90,
  autoDiscover: true,
  accounts: [],
  hidden: [],
  // `${backend}:${label}` -> what to call that profile in the UI. A profile's
  // label is its directory name ("t3-claude-work"), which is a lousy card title.
  accountNames: {},
  // Per-service display + subscription overrides, keyed by backend id:
  // { name, hidden, priceUsd, renewsAt, plan }. Anything unset falls back to
  // what the vendor/local files report.
  providers: {},
  // Claude quota polling (providers/claude.mjs) calls an undocumented Anthropic
  // endpoint and refreshes Claude Code's own OAuth login with the client id baked
  // into the Claude Code binary, writing the rotated token back to its credentials
  // file. Off unless asked for: AI_USAGE_CLAUDE_OAUTH=true, this setting, or an
  // install that already had it running (see ensureUsageOptIns).
  claudeOAuthUsage: false,
  // Cursor quota polling (providers/cursor.mjs) calls Cursor's private, undocumented
  // usage endpoint with the token cursor-agent stores. Same rules: AI_USAGE_CURSOR,
  // this setting, or an install that already had it running.
  cursorUsage: false,
};

// The opt-in pollers: stored setting key -> env var that overrides it.
export const USAGE_OPT_INS = Object.freeze({
  claudeOAuthUsage: 'AI_USAGE_CLAUDE_OAUTH',
  cursorUsage: 'AI_USAGE_CURSOR',
});

function optInEnabled(config, key) {
  const env = String(process.env[USAGE_OPT_INS[key]] ?? '').trim().toLowerCase();
  if (/^(1|true|yes|on)$/.test(env)) return true;
  if (/^(0|false|no|off)$/.test(env)) return false;
  return config?.[key] === true;
}

/** Is the setting forced by its env var (so the dashboard toggle is read-only)? */
export function optInFromEnv(key) {
  return Boolean(String(process.env[USAGE_OPT_INS[key]] ?? '').trim());
}

/** Is Claude quota polling on? The env var wins over the stored setting. */
export const claudeOAuthEnabled = (config) => optInEnabled(config, 'claudeOAuthUsage');
/** Is Cursor quota polling on? The env var wins over the stored setting. */
export const cursorUsageEnabled = (config) => optInEnabled(config, 'cursorUsage');

/**
 * Record each opt-in poller's default once. An install that existed before the
 * setting did keeps it on (it was always on); a fresh one starts with it off.
 * `existingInstall` must be judged before this process created any data.
 *
 * A key added later inherits an already-recorded sibling's value rather than
 * re-judging the install: by then the config file exists, which would make a
 * fresh install that has booted once look like an old one.
 */
export async function ensureUsageOptIns({ existingInstall }) {
  const file = (await readJson(configPath())) ?? null;
  const recorded = Object.keys(USAGE_OPT_INS).filter((key) => file && Object.hasOwn(file, key));
  const inherited = recorded.length ? file[recorded[0]] === true : Boolean(existingInstall);
  const missing = Object.keys(USAGE_OPT_INS).filter((key) => !recorded.includes(key));
  const next = { ...(file ?? {}) };
  for (const key of missing) next[key] = inherited;
  if (missing.length) await writeJsonAtomic(configPath(), next);
  return Object.fromEntries(Object.keys(USAGE_OPT_INS).map((key) => [key, next[key] === true]));
}

/** Default display name for a backend when the config doesn't override it. */
export const BACKEND_NAMES = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };

export const configPath = () => process.env.AI_USAGE_CONFIG ?? CONFIG_PATH;

/** Load the config file, falling back to defaults for anything unset. */
export async function loadConfig() {
  const file = (await readJson(configPath())) ?? {};
  return { ...DEFAULTS, ...file };
}

/** Persist a whole config object (already validated by the caller). */
export async function saveConfig(config) {
  await writeJsonAtomic(configPath(), { ...DEFAULTS, ...config });
  return loadConfig();
}

/** Display name for one service (backend), honouring the config override. */
export function providerName(config, backend) {
  const custom = config?.providers?.[backend]?.name;
  return (typeof custom === 'string' && custom.trim()) || BACKEND_NAMES[backend] || backend;
}

/**
 * Every account this box knows about — auto-discovered profiles plus anything
 * explicitly configured — annotated but *not* filtered. `hidden` is a flag here
 * so the settings panel can list what it's hiding; `resolveAccounts` is the one
 * that actually drops them.
 */
export async function collectAccounts(config) {
  const accounts = [];

  const off = new Set([
    ...(claudeOAuthEnabled(config) ? [] : ['claude']),
    ...(cursorUsageEnabled(config) ? [] : ['cursor']),
  ]);
  if (config.autoDiscover) {
    for (const [backend, provider] of Object.entries(PROVIDERS)) {
      if (off.has(backend)) continue;
      try {
        for (const found of await provider.discover()) {
          accounts.push({ ...found, backend, discovered: true });
        }
      } catch (err) {
        console.error(`[registry] discovery failed for ${backend}: ${err.message}`);
      }
    }
  }

  for (const entry of config.accounts ?? []) {
    if (off.has(entry.backend)) continue;
    if (!PROVIDERS[entry.backend]) {
      console.error(`[registry] unknown backend "${entry.backend}" in ai-usage.json`);
      continue;
    }
    const normalized = { ...entry, discovered: false };
    if (normalized.home) normalized.home = expandHome(normalized.home);
    if (normalized.authFile) normalized.authFile = expandHome(normalized.authFile);
    const idx = accounts.findIndex(
      (a) => a.backend === normalized.backend && a.label === normalized.label,
    );
    if (idx >= 0) accounts[idx] = { ...accounts[idx], ...normalized };
    else accounts.push(normalized);
  }

  const hidden = new Set(config.hidden ?? []);
  const names = config.accountNames ?? {};
  return accounts.map((a) => {
    const id = `${a.backend}:${a.label}`;
    return {
      ...a,
      id,
      displayName: (typeof names[id] === 'string' && names[id].trim()) || a.label,
      // A service hidden as a whole takes its profiles with it.
      hidden: hidden.has(id) || hidden.has(a.label) || Boolean(config.providers?.[a.backend]?.hidden),
    };
  });
}

/** The accounts the poller should actually fetch: everything not hidden. */
export async function resolveAccounts(config) {
  return (await collectAccounts(config)).filter((a) => !a.hidden);
}

/** Fetch a single account through its provider, never throwing. */
export async function fetchAccount(account) {
  const displayName = account.displayName || account.label;
  const provider = PROVIDERS[account.backend];
  if (!provider) {
    return {
      id: `${account.backend}:${account.label}`,
      backend: account.backend,
      label: account.label,
      displayName,
      status: 'error',
      error: `No provider for backend "${account.backend}"`,
      fetchedAt: Date.now(),
    };
  }
  try {
    return { ...(await provider.fetchAccount(account)), displayName };
  } catch (err) {
    return {
      id: `${account.backend}:${account.label}`,
      backend: account.backend,
      label: account.label,
      displayName,
      status: 'error',
      error: err.message,
      fetchedAt: Date.now(),
    };
  }
}
