import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalPart, permissionResult, normalizeDecision, sessionRules, sessionUpdates, mergeAllowedTools, createApprovalWaits, statusForDecision } from './approvals.mjs'
import { applyEvent, finalizeMessage } from './turn.mjs'
import { normalizePart } from './store.mjs'
import { chatToolFromClaude } from './tools.mjs'

// A real request, as `claude -p --permission-prompt-tool stdio` sends it.
const bash = {
  subtype: 'can_use_tool',
  tool_name: 'Bash',
  display_name: 'Bash',
  input: { command: 'touch approved.txt', description: 'Create empty file approved.txt' },
  description: 'Create empty file approved.txt',
  permission_suggestions: [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch approved.txt' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'addDirectories', directories: ['/tmp/x'], destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ],
  blocked_path: '/tmp/x/approved.txt',
  tool_use_id: 'toolu_1',
}

test('approvalPart reads like the tool card it becomes', () => {
  const p = approvalPart(bash, { id: 'a1', describe: chatToolFromClaude, now: 5 })
  assert.equal(p.id, 'a1')
  assert.equal(p.tool, 'Bash')
  assert.equal(p.status, 'pending')
  assert.equal(p.toolUseId, 'toolu_1')
  assert.equal(p.path, '/tmp/x/approved.txt')
  assert.equal(p.askedAt, 5)
  assert.ok(p.title)
  assert.match(p.detail + p.title, /touch approved\.txt|approved\.txt/)
  const mcp = approvalPart({ tool_name: 'mcp__claude_ai_Microsoft_365__outlook_create_event', input: { subject: 'Call Mark' }, decision_reason: '\u001b[1mNeeds approval\u001b[0m', suppress_always_allow_rule: true, agent_id: 'x' }, { id: 'a2', describe: chatToolFromClaude })
  assert.equal(mcp.reason, 'Needs approval')
  assert.equal(mcp.once, true)
  assert.equal(mcp.subagent, true)
})

test('permissionResult allows, allows for the session, declines and cancels', () => {
  assert.deepEqual(permissionResult(bash, { decision: 'accept' }), { behavior: 'allow', updatedInput: bash.input, toolUseID: 'toolu_1' })
  const session = permissionResult(bash, { decision: 'acceptForSession' })
  assert.equal(session.behavior, 'allow')
  assert.ok(session.updatedPermissions.every((u) => u.destination === 'session'))
  assert.ok(!session.updatedPermissions.some((u) => u.type === 'setMode'), 'the mode stays the composer’s')
  const declined = permissionResult(bash, { decision: 'decline', feedback: 'use the tmp dir' })
  assert.equal(declined.behavior, 'deny')
  assert.match(declined.message, /use the tmp dir/)
  assert.equal(declined.interrupt, undefined)
  assert.equal(permissionResult(bash, { decision: 'cancel' }).interrupt, true)
  // No standing grant when Claude says not to make one.
  assert.equal(permissionResult({ ...bash, suppress_always_allow_rule: true }, { decision: 'acceptForSession' }).updatedPermissions, undefined)
})

test('sessionRules takes Claude’s suggestions, or the tool by name', () => {
  assert.deepEqual(sessionRules('Bash', bash.permission_suggestions), ['Bash(touch approved.txt)'])
  assert.deepEqual(sessionRules('mcp__srv__tool', []), ['mcp__srv__tool'])
  assert.deepEqual(sessionRules('bad name; rm', undefined), [])
  assert.ok(sessionUpdates('mcp__srv__tool', []).some((u) => u.type === 'addRules' && u.rules[0].toolName === 'mcp__srv__tool'))
})

test('normalizeDecision checks the decision and keeps words only for a decline', () => {
  assert.deepEqual(normalizeDecision({ decision: 'decline', feedback: ' not that ' }), { decision: 'decline', feedback: 'not that' })
  assert.deepEqual(normalizeDecision({ decision: 'accept', feedback: 'x' }), { decision: 'accept' })
  assert.throws(() => normalizeDecision({ decision: 'yes' }), /decision/)
  assert.equal(statusForDecision('acceptForSession'), 'approved')
  assert.equal(statusForDecision('cancel'), 'cancelled')
})

test('mergeAllowedTools dedupes and caps', () => {
  assert.deepEqual(mergeAllowedTools(['A', 'B'], ['B', 'C', 7]), ['A', 'B', 'C'])
  assert.equal(mergeAllowedTools([], Array.from({ length: 300 }, (_, i) => `T${i}`)).length, 200)
})

test('a wait settles once, with the decision or as gone', async () => {
  const waits = createApprovalWaits()
  const p = waits.wait('a1', 'th', null)
  assert.deepEqual(waits.pending('th'), ['a1'])
  assert.equal(waits.decide('a1', { decision: 'accept' }), true)
  assert.deepEqual(await p, { decision: 'accept' })
  assert.equal(waits.decide('a1', { decision: 'accept' }), false)
  const ac = new AbortController()
  const q = waits.wait('a2', 'th', ac.signal)
  ac.abort()
  assert.deepEqual(await q, { gone: true })
  assert.equal(waits.live('a2'), false)
})

test('an approval part is added, updated in place, saved, and expires with its run', () => {
  const msg = { role: 'assistant', content: '' }
  const part = approvalPart(bash, { id: 'a1', describe: chatToolFromClaude })
  applyEvent(msg, { type: 'approval', approval: part })
  applyEvent(msg, { type: 'approval', approval: { id: 'a1', status: 'declined', decision: 'decline', feedback: 'no' } })
  assert.equal(msg.parts.length, 1)
  assert.equal(msg.parts[0].status, 'declined')
  const saved = normalizePart(msg.parts[0])
  assert.equal(saved.type, 'approval')
  assert.equal(saved.feedback, 'no')
  assert.equal(saved.decision, 'decline')
  applyEvent(msg, { type: 'approval', approval: approvalPart(bash, { id: 'a2', describe: chatToolFromClaude }) })
  finalizeMessage(msg, { status: 'stopped' })
  assert.equal(msg.parts[1].status, 'expired')
})
