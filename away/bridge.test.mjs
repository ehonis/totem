// Run with: node --test away/bridge.test.mjs
//
// The away rules that live in bridge.mjs, through a real bridge: an agent proposes over
// /mcp, tries to accept its own proposal under an approval session the owner granted, and
// is refused; the owner accepts it from the dashboard. The owner is a signed-in session
// with the approval code (auth/approval-code.mjs): the bearer alone approves nothing,
// so it can no longer stand in for the owner here. The bridge writes several files
// under its own data/, so it runs from a copy of the source tree in a temp dir, with its
// own HOME and port, and is stopped at the end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRET = 'away-bridge-test-secret';
// Not needed to boot, or not the bridge's: other apps, build output and anything local.
const SKIP = new Set(['node_modules', '.git', 'data', 'secrets', 'mobile', 'desktop', '.env', 'AGENTS.local.md']);

const freePort = () => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

async function startBridge(t) {
  const dir = mkdtempSync(join(tmpdir(), 'totem-away-bridge-'));
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
  mkdirSync(join(dir, 'home'));
  const port = await freePort();
  const child = spawn(process.execPath, ['bridge.mjs'], {
    cwd: app,
    env: { PATH: process.env.PATH, HOME: join(dir, 'home'), BRIDGE_PORT: String(port), BRIDGE_SECRET: SECRET, BRIDGE_NO_SCHEDULER: '1', TZ: 'UTC' },
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
  const api = async (path, body) => {
    const res = await fetch(`${base}${path}`, body === undefined ? { headers: auth } : { method: 'POST', headers: auth, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  let id = 0;
  const tool = async (name, args) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...auth, accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    });
    const { result } = await res.json();
    return result.isError ? { error: result.content[0].text } : result.structuredContent;
  };
  // The owner: create the account from the setup link, sign in, set an approval code.
  const token = output.match(/setup\?token=([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(token, output);
  const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password: 'correct horse battery staple' }) });
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const owner = { cookie, 'content-type': 'application/json' };
  const { code } = await (await fetch(`${base}/api/auth/approval-code`, { method: 'POST', headers: owner, body: JSON.stringify({ password: 'correct horse battery staple' }) })).json();
  const ownerApi = async (path, body) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { ...owner, 'x-totem-approval-code': code }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const digestOf = async (id) => (await (await fetch(`${base}/api/inbox`, { headers: owner })).json()).items.find((i) => i.id === id)?.digest;
  return { api, tool, ownerApi, digestOf };
}

test('an agent proposes; only the owner, in the dashboard, accepts', { timeout: 60_000 }, async (t) => {
  const { api, tool, ownerApi, digestOf } = await startBridge(t);
  const trip = { start: '2026-12-20', end: '2026-12-27', label: 'Holidays', kind: 'off', why: 'Hotel confirmation email for those dates' };

  const proposed = await tool('totem_away_propose', trip);
  assert.equal(proposed.staged, true);
  assert.equal(proposed.created, false);
  assert.deepEqual((await api('/api/away?all=1')).json.spans, []);

  // Proposed once: the same dates come back as the open proposal, not a second one.
  const again = await tool('totem_away_propose', trip);
  assert.equal(again.staged, false);
  assert.deepEqual(again.alreadyProposed, { id: proposed.id, status: 'open' });

  // The agent holds an approval session the owner really approved, and still cannot accept.
  const lease = await tool('totem_request_approval', { explanation: 'Resolve the away proposal in the inbox', why: 'Checking what a session may accept' });
  // The bearer alone cannot approve the session, or accept the proposal, for the owner.
  assert.equal((await api('/api/approvals/approve', { approvalSessionId: lease.approvalSessionId })).status, 403);
  assert.equal((await api('/api/inbox/resolve', { id: proposed.id, action: 'accept' })).status, 403);
  assert.equal((await ownerApi('/api/approvals/approve', { approvalSessionId: lease.approvalSessionId })).json.status, 'approved');
  const refused = await tool('totem_resolve_inbox', { id: proposed.id, action: 'accept', approvalSessionId: lease.approvalSessionId });
  assert.match(refused.error, /accepted only by the owner, in the Totem dashboard/);
  assert.deepEqual((await api('/api/away?all=1')).json.spans, []);

  // The owner accepts it from the dashboard.
  const accepted = await ownerApi('/api/inbox/resolve', { id: proposed.id, action: 'accept', digest: await digestOf(proposed.id) });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  const spans = (await api('/api/away?all=1')).json.spans;
  assert.deepEqual(spans.map((s) => [s.label, s.start, s.end, s.source]), [['Holidays', '2026-12-20', '2026-12-27', `inbox ${proposed.id}`]]);

  // Listed now: proposing it again stages nothing.
  const listed = await tool('totem_away_propose', { ...trip, label: 'Christmas' });
  assert.equal(listed.staged, false);
  assert.equal(listed.alreadyListed.id, spans[0].id);
});
