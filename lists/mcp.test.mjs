import assert from 'node:assert/strict';
import test from 'node:test';

import { createListMcpTools, LIST_MCP_TOOL_DEFINITIONS } from './mcp.mjs';

test('publishes complete list MCP metadata', () => {
  assert.equal(LIST_MCP_TOOL_DEFINITIONS.length, 9);
  for (const tool of LIST_MCP_TOOL_DEFINITIONS) {
    assert.match(tool.name, /^totem_/);
    assert.ok(tool.outputSchema.properties.fetchedAt);
    assert.ok(tool.outputSchema.required.includes('fetchedAt'));
  }
});

test('MCP can create a list with several items in one call', async () => {
  const calls = [];
  const list = { id: 'l1', title: 'Groceries', items: [{ id: 'i1', text: 'Milk' }] };
  const tools = createListMcpTools({
    service: {
      async createList(input, context) { calls.push({ input, context }); return { list }; },
    },
    fetchedAt: () => '2026-09-17T12:00:00.000Z',
  });
  const result = await tools.totem_create_list({ title: 'Groceries', items: ['Milk'] }, { client: 'ChatGPT' });
  assert.equal(result.list.id, 'l1');
  assert.equal(result.fetchedAt, '2026-09-17T12:00:00.000Z');
  assert.equal(calls[0].context.actor, 'ChatGPT');
});
