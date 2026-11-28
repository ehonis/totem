// What a sub-agent's row says (agentRows.ts, after T3 Code's SubagentRow), and the
// reducer folding the brief events the app reads runs with (chat/subagents.mjs):
// a row's facts come without the steps, and never grow a log in the store.
// node strips the modules' types; they import nothing from React Native.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentNowOf, agentTitle, agentTone, elapsedOf, groupElapsed, rowDetail, statusSummary, stepCountOf } from './agentRows.ts'
import { applyEvent, foldAgent } from '../../lib/chat/reduce.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

test('T3 group line counts by status', () => {
  assert.equal(statusSummary([{ status: 'running' }, { status: 'running' }, { status: 'done' }]), '2 working · 1 done')
  assert.equal(statusSummary([{ status: 'error' }, { status: 'stopped' }]), '1 failed · 1 stopped')
  assert.equal(agentTone('running'), 'working')
  assert.equal(agentTone('done'), 'completed')
})

test('a brief agent: count, now and detail without its steps', () => {
  const a = { provider: 'claude', status: 'running', title: 'BF deals: lab hardware', brief: true, stepCount: 82, now: 'Fetched a page · newegg.com', lastAt: 2000, startedAt: 1000 }
  assert.equal(stepCountOf(a), 82)
  assert.equal(agentNowOf(a), 'Fetched a page · newegg.com')
  assert.equal(rowDetail(a), 'Fetched a page · newegg.com')
  assert.equal(agentTitle(a), 'BF deals: lab hardware')
})

test('a full agent (the log in hand) still reads', () => {
  const a = { provider: 'codex', status: 'running', steps: [{ id: 's1', kind: 'tool', title: 'Ran a command', detail: 'ls', at: 5 }], dropped: 3 }
  assert.equal(stepCountOf(a), 4)
  assert.equal(agentNowOf(a), 'Ran a command · ls')
  assert.equal(agentTitle({ provider: 'codex', status: 'done', prompt: '\n  Make an icon\nfor the app' }), 'Make an icon')
})

test('once ended, the row shows what it handed back, flattened', () => {
  const a = { provider: 'claude', status: 'done', title: 'Find deals', summary: '## Deals\n- **Sonos** [link](https://x.test) at `$339`', progress: 'Searching' }
  assert.equal(rowDetail(a), 'Deals Sonos link at $339')
  // Claude repeats the title as the summary of a stopped task: nothing handed back.
  assert.equal(rowDetail({ provider: 'claude', status: 'stopped', title: 'Find deals', summary: 'Find deals', progress: 'Fetching shop' }), 'Fetching shop')
})

test('clocks stop at the last step seen when the reply is not live here', () => {
  const a = { provider: 'claude', status: 'running', startedAt: 1000, lastAt: 61_000 }
  assert.equal(elapsedOf(a, false, 999_999), 60_000)
  assert.equal(elapsedOf(a, true, 121_000), 120_000)
  assert.equal(elapsedOf({ ...a, status: 'done', endedAt: 31_000 }, true, 999_999), 30_000)
  assert.equal(groupElapsed([a, { provider: 'claude', status: 'done', startedAt: 500, endedAt: 40_000 }], false, 999_999), 60_500)
})

test('brief agent events fold into the row without growing a log', () => {
  let agent = foldAgent(undefined, { agent: { provider: 'claude', status: 'running', title: 'Find deals', startedAt: 1 } })
  assert.equal(agent.steps, undefined)
  for (let i = 1; i <= 300; i++) agent = foldAgent(agent, { agent: { stepCount: i, now: `step ${i}`, lastAt: i } })
  assert.equal(agent.stepCount, 300)
  assert.equal(agent.now, 'step 300')
  assert.equal(agent.steps, undefined, 'no log builds up in the store')
  // A full stream (the web's) still folds steps into a brief-loaded agent.
  const full = foldAgent({ provider: 'claude', status: 'running', brief: true }, { step: { id: 'a', kind: 'text', text: 'hi' } })
  assert.equal(full.steps.length, 1)

  const msg = { id: 'm', role: 'assistant', content: '', parts: [{ type: 'tool', id: 't1', title: 'Ran a sub-agent', status: 'running', agent }] }
  const next = applyEvent(msg, { type: 'agent', toolId: 't1', agent: { status: 'done', summary: 'Found three', endedAt: 9 } })
  assert.equal(next.parts[0].agent.status, 'done')
  assert.equal(next.parts[0].agent.stepCount, 300)
})

test('the app reads chats, runs and sends with agents=brief', () => {
  const api = readFileSync(join(HERE, '../../lib/api.ts'), 'utf8')
  assert.match(api, /const threadPageUrl = [^\n]*\n[^\n]*&agents=brief`/, 'every window, the stored copy included, is brief')
  const chatApi = readFileSync(join(HERE, '../../lib/chat/api.ts'), 'utf8')
  assert.match(chatApi, /stream\?since=\$\{since\}&agents=brief/)
  assert.match(chatApi, /JSON\.stringify\(\{ \.\.\.args, agents: 'brief' \}\)/)
})
