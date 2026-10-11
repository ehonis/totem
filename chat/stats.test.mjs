import test from 'node:test'
import assert from 'node:assert/strict'
import { usageFromEvent, usageTally, addUsage, replyStats } from './stats.mjs'
import { normalizeMessage } from './store.mjs'

// Final events as each CLI printed them on 2026-10-07 (trimmed to the fields read).
const CLAUDE = { type: 'result', result: 'hi', total_cost_usd: 0.061093, duration_api_ms: 1459, usage: { input_tokens: 10, cache_creation_input_tokens: 29921, cache_read_input_tokens: 0, output_tokens: 38, output_tokens_details: { thinking_tokens: 31 } } }
const CURSOR = { type: 'result', subtype: 'success', duration_ms: 2171, duration_api_ms: 2171, result: 'hi', usage: { inputTokens: 11286, outputTokens: 22, cacheReadTokens: 3840, cacheWriteTokens: 0 } }
const CODEX = { type: 'turn.completed', usage: { input_tokens: 15129, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } }
const OPENCODE = { type: 'step_finish', part: { tokens: { input: 900, output: 40, reasoning: 10, cache: { read: 100, write: 0 } }, cost: 0.002 } }

test('each CLI\'s usage reads into one shape', () => {
  assert.deepEqual(usageFromEvent(CLAUDE), { input: 29931, cached: 0, output: 38, reasoning: 31, costUsd: 0.061093, apiMs: 1459 })
  assert.deepEqual(usageFromEvent(CURSOR), { input: 15126, cached: 3840, output: 22, apiMs: 2171 })
  assert.deepEqual(usageFromEvent(CODEX), { input: 15129, cached: 0, output: 5, reasoning: 0 })
  assert.deepEqual(usageFromEvent(OPENCODE), { input: 1000, cached: 100, output: 50, reasoning: 10, costUsd: 0.002 })
})

test('events without usage are ignored', () => {
  for (const e of [null, {}, { type: 'result', result: 'x' }, { type: 'assistant', usage: { input_tokens: 5 } }, { type: 'step_finish', part: {} }]) {
    assert.equal(usageFromEvent(e), null)
  }
})

test('a run with several turns (steers, steps) sums them', () => {
  const tally = usageTally()
  tally.add({ type: 'thread.started' })
  tally.add(OPENCODE)
  tally.add(OPENCODE)
  assert.deepEqual(tally.get(), { input: 2000, cached: 200, output: 100, reasoning: 20, costUsd: 0.004 })
  assert.equal(addUsage(null, null), null)
  assert.deepEqual(addUsage(null, { output: 3 }), { output: 3 })
})

test('reply stats: first token, speed over API time, else over the run after the first token', () => {
  const claude = replyStats({ usage: usageFromEvent(CLAUDE), startedAt: 1000, firstTokenAt: 2300, endedAt: 2500, tools: 2 })
  assert.equal(claude.ttftMs, 1300)
  assert.equal(claude.tps, 26) // 38 tokens over 1.459 s of API time
  assert.equal(claude.tools, 2)
  assert.equal(claude.costUsd, 0.061093)
  const codex = replyStats({ usage: { input: 100, cached: 0, output: 500 }, startedAt: 0, firstTokenAt: 1000, endedAt: 6000 })
  assert.equal(codex.tps, 100)
  // Nothing reported, nothing measured: no stats at all rather than zeros.
  assert.equal(replyStats({ usage: null, startedAt: 0, firstTokenAt: 0, endedAt: 10 }), null)
})

test('the thread store keeps effort and stats, and drops junk', () => {
  const out = normalizeMessage({ id: 'a', role: 'assistant', content: 'hi', createdAt: 1, effort: 'high', stats: { tps: 42.5, cached: 0, output: 'lots', input: -1, bogus: 3 } })
  assert.equal(out.effort, 'high')
  assert.deepEqual(out.stats, { cached: 0, tps: 42.5 })
  assert.equal(normalizeMessage({ id: 'b', role: 'assistant', content: '', createdAt: 1, stats: { bogus: 1 } }).stats, undefined)
})
