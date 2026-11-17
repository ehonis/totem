import test from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPACTION_MIN_TOKENS, IDLE_COMPACT_LEAD_MS, claudeAutoCompactThreshold, codexCompacted, claudeAutoCompactWindow, claudeCacheTtlMs,
  claudeCompactionEvent, claudeContextUsage, claudeContextWindow, codexContextUsage, idleCompactionWindow, isCompactCommand,
  latestContext, normalizeAutoCompactWindow, opencodeContextUsage, reportedClaudeWindows,
} from './context.mjs'
import { applyEvent, finalizeMessage, renderTranscript } from './turn.mjs'
import { normalizeMessage, threadSummary } from './store.mjs'
import { createIdleCompactor } from './compaction.mjs'

// Events as Claude Code 2.1.325 and codex-cli 0.169.0 printed them on 2026-11-16 (trimmed).
const CLAUDE_ASSISTANT_USAGE = { input_tokens: 2, cache_creation_input_tokens: 56995, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 56995, ephemeral_1h_input_tokens: 0 }, output_tokens: 1 }
const CLAUDE_COMPACTING = { type: 'system', subtype: 'status', status: 'compacting', session_id: 's' }
const CLAUDE_COMPACTED = { type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: 's' }
const CLAUDE_BOUNDARY = { type: 'system', subtype: 'compact_boundary', session_id: 's', compact_metadata: { trigger: 'manual', pre_tokens: 57001, post_tokens: 19869, cumulative_dropped_tokens: 37132, duration_ms: 6058 } }
const CLAUDE_RESULT = { type: 'result', result: '', modelUsage: { 'claude-haiku-5-5': { inputTokens: 4, contextWindow: 1000000 }, 'claude-new-9': { contextWindow: 400000 } } }
const CODEX_TOKEN_COUNT = { timestamp: '2026-11-16T22:01:53.766Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 90000, cached_input_tokens: 4352, output_tokens: 50, total_tokens: 90050 }, last_token_usage: { input_tokens: 18133, cached_input_tokens: 4352, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 18138 }, model_context_window: 475000 } } }

test('/compact is a command with or without instructions, never mid-sentence', () => {
  assert.ok(isCompactCommand('/compact'))
  assert.ok(isCompactCommand('  /COMPACT keep the API decisions'))
  assert.ok(!isCompactCommand('/compacted'))
  assert.ok(!isCompactCommand('please /compact'))
})

test('the auto-compact setting takes T3\'s range only', () => {
  assert.equal(normalizeAutoCompactWindow(''), '')
  assert.equal(normalizeAutoCompactWindow('150,000'), '150000')
  assert.equal(normalizeAutoCompactWindow(1000000), '1000000')
  assert.equal(normalizeAutoCompactWindow('99999'), null)
  assert.equal(normalizeAutoCompactWindow('1000001'), null)
  assert.equal(normalizeAutoCompactWindow('abc'), null)
})

test('the compaction window follows T3\'s precedence, and off means no tick', () => {
  assert.equal(claudeAutoCompactWindow({ setting: '300000', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' } }), '300000')
  assert.equal(claudeAutoCompactWindow({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' } }), '200000')
  assert.equal(claudeAutoCompactWindow({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '50000' } }), '')
  assert.equal(claudeAutoCompactWindow({ settings: { autoCompactWindow: 400000, modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 250000 } } }, model: 'claude-opus-5-5[1m]' }), '250000')
  assert.equal(claudeAutoCompactWindow({ settings: { autoCompactWindow: 400000, modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 'auto' } } }, model: 'claude-opus-5-5' }), '')
  assert.equal(claudeAutoCompactWindow({ setting: '300000', env: { DISABLE_AUTO_COMPACT: '1' } }), '')
  assert.equal(claudeAutoCompactWindow({ setting: '300000', settings: { autoCompactEnabled: false } }), '')
  // Claude compacts 33k short of the window, and only below the model's own.
  assert.equal(claudeAutoCompactThreshold('150000', 1_000_000), 117_000)
  assert.equal(claudeAutoCompactThreshold('1000000', 1_000_000), null)
  assert.equal(claudeAutoCompactThreshold('', 1_000_000), null)
})

test('Claude windows come from T3\'s catalog, then what Claude Code reported', () => {
  assert.equal(claudeContextWindow('claude-opus-5-5'), 1_000_000)
  assert.equal(claudeContextWindow('claude-fable-5-2'), 1_000_000)
  assert.equal(claudeContextWindow('opus'), 1_000_000)
  assert.equal(claudeContextWindow('claude-haiku-4-5-20251001'), 200_000)
  assert.equal(claudeContextWindow('claude-sonnet-4-6'), 200_000)
  assert.equal(claudeContextWindow('claude-sonnet-4-6[1m]'), 1_000_000)
  assert.equal(claudeContextWindow('claude-new-9'), null)
  assert.equal(claudeContextWindow('claude-new-9', reportedClaudeWindows(CLAUDE_RESULT)['claude-new-9']), 400_000)
})

test('a Claude request is context fill: its whole prompt plus output, with the cache\'s lifetime', () => {
  const ctx = claudeContextUsage(CLAUDE_ASSISTANT_USAGE, { maxTokens: 1_000_000, autoCompactWindow: '150000', requestedAt: 1000, at: 2000 })
  assert.deepEqual(ctx, { used: 56998, max: 1_000_000, input: 56997, cached: 0, output: 1, autoCompactAt: 117_000, cacheTtlMs: 300_000, cacheExpiresAt: 301_000, at: 2000 })
  assert.equal(claudeCacheTtlMs({ ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 9 }), 3_600_000)
  // A placeholder with no input is not a measurement.
  assert.equal(claudeContextUsage({ input_tokens: 0, output_tokens: 0 }), null)
})

test('Codex reads the last request, not the session total; OpenCode its last step', () => {
  assert.deepEqual(codexContextUsage(CODEX_TOKEN_COUNT, 5), { used: 18138, max: 475000, input: 18133, cached: 4352, output: 5, at: 5 })
  assert.equal(codexContextUsage({ type: 'event_msg', payload: { type: 'token_count', info: null } }), null)
  assert.deepEqual(opencodeContextUsage({ type: 'step_finish', part: { tokens: { input: 900, output: 40, cache: { read: 100, write: 10 } } } }, 7), { used: 1050, input: 1010, cached: 100, output: 40, at: 7 })
})

test('Claude\'s compaction events open and close a divider', () => {
  assert.deepEqual(claudeCompactionEvent(CLAUDE_COMPACTING), { status: 'running' })
  assert.deepEqual(claudeCompactionEvent(CLAUDE_BOUNDARY), { status: 'done', trigger: 'manual', before: 57001, after: 19869 })
  assert.equal(claudeCompactionEvent(CLAUDE_COMPACTED), null)
  assert.deepEqual(claudeCompactionEvent({ type: 'system', subtype: 'status', compact_result: 'failed', compact_error: 'boom' }), { status: 'failed', reason: 'boom' })
  assert.equal(claudeCompactionEvent({ type: 'system', subtype: 'init' }), null)
})

test('the reply folds context readings and compactions, and the thread file keeps them', () => {
  const msg = { id: 'a1', role: 'assistant', content: '', parts: [], status: 'streaming', provider: 'claude' }
  applyEvent(msg, { type: 'context', context: { used: 400_000, max: 1_000_000, at: 1 } })
  applyEvent(msg, { type: 'compaction', compaction: { id: 'c1', status: 'running', trigger: 'auto' } }, 10)
  applyEvent(msg, { type: 'compaction', compaction: { id: 'c1', status: 'done', before: 400_000, after: 40_000 } }, 20)
  applyEvent(msg, { type: 'context', context: { used: 40_000, max: 1_000_000, at: 2 } })
  assert.equal(msg.parts.length, 1)
  assert.deepEqual(msg.parts[0], { type: 'compaction', id: 'c1', status: 'done', trigger: 'auto', startedAt: 10, before: 400_000, after: 40_000 })
  assert.equal(msg.context.used, 40_000)
  finalizeMessage(msg, { status: 'done', finalText: 'ok' })
  const saved = normalizeMessage({ ...msg, context: { ...msg.context, model: 'x', junk: 'y' } })
  assert.deepEqual(saved.context, { used: 40_000, max: 1_000_000, at: 2 })
  assert.equal(saved.parts.find((p) => p.type === 'compaction').after, 40_000)
  assert.equal(normalizeMessage({ role: 'user', content: '/compact', command: 'compact' }).command, 'compact')
  assert.equal(normalizeMessage({ role: 'user', content: 'hi', command: 'other' }).command, undefined)
})

test('a compaction still running when the reply ends is stopped or failed', () => {
  const stopped = { role: 'assistant', content: '', parts: [{ type: 'compaction', id: 'c', status: 'running', trigger: 'manual' }] }
  finalizeMessage(stopped, { status: 'stopped' })
  assert.equal(stopped.parts[0].status, 'stopped')
  const died = { role: 'assistant', content: 'x', parts: [{ type: 'compaction', id: 'c', status: 'running', trigger: 'auto' }] }
  finalizeMessage(died, { status: 'done' })
  assert.equal(died.parts[0].status, 'failed')
})

test('a compaction turn is never replayed to another account', () => {
  const messages = [
    { role: 'user', content: 'plan the trip' },
    { role: 'assistant', content: 'Here is a plan', provider: 'claude' },
    { role: 'user', content: '/compact', command: 'compact' },
    { role: 'assistant', content: '', provider: 'claude', parts: [{ type: 'compaction', id: 'c', status: 'done', trigger: 'manual' }] },
    { role: 'user', content: 'now book it' },
  ]
  const out = renderTranscript(messages)
  assert.ok(out.includes('plan the trip') && out.includes('now book it'))
  assert.ok(!out.includes('/compact'))
  assert.ok(!out.includes('(…)'), 'a skipped compaction is not a gap')
  // A reply Claude compacted mid-way, that ran tools and said nothing, still hands its steps over.
  const midway = renderTranscript([
    { role: 'user', content: 'fix the build' },
    { role: 'assistant', content: '', status: 'stopped', parts: [{ type: 'compaction', id: 'c', status: 'done', trigger: 'auto' }, { type: 'tool', id: 't', title: 'Ran the tests', status: 'done' }] },
  ], { tools: true })
  assert.ok(midway.includes('Ran the tests'))
})

test('latestContext reads the newest reading for that account only', () => {
  const ms = [
    { role: 'assistant', provider: 'claude', context: { used: 1 } },
    { role: 'assistant', provider: 'codex', context: { used: 2 } },
    { role: 'assistant', provider: 'claude' },
  ]
  assert.equal(latestContext(ms, 'claude').used, 1)
  assert.equal(latestContext(ms, 'codex').used, 2)
  assert.equal(latestContext(ms, 'cursor'), null)
})

test('an idle Claude chat compacts two minutes before its cache expires, and only then', () => {
  const now = 1_000_000
  const base = () => ({
    id: 't', kind: 'regular', provider: 'claude',
    sessions: { claude: { id: 's', through: 2 } },
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', status: 'done', provider: 'claude', context: { used: COMPACTION_MIN_TOKENS, cacheExpiresAt: now + 600_000, at: now } },
    ],
  })
  assert.deepEqual(idleCompactionWindow(base(), { now }), { startMs: now + 600_000 - IDLE_COMPACT_LEAD_MS, endMs: now + 600_000 })
  const no = (patch, opts = {}) => assert.equal(idleCompactionWindow(patch(base()), { now, ...opts }), null)
  no((t) => t, { running: true })
  no((t) => ({ ...t, settledOverride: 'settled' }))
  no((t) => ({ ...t, snoozedUntil: now + 1 }))
  no((t) => ({ ...t, totemId: 'x' }))
  no((t) => ({ ...t, kind: 'temporary' }))
  no((t) => ({ ...t, queue: [{ id: 'q' }] }))
  no((t) => ({ ...t, provider: 'codex' }), { driverOf: (p) => p })
  no((t) => { t.messages[1].context.used = COMPACTION_MIN_TOKENS - 1; return t })
  no((t) => { delete t.messages[1].context.cacheExpiresAt; return t })
  no((t) => { t.messages[1].context.cacheExpiresAt = now - 1; return t })
  no((t) => { t.sessions.claude.through = 1; return t })
  no((t) => { t.messages[0] = { role: 'user', content: '/compact', command: 'compact' }; return t })
  no((t) => { t.messages[1].parts = [{ type: 'questions', status: 'pending' }]; return t })
})

test('Codex compactions are read from every rollout shape, old and new', () => {
  assert.ok(codexCompacted({ type: 'compacted', payload: { message: '' } }))
  assert.ok(codexCompacted({ type: 'event_msg', payload: { type: 'context_compacted' } }))
  assert.ok(codexCompacted({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'ContextCompaction', id: 'x' } } }))
  assert.ok(!codexCompacted({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage' } } }))
  assert.ok(!codexCompacted(CODEX_TOKEN_COUNT))
})

test('a chat\'s summary previews the turn before a compaction, not the compaction', () => {
  const s = threadSummary({
    id: 't',
    messages: [
      { id: 'u1', role: 'user', content: 'plan the trip', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'Here is the plan', status: 'done', createdAt: 2 },
      { id: 'u2', role: 'user', content: '/compact', command: 'compact', createdAt: 3 },
      { id: 'a2', role: 'assistant', content: '', status: 'done', createdAt: 4 },
    ],
  })
  assert.deepEqual(s.messages.map((m) => m.id), ['a1', 'u2', 'a2'])
  assert.equal(s.messages.find((m) => m.id === 'u2').command, 'compact')
})

test('the idle compactor sets one timer per idle chat and looks again when it fires', async () => {
  const now = 1_000_000
  const chat = {
    id: 't', kind: 'regular', provider: 'claude', updatedAt: now, sessions: { claude: { id: 's', through: 2 } },
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', status: 'done', provider: 'claude', model: 'opus', effort: 'high', context: { used: 300_000, cacheExpiresAt: now + 600_000, at: now } },
    ],
  }
  const timers = []
  const started = []
  let mode = 'beforeCacheExpires'
  let enabled = true
  const c = createIdleCompactor({
    threads: { get: async () => structuredClone(chat), list: async () => [chat] },
    isRunning: () => false,
    startTurn: async (body, opts) => { started.push({ body, opts }) },
    mode: () => mode,
    driverOf: (p) => p,
    enabled: async () => enabled,
    now: () => now,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimer: () => {},
  })
  await c.schedule('t')
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 600_000 - IDLE_COMPACT_LEAD_MS)
  enabled = false
  await c.fire('t')
  assert.equal(started.length, 0, 'not on an account he switched off')
  enabled = true
  await c.fire('t')
  assert.deepEqual(started[0], { body: { threadId: 't', text: '/compact', provider: 'claude', model: 'opus', effort: 'high', modelSettings: undefined }, opts: { idle: 'beforeCacheExpires' } })
  mode = 'onReturn'
  await c.schedule('t')
  await c.fire('t')
  assert.equal(timers.length, 1, 'no timer unless the setting asks for one')
  assert.equal(started.length, 1)
})
