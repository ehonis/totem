/**
 * Codex (ChatGPT) accounts.
 *
 * Codex has no read-only usage HTTP endpoint — `chatgpt.com/backend-api/codex/*`
 * returns the web app shell for GETs. The supported path is the app-server:
 * a JSON-RPC-over-stdio service shipped with the CLI that exposes
 * `account/rateLimits/read`. It reuses the login in $CODEX_HOME, so pointing
 * CODEX_HOME at a different profile dir reads a different account.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, meter, windowLabel, expandHome } from '../util.mjs';

const RPC_TIMEOUT_MS = 30000;

/**
 * Run one app-server session and return the results of the given methods.
 *
 * The process is short-lived: spawn, handshake, ask, kill. That keeps a hung
 * or crashed CLI from leaking into subsequent poll cycles.
 */
function callAppServer(codexHome, methods, { binary = 'codex' } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, ['app-server'], {
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (err) {
      resolve({ error: `could not start ${binary}: ${err.message}` });
      return;
    }

    const results = new Map();
    let settled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(payload);
    };

    const timer = setTimeout(
      () => finish({ error: `app-server timed out after ${RPC_TIMEOUT_MS / 1000}s` }),
      RPC_TIMEOUT_MS,
    );

    child.on('error', (err) => finish({ error: `could not start ${binary}: ${err.message}` }));
    child.on('exit', (code) => {
      if (!settled) finish({ error: `app-server exited early (code ${code})` });
    });

    const send = (obj) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(obj)}\n`);
    };

    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 1) {
        // Handshake acknowledged — now ask for the data we actually want.
        send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        methods.forEach((method, i) => {
          send({ jsonrpc: '2.0', id: i + 2, method, params: null });
        });
        return;
      }
      if (typeof msg.id === 'number' && msg.id >= 2) {
        const method = methods[msg.id - 2];
        results.set(method, msg.error ? { error: msg.error } : msg.result);
        if (results.size === methods.length) finish({ results });
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'ai-usage', title: 'ai-usage', version: '1.0.0' } },
    });
  });
}

/** Auto-discover Codex homes: `~/.codex` plus any `.codex` inside a `~/.t3-` profile. */
export async function discover() {
  const homeDir = process.env.HOME ?? '';
  const found = [];

  const consider = async (dir, label) => {
    const auth = await readJson(join(dir, 'auth.json'));
    if (!auth?.tokens?.access_token && !auth?.OPENAI_API_KEY) return;
    found.push({ backend: 'codex', home: dir, label });
  };

  await consider(join(homeDir, '.codex'), 'codex-default');

  let entries = [];
  try {
    entries = await readdir(homeDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.t3-')) continue;
    await consider(join(homeDir, entry.name, '.codex'), `${entry.name.replace(/^\./, '')}-codex`);
  }

  return found;
}

/** Build meters from one `rateLimits` block (primary = burst, secondary = long). */
function metersFromRateLimits(rl) {
  const meters = [];
  for (const [key, window] of [
    ['primary', rl.primary],
    ['secondary', rl.secondary],
  ]) {
    if (!window || window.usedPercent === null || window.usedPercent === undefined) continue;
    meters.push(
      meter(key, windowLabel(window.windowDurationMins), window.usedPercent, window.resetsAt, {
        windowMinutes: Number(window.windowDurationMins) || null,
      }),
    );
  }
  return meters;
}

export async function fetchAccount(account) {
  const home = expandHome(account.home);
  const base = {
    id: `codex:${account.label}`,
    backend: 'codex',
    label: account.label,
    sourceFile: join(home, 'auth.json').replace(process.env.HOME ?? '', '~'),
    fetchedAt: Date.now(),
    detailUrl: 'https://chatgpt.com/codex/settings/usage',
  };

  const auth = await readJson(join(home, 'auth.json'));
  if (!auth) {
    return { ...base, status: 'error', error: `No Codex auth at ${home}/auth.json` };
  }

  const { results, error } = await callAppServer(home, ['account/rateLimits/read']);
  if (error) return { ...base, status: 'error', error };

  const payload = results.get('account/rateLimits/read');
  if (payload?.error) {
    const message = payload.error.message ?? JSON.stringify(payload.error);
    const expired = /auth|login|token|401/i.test(message);
    return {
      ...base,
      status: expired ? 'expired' : 'error',
      error: expired ? `${message}. Re-login: CODEX_HOME=${home} codex login` : message,
    };
  }

  const rl = payload?.rateLimits;
  if (!rl) return { ...base, status: 'error', error: 'app-server returned no rateLimits' };

  const email = decodeEmail(auth.tokens?.id_token);
  const credits = rl.credits ?? {};

  return {
    ...base,
    status: 'ok',
    fetchedAt: Date.now(),
    email,
    plan: rl.planType ? `ChatGPT ${rl.planType}` : 'ChatGPT',
    planDetail: rl.limitName ?? null,
    meters: metersFromRateLimits(rl),
    notes: [
      credits.unlimited
        ? 'Credits: unlimited'
        : credits.hasCredits
          ? `Credits: ${credits.balance ?? '0'}`
          : null,
      rl.rateLimitReachedType ? `Rate limited: ${rl.rateLimitReachedType}` : null,
    ].filter(Boolean),
  };
}

/** Pull the account email out of the stored ChatGPT id_token, best-effort. */
function decodeEmail(idToken) {
  if (!idToken) return null;
  try {
    const part = idToken.split('.')[1];
    const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return json.email ?? json.preferred_username ?? null;
  } catch {
    return null;
  }
}

/**
 * Codex refreshes its own tokens inside the app-server on demand, so a plain
 * read is already the refresh path. No separate write-back is needed.
 */
export async function forceRefresh(account) {
  await fetchAccount(account);
}
