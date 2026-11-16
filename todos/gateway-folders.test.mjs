// The gateway's side of filing a task from a chat (gatewayTaskFolders in
// mcp-gateway.mjs): it asks the bridge which chat its run is, with the run token,
// and links the task there. Outside a run it asks nothing.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.BRIDGE_SECRET = 'test-secret';
process.env.BRIDGE_PORT = '65001';
const { gatewayTaskFolders } = await import('../mcp-gateway.mjs');

function projectsDir() {
  const dir = mkdtempSync(join(tmpdir(), 'totem-gw-folders-'));
  mkdirSync(join(dir, 'p1'));
  writeFileSync(join(dir, 'p1', 'project.json'), JSON.stringify({ id: 'p1', name: 'Northwind', instructions: '' }));
  return dir;
}

test('inside a chat run it asks the bridge for the chat and links the task, with the run token', async () => {
  const dir = projectsDir();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method || 'GET', headers: init.headers, body: init.body });
    return new Response(JSON.stringify({ threadId: 't1', projectId: 'p1', taskId: null }), { status: 200 });
  };
  try {
    const folders = gatewayTaskFolders(dir, { env: { TOTEM_RUN_TOKEN: 'run-tok' }, fetchImpl });
    assert.deepEqual((await folders.list()).map(p => p.name), ['Northwind']);
    assert.deepEqual(await folders.chat(), { threadId: 't1', projectId: 'p1', taskId: null });
    await folders.linkChat(null, { threadId: 't1' }, 'task-9');
    assert.equal(calls[0].url, 'http://127.0.0.1:65001/api/chat/run-context');
    assert.equal(calls[0].headers['x-totem-run'], 'run-tok');
    assert.equal(calls[0].headers.authorization, 'Bearer test-secret');
    assert.equal(calls[1].url, 'http://127.0.0.1:65001/api/chat/run-context/task');
    assert.deepEqual(JSON.parse(calls[1].body), { taskId: 'task-9' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('outside a run there is no chat, and a refused link is an error the tool swallows', async () => {
  const dir = projectsDir();
  let asked = 0;
  try {
    const none = gatewayTaskFolders(dir, { env: {}, fetchImpl: async () => { asked += 1; return new Response('{}'); } });
    assert.equal(await none.chat(), null);
    assert.equal(asked, 0);
    const refused = gatewayTaskFolders(dir, { env: { TOTEM_RUN_TOKEN: 'x' }, fetchImpl: async () => new Response('{"error":"no chat run"}', { status: 404 }) });
    assert.equal(await refused.chat(), null);
    await assert.rejects(refused.linkChat(null, {}, 't'), /could not be linked/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
