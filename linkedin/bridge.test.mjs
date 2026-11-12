// Run with: node --test linkedin/bridge.test.mjs
//
// The LinkedIn card rules that live in bridge.mjs, through a real bridge: with no
// sign-in nothing is staged; once signed in an agent stages cards over /mcp, the
// same post is proposed once (whatever its query string), at most five wait, and
// only the owner marks one done, from the dashboard. A denied post is never
// proposed again. Nothing here loads LinkedIn: the sign-in is a planted cookie file.
// The bridge runs from a copy of the source tree in a temp dir, with its own HOME,
// port and data, and is stopped at the end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromium } from '../browser/manager.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRET = 'linkedin-bridge-test-secret';
const SKIP = new Set(['node_modules', '.git', 'data', 'secrets', 'mobile', 'desktop', '.env', 'AGENTS.local.md']);
const CHROMIUM = findChromium();
const PASSWORD = 'correct horse battery staple';

const freePort = () => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

async function startBridge(t, { signedIn }) {
  const dir = mkdtempSync(join(tmpdir(), 'totem-linkedin-bridge-'));
  const app = join(dir, 'app');
  cpSync(REPO, app, {
    recursive: true,
    filter: (src) => {
      const rel = relative(REPO, src);
      return !SKIP.has(rel.split('/')[0]) && !rel.startsWith('web/node_modules') && !rel.startsWith('web/dist') && basename(src) !== '.DS_Store';
    },
  });
  symlinkSync(realpathSync(join(REPO, 'node_modules')), join(app, 'node_modules'));
  mkdirSync(join(app, 'web', 'dist'), { recursive: true });
  writeFileSync(join(app, 'web', 'dist', 'index.html'), '<!doctype html><title>test</title>');
  mkdirSync(join(app, 'data'));
  if (signedIn) {
    const expires = Math.floor(Date.now() / 1000) + 86400 * 300;
    writeFileSync(join(app, 'data', 'linkedin-tokens.json'), JSON.stringify({
      version: 1, signedInAt: new Date().toISOString(),
      state: { cookies: [{ name: 'li_at', value: 'AQEDAplanted', domain: '.linkedin.com', path: '/', expires, httpOnly: true, secure: true, sameSite: 'None' }], origins: [] },
    }), { mode: 0o600 });
  }
  mkdirSync(join(dir, 'home'));
  const port = await freePort();
  const child = spawn(process.execPath, ['bridge.mjs'], {
    cwd: app,
    env: { PATH: process.env.PATH, HOME: join(dir, 'home'), BRIDGE_PORT: String(port), BRIDGE_SECRET: SECRET, BRIDGE_NO_SCHEDULER: '1', TZ: 'UTC', BROWSER_EXECUTABLE: CHROMIUM },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (const deadline = Date.now() + 30_000; ;) {
    if (child.exitCode !== null) throw new Error(`bridge exited early:\n${output}`);
    try { if ((await fetch(`${base}/health`)).ok && /setup\?token=/.test(output)) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`bridge never came up:\n${output}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const auth = { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' };
  const bearer = async (path, body) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  let rpc = 0;
  const call = async (method, params) => (await (await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...auth, accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method, params }),
  })).json()).result;
  const tool = async (name, args = {}) => {
    const result = await call('tools/call', { name, arguments: args });
    return result.isError ? { error: result.content[0].text } : result.structuredContent;
  };
  // The owner: an account from the setup link, signed in. Marking a card done is low
  // risk (nothing leaves the box), so the session is enough; no approval code needed.
  const token = output.match(/setup\?token=([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(token, output);
  const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password: PASSWORD }) });
  const owner = { cookie: setup.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json' };
  const ownerApi = async (path, body) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: owner, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const inbox = async () => (await (await fetch(`${base}/api/inbox`, { headers: owner })).json()).items;
  return { tool, call, bearer, ownerApi, inbox };
}

const post = (n) => `https://www.linkedin.com/feed/update/urn:li:activity:71000000000000000${n}/`;
const comment = (n, extra = {}) => ({
  kind: 'comment', targetUrl: post(n), authorName: `Friend ${n}`,
  postExcerpt: 'We opened the new bouldering wall this weekend.', draftText: `Congrats! Looks like a great set, number ${n}.`,
  reason: 'A friend’s launch, worth a word', ...extra,
});

test('without a sign-in, LinkedIn tools say so and stage nothing', { skip: !CHROMIUM && 'no Chromium on this machine', timeout: 60_000 }, async (t) => {
  const { tool, call, inbox } = await startBridge(t, { signedIn: false });
  const names = (await call('tools/list', {})).tools.map((x) => x.name).filter((n) => n.startsWith('totem_linkedin_'));
  assert.ok(names.includes('totem_linkedin_get_feed') && names.includes('totem_linkedin_propose_action'), names.join(', '));
  const status = await tool('totem_linkedin_get_status');
  assert.deepEqual([status.connected, status.state], [false, 'not-signed-in']);
  assert.match((await tool('totem_linkedin_get_feed')).error, /not connected/);
  const staged = await tool('totem_linkedin_propose_action', comment(1));
  assert.equal(staged.staged, false);
  assert.match(staged.nextStep, /not connected/);
  assert.equal((await inbox()).length, 0);
  // Outside a chat, sign_in says where to call it from and saves nothing.
  assert.match((await tool('totem_linkedin_sign_in')).nextStep, /from a chat/);
});

test('cards: once per post, five at most, and only the owner marks one done', { skip: !CHROMIUM && 'no Chromium on this machine', timeout: 90_000 }, async (t) => {
  const { tool, bearer, ownerApi, inbox } = await startBridge(t, { signedIn: true });
  assert.equal((await tool('totem_linkedin_get_status')).state, 'connected');

  const first = await tool('totem_linkedin_propose_action', comment(1, { targetUrl: `${post(1)}?utm_source=share` }));
  assert.deepEqual([first.staged, first.performed, first.targetUrl], [true, false, post(1)]);
  const card = (await inbox()).find((i) => i.id === first.id);
  assert.equal(card.kind, 'linkedin');
  assert.equal(card.destination, 'LinkedIn');
  assert.deepEqual(card.preview.linkedin, { action: 'comment', url: post(1), author: 'Friend 1', excerpt: 'We opened the new bouldering wall this weekend.', draft: 'Congrats! Looks like a great set, number 1.' });

  // The same post again, under another spelling, is the open card.
  assert.deepEqual((await tool('totem_linkedin_propose_action', comment(1))).alreadyProposed, { id: first.id, status: 'open' });

  // The bearer alone cannot mark it done, nor can an agent under an approval session.
  assert.equal((await bearer('/api/inbox/resolve', { id: first.id, action: 'accept' })).status, 403);
  const refused = await tool('totem_resolve_inbox', { id: first.id, action: 'accept', approvalSessionId: 'none' });
  assert.ok(refused.error, JSON.stringify(refused));
  // The owner, signed in, marks it done.
  const done = await ownerApi('/api/inbox/resolve', { id: first.id, action: 'accept', digest: card.digest });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.match(done.json.note, /done on LinkedIn \(comment\)/);

  // He denies the next; it is never proposed again.
  const second = await tool('totem_linkedin_propose_action', comment(2));
  const denied = await ownerApi('/api/inbox/resolve', { id: second.id, action: 'deny' });
  assert.equal(denied.status, 200, JSON.stringify(denied.json));
  assert.deepEqual((await tool('totem_linkedin_propose_action', comment(2))).alreadyProposed, { id: second.id, status: 'denied' });

  // Five may wait; the sixth is refused, and nothing is written for it.
  for (let n = 3; n <= 7; n++) assert.equal((await tool('totem_linkedin_propose_action', comment(n))).staged, true, `card ${n}`);
  const sixth = await tool('totem_linkedin_propose_action', comment(8));
  assert.deepEqual([sixth.staged, sixth.capped], [false, { pending: 5, max: 5 }]);
  assert.equal((await inbox()).filter((i) => i.kind === 'linkedin').length, 5);

  const history = await tool('totem_linkedin_list_proposals');
  assert.equal(history.pending, 5);
  assert.deepEqual(history.proposals.slice(-2).map((p) => [p.id, p.status]), [[second.id, 'denied'], [first.id, 'done']]);

  // A draft with a hidden character is refused before it is staged.
  const hidden = await tool('totem_linkedin_propose_action', comment(9, { draftText: 'Congrats‮!' }));
  assert.match(hidden.error, /refused/);
});
