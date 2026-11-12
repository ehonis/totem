// Run with: node --test providers/mcp-sync.test.mjs
//
// In gateway mode a provider's config holds the gateway and nothing else: the gateway
// reads the manifest itself. Adding, toggling or removing a connection, or Re-sync,
// once rewrote Codex's managed block from the manifest, which dropped the gateway and
// left Codex chats with no Totem tools. Drives the real routes on a bridge running
// from a copy of the source tree, with its own HOME, data/ and port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRET = 'mcp-sync-test-secret';
const SKIP = new Set(['node_modules', '.git', 'data', 'secrets', 'mobile', 'desktop', '.env', 'AGENTS.local.md']);

const freePort = () => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

async function startBridge(t) {
  const dir = mkdtempSync(join(tmpdir(), 'totem-mcp-sync-'));
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
  writeFileSync(join(app, 'data', 'provider-config.json'), JSON.stringify({ defaultProvider: 'codex', enabledProviders: ['codex'], mcpMode: 'gateway' }));
  // Nothing listens on port 1, so the gateway's status check fails fast.
  writeFileSync(join(app, 'data', 'mcp-manifest.json'), JSON.stringify({
    version: 1,
    servers: {
      alpha: { transport: 'http', url: 'http://127.0.0.1:1/mcp', enabled: true },
      beta: { transport: 'http', url: 'http://127.0.0.1:1/mcp', enabled: true },
    },
  }));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.codex'), { recursive: true });
  // The owner's own settings, and a server he added himself, must survive every sync.
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-test"\n\n[mcp_servers.mine]\nurl = "http://127.0.0.1:1/mine"\n');
  const port = await freePort();
  const child = spawn(process.execPath, ['bridge.mjs'], {
    cwd: app,
    // No agent CLIs on PATH: Codex's sync only writes config.toml.
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, BRIDGE_PORT: String(port), BRIDGE_SECRET: SECRET, BRIDGE_NO_SCHEDULER: '1', TZ: 'UTC' },
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
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`bridge never came up:\n${output}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const post = async (path, body) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  return { post, codexConfig: () => readFileSync(join(home, '.codex', 'config.toml'), 'utf8') };
}

const serverIds = (toml) => [...toml.matchAll(/^\[mcp_servers\.(?:"([^"]+)"|([\w-]+))\]$/gm)].map((m) => m[1] || m[2]).sort();

test('in gateway mode, Codex keeps only the gateway through every Connections change', { timeout: 90_000 }, async (t) => {
  const { post, codexConfig } = await startBridge(t);
  const expectGatewayOnly = (step) => {
    const toml = codexConfig();
    assert.deepEqual(serverIds(toml), ['mine', 'totem-gateway'], `${step}:\n${toml}`);
    assert.match(toml, /^model = "gpt-test"$/m, step);
  };

  for (const [step, path, body] of [
    ['switch to gateway', '/api/mcp/mode', { mode: 'gateway' }],
    ['toggle off', '/api/mcp/toggle', { id: 'alpha', enabled: false }],
    ['toggle on', '/api/mcp/toggle', { id: 'alpha', enabled: true }],
    ['add', '/api/mcp/add', { custom: { id: 'gamma', url: 'http://127.0.0.1:1/gamma' } }],
    ['remove', '/api/mcp/remove', { id: 'beta' }],
    ['re-sync', '/api/mcp/sync', {}],
  ]) {
    const res = await post(path, body);
    assert.equal(res.status, 200, `${step}: ${JSON.stringify(res.json)}`);
    expectGatewayOnly(step);
  }

  // Off clears the gateway too, and a change while off writes nothing back.
  assert.equal((await post('/api/mcp/mode', { mode: 'off' })).status, 200);
  assert.deepEqual(serverIds(codexConfig()), ['mine']);
  assert.equal((await post('/api/mcp/toggle', { id: 'alpha', enabled: false })).status, 200);
  assert.deepEqual(serverIds(codexConfig()), ['mine']);
});
