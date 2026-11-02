import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Gateway } from '../mcp-gateway.mjs';
import { closeTodoDatabase, openTodoDatabase } from '../todos/db.mjs';
import { createRecMcpClient, createRecMcpTools, REC_MCP_TOOL_DEFINITIONS, REC_PROMPT_RULE, recPromptRule } from './mcp.mjs';
import { createRecService, OWNER_VIA } from './service.mjs';

function setup(t) {
  const db = openTodoDatabase({ file: join(mkdtempSync(join(tmpdir(), 'totem-recs-mcp-')), 'todos.db') });
  t.after(() => closeTodoDatabase(db));
  const service = createRecService({ db, actionLog: { record() {} }, now: () => '2026-10-30T15:00:00.000Z', timeZone: 'UTC' });
  return { db, service };
}

// The same rules bridge.mjs checks at boot over MCP_TOOL_META (it refuses to start on
// a mis-marked tool); these definitions are spread into that table as they are.
test('every recs tool has a title, all four hints and an output schema requiring fetchedAt', () => {
  assert.deepEqual(REC_MCP_TOOL_DEFINITIONS.map((tool) => tool.name), ['totem_recs_record', 'totem_recs_list', 'totem_recs_set_outcome']);
  for (const tool of REC_MCP_TOOL_DEFINITIONS) {
    assert.ok(tool.title, `${tool.name}: title`);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(typeof tool.annotations[hint], 'boolean', `${tool.name}: ${hint}`);
    }
    assert.ok(!(tool.annotations.readOnlyHint && tool.annotations.destructiveHint), `${tool.name}: read-only and destructive`);
    assert.ok(!(tool.annotations.readOnlyHint && tool.annotations.idempotentHint === false), `${tool.name}: read-only not idempotent`);
    assert.equal(tool.outputSchema.type, 'object');
    assert.ok(tool.outputSchema.properties.fetchedAt, `${tool.name}: fetchedAt`);
    assert.ok(tool.outputSchema.required.includes('fetchedAt'), `${tool.name}: requires fetchedAt`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name}: closed input`);
  }
  assert.equal(REC_MCP_TOOL_DEFINITIONS.find((t) => t.name === 'totem_recs_list').annotations.readOnlyHint, true);
});

test('the bridge registers the recs tools and their meta for its boot check', () => {
  const bridge = readFileSync(join(import.meta.dirname, '..', 'bridge.mjs'), 'utf8');
  assert.match(bridge, /\.\.\.REC_MCP_TOOL_DEFINITIONS\.map\(recMcpTool\)/);
  assert.match(bridge, /\.\.\.recMcpMeta,/);
  assert.match(bridge, /resurfaceDeferredRecs\(/);
  // The rule reaches /mcp clients (ChatGPT, Claude) under their tool names, not only the gateway's.
  assert.match(bridge, /`RECOMMENDATIONS\. \$\{recPromptRule\('totem_recs_'\)\}`/);
});

test('the rule names the right tools for each surface and stays short', () => {
  assert.match(recPromptRule('totem_recs_'), /totem_recs_list .*totem_recs_record/);
  assert.doesNotMatch(recPromptRule('totem_recs_'), /recs__/);
  assert.equal(REC_PROMPT_RULE.split(/(?<=\.) /).length, 2);
});

test('no tool can take a decision: none accepts one as input to a write', () => {
  for (const tool of REC_MCP_TOOL_DEFINITIONS.filter((t) => !t.annotations.readOnlyHint)) {
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'decision'), false, tool.name);
  }
});

test('an agent recording with a decision is refused, through the tools and the gateway client', async (t) => {
  const { service } = setup(t);
  const tools = createRecMcpTools({ service, fetchedAt: () => 'now' });
  await assert.rejects(
    tools.totem_recs_record({ title: 'Buy a desk', source: 'chat:a', decision: 'accepted' }, { client: 'Claude' }),
    (error) => error.code === 'REC_DECISION_OWNER_ONLY',
  );
  const client = createRecMcpClient({ service });
  await assert.rejects(client.callTool('record', { title: 'Buy a desk', source: 'chat:a', decision: 'accepted' }), /Only the owner decides/);
  assert.equal((await service.list()).count, 0);
});

test('the gateway serves recs__record, recs__list and recs__set_outcome, and tells agents the rule', async (t) => {
  const { service } = setup(t);
  const fake = (name) => ({
    async start() {}, async listTools() { return [{ name, description: name, inputSchema: { type: 'object' } }]; },
    async callTool() { return { content: [] }; }, close() {},
  });
  const gateway = new Gateway({ servers: {} }, {
    taskClient: fake('get_tasks'), goalClient: fake('get_goals'), listClient: fake('get_lists'),
    recClient: createRecMcpClient({ service }),
  });
  t.after(() => gateway.closeAll());
  await gateway.connectAll();
  const names = gateway.tools.map((tool) => tool.name).filter((name) => name.startsWith('recs__'));
  assert.deepEqual(names.sort(), ['recs__list', 'recs__record', 'recs__set_outcome']);

  const recorded = await gateway.callTool('recs__record', { title: 'Try a standing desk', source: 'chat:a', evidence: 'Back pain' });
  const id = recorded.structuredContent.rec.id;
  assert.equal(recorded.structuredContent.rec.decision, 'pending');
  await service.decide(id, { decision: 'declined' }, { actor: 'owner', via: OWNER_VIA });

  const lookup = await gateway.callTool('recs__list', { similarTo: 'standing desk', declinedWithinDays: 30 });
  assert.deepEqual(lookup.structuredContent.recs.map((r) => r.id), [id]);
  assert.match(lookup.structuredContent.stats.line, /0 of 1 accepted/);

  assert.match(REC_PROMPT_RULE, /declinedWithinDays 30/);
  assert.match(REC_PROMPT_RULE, /say what changed/);
  assert.match(readFileSync(join(import.meta.dirname, '..', 'mcp-gateway.mjs'), 'utf8'), /REC_PROMPT_RULE \+ ' ' \+/);
});
