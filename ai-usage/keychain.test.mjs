import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CLAUDE_SERVICE, CURSOR_ACCESS_SERVICE, setKeychainRunner } from './keychain.mjs';
import * as claude from './providers/claude.mjs';
import * as cursor from './providers/cursor.mjs';

// A Mac with no credential files: everything lives in a fake Keychain.
async function onFakeMac(items, fn) {
  const home = await mkdtemp(join(tmpdir(), 'usage-kc-'));
  const saved = { home: process.env.HOME, user: process.env.USER, platform: process.platform, fetch: globalThis.fetch };
  const calls = [];
  const prev = setKeychainRunner(async (args, input) => {
    calls.push({ args, input });
    const service = args[args.indexOf('-s') + 1];
    if (args[0] === 'find-generic-password') {
      if (!(service in items)) throw Object.assign(new Error('not found'), { code: 44 });
      return `${items[service]}\n`;
    }
    if (args[0] === 'add-generic-password') {
      const [first, second] = String(input).split('\n');
      assert.equal(first, second, 'security asks for the value twice');
      items[service] = first;
      return '';
    }
    throw new Error(`unexpected security call ${args[0]}`);
  });
  process.env.HOME = home;
  process.env.USER = 'owner';
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  try {
    await fn({ home, calls, items });
  } finally {
    setKeychainRunner(prev);
    Object.defineProperty(process, 'platform', { value: saved.platform });
    process.env.HOME = saved.home;
    process.env.USER = saved.user;
    globalThis.fetch = saved.fetch;
    await rm(home, { recursive: true, force: true });
  }
}

const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

test('Claude: the default login is found in the macOS Keychain when there is no file', async () => {
  const login = { claudeAiOauth: { accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() + 3_600_000, subscriptionType: 'max' } };
  await onFakeMac({ [CLAUDE_SERVICE]: JSON.stringify(login) }, async ({ home }) => {
    const found = await claude.discover();
    assert.deepEqual(found, [{ backend: 'claude', home: join(home, '.claude'), label: 'claude-default' }]);
  });
});

test('Claude: a refreshed Keychain login is written back to the Keychain', async () => {
  // Anthropic rotates the refresh token on every use; losing the new one locks
  // Claude Code itself out, so the write-back is the whole point of this test.
  const login = { claudeAiOauth: { accessToken: 'old', refreshToken: 'r-old', expiresAt: Date.now() - 1000, subscriptionType: 'max' }, other: 'kept' };
  await onFakeMac({ [CLAUDE_SERVICE]: JSON.stringify(login) }, async ({ home, items, calls }) => {
    globalThis.fetch = async (url) =>
      String(url).includes('/oauth/token')
        ? json({ access_token: 'new', refresh_token: 'r-new', expires_in: 3600 })
        : json({ five_hour: { utilization: 10, resets_at: null } });
    const result = await claude.fetchAccount({ backend: 'claude', home: join(home, '.claude'), label: 'claude-default' });
    assert.equal(result.status, 'ok');
    assert.equal(result.tokenRefreshed, true);
    assert.equal(result.sourceFile, `Keychain: ${CLAUDE_SERVICE}`);
    const write = calls.find((c) => c.args[0] === 'add-generic-password');
    assert.ok(write, 'the refreshed login must be saved');
    assert.ok(write.args.includes('-U'), 'it replaces the existing item');
    assert.equal(write.args[write.args.indexOf('-a') + 1], 'owner');
    assert.equal(write.args.at(-1), '-w', 'the value goes on stdin, never on the command line');
    assert.ok(!write.args.join(' ').includes('r-new'), 'no token in the arguments');
    const stored = JSON.parse(items[CLAUDE_SERVICE]);
    assert.equal(stored.claudeAiOauth.refreshToken, 'r-new');
    assert.equal(stored.claudeAiOauth.accessToken, 'new');
    assert.equal(stored.other, 'kept');
  });
});

test('Cursor: the access token is read from the macOS Keychain when there is no auth.json', async () => {
  await onFakeMac({ [CURSOR_ACCESS_SERVICE]: 'cursor-token' }, async () => {
    const found = await cursor.discover();
    assert.deepEqual(found, [{ backend: 'cursor', keychain: CURSOR_ACCESS_SERVICE, label: 'cursor-default' }]);
    let auth;
    globalThis.fetch = async (_url, opts) => {
      auth = opts.headers.authorization;
      return json({ membershipType: 'pro', individualUsage: { plan: { totalPercentUsed: 12 } } });
    };
    const result = await cursor.fetchAccount(found[0]);
    assert.equal(result.status, 'ok');
    assert.equal(auth, 'Bearer cursor-token');
    assert.equal(result.sourceFile, `Keychain: ${CURSOR_ACCESS_SERVICE}`);
  });
});

test('nothing is read from a Keychain off macOS', async () => {
  await onFakeMac({ [CLAUDE_SERVICE]: '{}' }, async ({ calls }) => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    assert.deepEqual(await claude.discover(), []);
    assert.deepEqual(await cursor.discover(), []);
    assert.equal(calls.length, 0);
  });
});

test('a failing security call reports no secret', async () => {
  // The real runner, against a stand-in `security` that always fails: Node's
  // default error text would repeat the arguments, and stderr could echo input.
  const { mkdtemp, writeFile, chmod } = await import('node:fs/promises');
  const { writeKeychain } = await import('./keychain.mjs');
  const bin = await mkdtemp(join(tmpdir(), 'fake-security-'));
  await writeFile(join(bin, 'security'), '#!/bin/sh\ncat >/dev/null\necho "boom $*" >&2\nexit 51\n');
  await chmod(join(bin, 'security'), 0o755);
  const saved = { path: process.env.PATH, platform: process.platform };
  process.env.PATH = `${bin}:${saved.path}`;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  try {
    await assert.rejects(writeKeychain('svc', 'SECRET-TOKEN', 'acct'), (err) => {
      assert.match(err.message, /security add-generic-password failed \(exit 51\)/);
      assert.ok(!err.message.includes('SECRET-TOKEN'));
      return true;
    });
  } finally {
    process.env.PATH = saved.path;
    Object.defineProperty(process, 'platform', { value: saved.platform });
    await rm(bin, { recursive: true, force: true });
  }
});
