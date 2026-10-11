import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectAgentCli, codexRolloutSteps, claudeRecordSteps, foldAgent, normalizeAgent, watchSessionLog, createCliAgentWatch, MAX_STEPS } from './subagents.mjs'
import { applyEvent, finalizeMessage } from './turn.mjs'
import { normalizePart } from './store.mjs'

test('detectAgentCli finds another agent CLI and its prompt', () => {
  assert.deepEqual(detectAgentCli('codex exec "Design an app icon for Totem; black and white"'), { provider: 'codex', prompt: 'Design an app icon for Totem; black and white' })
  assert.equal(detectAgentCli("cd /tmp/x && timeout 600 codex exec --skip-git-repo-check -m gpt-5 'make three logos please'").provider, 'codex')
  assert.equal(detectAgentCli("claude -p --model haiku 'summarise this repository'").provider, 'claude')
  assert.equal(detectAgentCli("cursor-agent -p 'fix the failing test now'").provider, 'cursor')
  assert.equal(detectAgentCli("opencode run 'write the docs for this'").provider, 'opencode')
  // Wrapped by the parent's own shell (Codex runs every command as `zsh -lc '…'`).
  assert.equal(detectAgentCli(`/usr/bin/zsh -lc "claude -p 'review the diff in this folder'"`).provider, 'claude')
  // A heredoc prompt.
  assert.equal(detectAgentCli("codex exec - <<'EOF'\nGenerate a mountain totem icon\nEOF\n").prompt, 'Generate a mountain totem icon')
})

test('detectAgentCli ignores commands that do not run a prompt', () => {
  for (const cmd of ['codex --version', 'codex login status', 'claude mcp list', 'claude --help', 'grep -r "codex exec" docs', 'ls ~/.codex/sessions', 'echo claude -p', 'npm test']) {
    assert.equal(detectAgentCli(cmd), null, cmd)
  }
})

test('codexRolloutSteps turns rollout lines into steps, once each', () => {
  const ev = (payload) => ({ type: 'event_msg', payload })
  const msg = codexRolloutSteps(ev({ type: 'item_completed', item: { type: 'AgentMessage', id: 'm1', content: [{ type: 'Text', text: 'Using the imagegen skill.' }] } }))
  assert.deepEqual(msg.steps.map((s) => [s.kind, s.text]), [['text', 'Using the imagegen skill.']])
  const cmd = codexRolloutSteps(ev({ type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-1', command: ['/usr/bin/zsh', '-lc', 'ls'], aggregated_output: 'a\nb', exit_code: 0, status: 'completed' } }))
  assert.equal(cmd.steps[0].kind, 'tool')
  assert.equal(cmd.steps[0].detail, 'ls')
  assert.equal(cmd.steps[0].output, 'a\nb')
  assert.equal(cmd.steps[0].status, 'done')
  const img = codexRolloutSteps(ev({ type: 'item_completed', item: { type: 'Extension', kind: 'image_gen.generation', id: 'exec-2', status: 'completed', revisedPrompt: 'a totem' } }))
  assert.equal(img.steps[0].title, 'Made an image')
  // Encrypted reasoning has no text to show.
  assert.equal(codexRolloutSteps(ev({ type: 'item_completed', item: { type: 'Reasoning', id: 'r', summary_text: [], raw_content: [] } })).steps.length, 0)
  assert.equal(codexRolloutSteps(ev({ type: 'item_completed', item: { type: 'Reasoning', id: 'r', summary_text: ['Planning the icons'] } })).steps[0].kind, 'thinking')
  assert.equal(codexRolloutSteps(ev({ type: 'token_count', info: { total_token_usage: { total_tokens: 1234 } } })).patch.tokens, 1234)
  assert.equal(codexRolloutSteps({ type: 'turn_context', payload: { model: 'gpt-5.6' } }).patch.model, 'gpt-5.6')
  assert.equal(codexRolloutSteps(ev({ type: 'task_complete', last_agent_message: 'Saved 3 icons.' })).patch.summary, 'Saved 3 icons.')
  // Old and new forms of one step share an id, so they fold into one.
  const a = codexRolloutSteps(ev({ type: 'patch_apply_end', call_id: 'exec-9', success: true, changes: { '/x/a.md': {} } })).steps[0]
  const b = codexRolloutSteps(ev({ type: 'item_completed', item: { type: 'FileChange', id: 'exec-9', changes: { '/x/a.md': {} } } })).steps[0]
  assert.equal(a.id, b.id)
})

test('claudeRecordSteps reads thinking, text, tool calls and their results', () => {
  const asst = claudeRecordSteps({ type: 'assistant', uuid: 'u1', message: { model: 'claude-haiku-4-5', content: [
    { type: 'thinking', thinking: 'Need to list /etc' },
    { type: 'thinking', thinking: '' },
    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls /etc', description: 'List /etc' } },
    { type: 'text', text: 'Done.' },
  ] } })
  assert.equal(asst.patch.model, 'claude-haiku-4-5')
  assert.deepEqual(asst.steps.map((s) => s.kind), ['thinking', 'tool', 'text'])
  assert.equal(asst.steps[1].title, 'List /etc')
  assert.equal(asst.steps[1].status, 'running')
  const res = claudeRecordSteps({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hosts' }] } })
  assert.deepEqual(res.steps.map((s) => [s.id, s.status, s.output]), [['toolu_1', 'done', 'hosts']])
})

test('foldAgent merges facts, updates a step by id and caps the list', () => {
  let a = foldAgent(null, { agent: { provider: 'codex', via: 'cli', title: 'Icons', status: 'running' } })
  a = foldAgent(a, { step: { id: 't1', kind: 'tool', title: 'Ran a command', status: 'running' } })
  a = foldAgent(a, { step: { id: 't1', kind: 'tool', status: 'done', output: 'ok' } })
  assert.equal(a.steps.length, 1)
  assert.equal(a.steps[0].title, 'Ran a command')
  assert.equal(a.steps[0].status, 'done')
  a = foldAgent(a, { agent: { status: 'done', summary: '' } })
  assert.equal(a.status, 'done')
  assert.equal(a.title, 'Icons')
  for (let i = 0; i < MAX_STEPS + 5; i++) a = foldAgent(a, { step: { id: `x${i}`, kind: 'text', text: String(i) } })
  assert.equal(a.steps.length, MAX_STEPS)
  assert.ok(a.dropped >= 5)
})

test('an agent survives the reply fold, finalize and a save', () => {
  const msg = { role: 'assistant', content: '', parts: [] }
  applyEvent(msg, { type: 'tool', tool: { id: 'c1', phase: 'start', kind: 'command', title: 'Ran codex' } })
  applyEvent(msg, { type: 'agent', toolId: 'c1', agent: { provider: 'codex', via: 'cli', title: 'Icons', status: 'running', startedAt: 1 } })
  applyEvent(msg, { type: 'agent', toolId: 'c1', step: { id: 's1', kind: 'tool', title: 'Ran a command', status: 'running' } })
  applyEvent(msg, { type: 'agent', toolId: 'missing', step: { id: 's2', kind: 'text', text: 'lost' } })
  finalizeMessage(msg, { status: 'done', now: 5 })
  const part = msg.parts[0]
  assert.equal(part.agent.status, 'done')
  assert.equal(part.agent.steps[0].status, 'done')
  const saved = normalizePart(structuredClone(part))
  assert.equal(saved.agent.provider, 'codex')
  assert.equal(saved.agent.steps.length, 1)
  assert.equal(normalizeAgent({ provider: 'x', steps: [{ kind: 'bogus' }] }).steps.length, 0)
})

async function tempHome() {
  const dir = await mkdtemp(join(tmpdir(), 'subagents-'))
  return { dir, done: () => rm(dir, { recursive: true, force: true }) }
}

const line = (o) => `${JSON.stringify(o)}\n`

test('watchSessionLog finds the Codex rollout started with this prompt and tails it', async () => {
  const home = await tempHome()
  try {
    const startedAt = Date.now()
    const d = new Date(startedAt)
    const dayDir = join(home.dir, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
    await mkdir(dayDir, { recursive: true })
    const meta = (id) => ({ type: 'session_meta', payload: { id, timestamp: new Date(startedAt).toISOString(), originator: 'codex_exec' } })
    // Someone else's codex session, started at the same moment.
    await writeFile(join(dayDir, 'rollout-other.jsonl'), line(meta('other')) + line({ type: 'event_msg', payload: { type: 'user_message', message: 'unrelated work' } }))
    const mine = join(dayDir, 'rollout-mine.jsonl')
    const steps = []
    const patches = []
    const w = watchSessionLog({ provider: 'codex', prompt: 'Design an app icon for Totem', startedAt, env: { CODEX_HOME: home.dir }, onStep: (s) => steps.push(s), onPatch: (p) => patches.push(p) })
    await writeFile(mine, line(meta('mine')) + line({ type: 'event_msg', payload: { type: 'user_message', message: 'Design an app icon for Totem, please' } }))
    await new Promise((r) => setTimeout(r, 1200))
    await appendFile(mine, line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'm1', content: [{ type: 'Text', text: 'On it.' }] } } }))
    const found = await w.stop()
    assert.equal(found, true)
    assert.equal(w.file, mine)
    assert.deepEqual(steps.map((s) => s.text), ['On it.'])
    assert.ok(patches.some((p) => p.log === 'live'))
  } finally { await home.done() }
})

test('watchSessionLog finds a new Claude Code session by its first prompt', async () => {
  const home = await tempHome()
  try {
    const startedAt = Date.now()
    const proj = join(home.dir, 'projects', '-tmp-work')
    await mkdir(proj, { recursive: true })
    const steps = []
    const w = watchSessionLog({ provider: 'claude', prompt: 'review the diff in this folder', startedAt, env: { CLAUDE_CONFIG_DIR: home.dir }, onStep: (s) => steps.push(s) })
    await writeFile(join(proj, 'abc.jsonl'),
      line({ type: 'user', timestamp: new Date(startedAt).toISOString(), message: { role: 'user', content: 'review the diff in this folder' } })
      + line({ type: 'assistant', uuid: 'u1', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Looks fine.' }] } }))
    const found = await w.stop()
    assert.equal(found, true)
    assert.deepEqual(steps.map((s) => s.text), ['Looks fine.'])
  } finally { await home.done() }
})

test('createCliAgentWatch opens an agent on a delegating command and settles it on the result', async () => {
  const home = await tempHome()
  try {
    const events = []
    const watch = createCliAgentWatch({ emit: (e) => events.push(e), env: { CODEX_HOME: home.dir } })
    watch.tool({ id: 'c1', phase: 'start', kind: 'command', input: 'ls -la' })
    watch.tool({ id: 'c2', phase: 'start', kind: 'command', input: 'codex exec "make three icons for the app"' })
    watch.tool({ id: 'c2', phase: 'end', status: 'done', output: 'Saved three icons.' })
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(!events.some((e) => e.toolId === 'c1'))
    assert.equal(events[0].agent.provider, 'codex')
    assert.equal(events[0].agent.title, 'make three icons for the app')
    const last = events.filter((e) => e.agent?.status).pop()
    assert.equal(last.agent.status, 'done')
    assert.equal(last.agent.summary, 'Saved three icons.')
    assert.ok(events.some((e) => e.agent?.log === 'none'))
  } finally { await home.done() }
})
