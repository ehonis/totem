// Run with: node --test away/mcp.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AWAY_MCP_TOOL_DEFINITIONS, createAwayMcpTools } from './mcp.mjs';
import { createAwayStore } from './store.mjs';

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'totem-away-mcp-'));
  const store = createAwayStore({ file: join(dir, 'away.json') });
  const staged = [];
  const tools = createAwayMcpTools({
    store,
    stage: async (span) => { staged.push(span); return { id: `P${staged.length}`, kind: 'away', status: 'open' }; },
    tz: 'America/New_York',
    now: () => new Date('2026-11-03T15:00:00Z'),
  });
  return { store, tools, staged };
}

test('there is no tool that writes a span: list and propose only', () => {
  assert.deepEqual(AWAY_MCP_TOOL_DEFINITIONS.map((d) => d.name), ['totem_away_list', 'totem_away_propose']);
});

test('propose stages an inbox item and leaves the spans untouched', async () => {
  const { store, tools, staged } = await harness();
  const out = await tools.totem_away_propose(
    { start: '2026-12-20', end: '2026-12-27', label: 'Holidays', kind: 'off', why: 'Hotel confirmation email for those dates' },
    { actor: 'claude' },
  );
  assert.equal(out.staged, true);
  assert.equal(out.created, false);
  assert.equal(out.id, 'P1');
  assert.deepEqual(staged, [{ start: '2026-12-20', end: '2026-12-27', label: 'Holidays', kind: 'off', why: 'Hotel confirmation email for those dates', src: 'claude' }]);
  assert.deepEqual(store.snapshot(), []);
});

test('propose refuses a bad span or a missing reason before staging anything', async () => {
  const { tools, staged } = await harness();
  await assert.rejects(tools.totem_away_propose({ start: '2026-12-27', end: '2026-12-20', label: 'x', why: 'a booking email' }), /end must be on or after start/);
  await assert.rejects(tools.totem_away_propose({ start: '2026-12-20', label: 'x', why: '' }), /why is required/);
  assert.equal(staged.length, 0);
});

test('propose does not stage a span that is already listed', async () => {
  const { store, tools, staged } = await harness();
  const existing = store.create({ start: '2026-12-20', end: '2026-12-27', label: 'Holidays', kind: 'off' });
  const out = await tools.totem_away_propose({ start: '2026-12-20', end: '2026-12-27', label: 'Christmas', why: 'Calendar shows it blocked' });
  assert.equal(out.staged, false);
  assert.equal(out.alreadyListed.id, existing.id);
  assert.equal(staged.length, 0);
});

test('a repeat of an earlier proposal is reported, not restaged', async () => {
  const { tools } = await harness();
  const asked = [];
  const again = createAwayMcpTools({
    store: { snapshot: () => [] },
    stage: async (span) => { asked.push(span); return { alreadyProposed: { id: 'P7', status: 'denied' } }; },
    tz: 'America/New_York',
  });
  const out = await again.totem_away_propose({ start: '2026-12-20', end: '2026-12-27', label: 'Holidays', why: 'Hotel confirmation email' });
  assert.equal(out.staged, false);
  assert.deepEqual(out.alreadyProposed, { id: 'P7', status: 'denied' });
  assert.match(out.nextStep, /already denied P7/);
  assert.equal(asked.length, 1);
  assert.ok(tools);
});

test('list returns today, the span covering it, and what is still to come', async () => {
  const { store, tools } = await harness();
  store.create({ start: '2026-09-01', end: '2026-09-03', label: 'Past' });
  store.create({ start: '2026-11-02', end: '2026-11-05', label: 'Lisbon' });
  store.create({ start: '2026-12-20', end: '2026-12-27', label: 'Holidays', kind: 'off' });
  const out = await tools.totem_away_list({});
  assert.equal(out.today, '2026-11-03');
  assert.equal(out.awayToday.label, 'Lisbon');
  assert.deepEqual(out.spans.map((s) => s.label), ['Lisbon', 'Holidays']);
  assert.ok(out.fetchedAt);
  assert.equal((await tools.totem_away_list({ includePast: true })).count, 3);
});

// The same rules bridge.mjs enforces at boot for every /mcp tool (MCP_TOOL_META).
test('each tool states a title, all four hints and an output schema requiring fetchedAt', () => {
  for (const d of AWAY_MCP_TOOL_DEFINITIONS) {
    assert.ok(d.title, `${d.name} title`);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(typeof d.annotations[hint], 'boolean', `${d.name} ${hint}`);
    }
    assert.equal(d.annotations.destructiveHint, false, `${d.name} destroys nothing`);
    assert.equal(d.annotations.openWorldHint, false, `${d.name} stays on the box`);
    assert.equal(d.outputSchema.type, 'object');
    assert.ok(d.outputSchema.properties.fetchedAt);
    assert.ok(d.outputSchema.required.includes('fetchedAt'));
  }
  const [list, propose] = AWAY_MCP_TOOL_DEFINITIONS;
  assert.equal(list.annotations.readOnlyHint, true);
  assert.equal(propose.annotations.readOnlyHint, false);
  assert.match(propose.description, /does NOT add it/);
});
