import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('only the dedicated Claude quota poller calls Anthropic usage', async () => {
  const sources = await Promise.all([
    readFile(new URL('./providers/claude.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../bridge.mjs', import.meta.url), 'utf8'),
  ]);
  const calls = sources
    .join('\n')
    .match(/https:\/\/api\.anthropic\.com\/api\/oauth\/usage/g) ?? [];

  assert.equal(
    calls.length,
    1,
    'Claude usage must have one upstream caller so the subscription summary cannot compete with the quota poller',
  );
});
