// chat/subagents.mjs — the agents a chat's agent hands work to, and what they do.
//
// A reply's agent can start another agent in two ways:
//
//   • its own sub-agent: Claude Code's Agent/Task tool, Codex's collab tools. The
//     parent's stream carries the child's steps (Claude tags them with
//     `parent_tool_use_id`) or names the child's thread (Codex).
//   • another CLI from a shell: Claude running `codex exec "make an icon…"`. The
//     parent only sees one long command. The child writes its own session log as it
//     goes (Codex `~/.codex/sessions/…/rollout-*.jsonl`, Claude Code
//     `~/.claude/projects/<cwd>/<session>.jsonl`), so the bridge finds that file by
//     its start time and prompt and tails it.
//
// Either way the child's work folds into the tool card that started it, as
// `part.agent`: who it is, its status, and a capped list of steps (thinking, what
// it said, each tool call). The chat's Agents panel shows that list live.
//
// Pure parsing and folding live here with the watcher; bridge.mjs wires them into
// each provider's streamer and the chat run.

import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { truncate, describeCommand, describeMcpCall, humanizeTool, resultText, chatToolFromClaude } from './tools.mjs'

export const MAX_STEPS = 400
const STEP_TEXT = 4000
const STEP_INPUT = 2000
const STEP_OUTPUT = 3000
const AGENT_PROMPT = 6000
const AGENT_SUMMARY = 6000

export const AGENT_PROVIDERS = { codex: 'Codex', claude: 'Claude', cursor: 'Cursor', opencode: 'OpenCode', gemini: 'Gemini' }
export const agentLabel = (provider) => AGENT_PROVIDERS[provider] || String(provider || 'Agent')

/** Claude Code's tools that start a sub-agent. */
export const isClaudeAgentTool = (name) => name === 'Agent' || name === 'Task'

// --- Spotting another agent CLI in a shell command ------------------------------

// Split a command line on unquoted ; & | and newlines. Quotes are tracked so a
// prompt containing "; then" stays one piece.
function segments(command) {
  const out = []
  let cur = ''
  let quote = ''
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      cur += c
      if (c === '\\' && quote === '"' && i + 1 < command.length) { cur += command[++i]; continue }
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue }
    if (c === '\\' && i + 1 < command.length) { cur += c + command[++i]; continue }
    if (c === ';' || c === '&' || c === '|' || c === '\n') { if (cur.trim()) out.push(cur); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) out.push(cur)
  return out
}

// Words of one segment with quotes removed ("a b" is one word).
function words(segment) {
  const out = []
  const re = /\$'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(segment))) {
    if (m[1] != null) out.push({ text: m[1].replace(/\\n/g, '\n').replace(/\\(.)/g, '$1'), quoted: true })
    else if (m[2] != null) out.push({ text: m[2].replace(/\\(["\\$`])/g, '$1'), quoted: true })
    else if (m[3] != null) out.push({ text: m[3], quoted: true })
    else out.push({ text: m[4], quoted: false })
  }
  return out
}

const WRAPPERS = new Set(['sudo', 'nohup', 'env', 'time', 'exec', 'command', 'timeout', 'gtimeout', 'npx', 'bunx', 'pnpx', 'stdbuf'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish'])
const base = (w) => w.replace(/^.*\//, '')

// The heredoc body fed to a command (`codex exec - <<'EOF' … EOF`), if any.
function heredoc(command) {
  const m = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*(?:\n|$)/.exec(command)
  return m ? m[3] : ''
}

function cliIn(segment, command, depth) {
  const ws = words(segment)
  let i = 0
  // Skip env assignments and wrappers (`timeout 600`, `npx -y`, `env FOO=1`).
  while (i < ws.length) {
    const w = ws[i].text
    if (!ws[i].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue }
    if (WRAPPERS.has(base(w))) {
      i++
      while (i < ws.length && (/^-/.test(ws[i].text) || /^\d+[smhd]?$/.test(ws[i].text))) i++
      continue
    }
    break
  }
  if (i >= ws.length) return null
  const head = base(ws[i].text)
  const rest = ws.slice(i + 1)
  // `zsh -lc '<command>'`: what the shell runs is the command.
  if (SHELLS.has(head) && depth < 2) {
    const at = rest.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w.text))
    if (at >= 0 && rest[at + 1]) return detectAgentCli(rest[at + 1].text, depth + 1)
    return null
  }
  const flags = rest.map((w) => w.text)
  let provider = ''
  if (/^(codex|@openai\/codex)$/.test(head) && rest.some((w) => !w.quoted && (w.text === 'exec' || w.text === 'e'))) provider = 'codex'
  else if (head === 'claude' && flags.some((f) => f === '-p' || f === '--print')) provider = 'claude'
  else if (head === 'cursor-agent' || (head === 'cursor' && flags[0] === 'agent')) provider = 'cursor'
  else if (head === 'opencode' && flags[0] === 'run') provider = 'opencode'
  else if (head === 'gemini' && flags.some((f) => f === '-p' || f === '--prompt')) provider = 'gemini'
  if (!provider) return null
  // The prompt: the longest quoted argument, else the heredoc it reads.
  const quoted = rest.filter((w) => w.quoted).map((w) => w.text).sort((a, b) => b.length - a.length)[0] || ''
  const prompt = (quoted.length >= 12 ? quoted : heredoc(command) || quoted).trim()
  return { provider, prompt: truncate(prompt, AGENT_PROMPT) }
}

/**
 * The agent CLI a shell command starts, if it starts one: `{ provider, prompt }`
 * or null. Only the forms that run a prompt count (`codex exec`, `claude -p`,
 * `cursor-agent`, `opencode run`, `gemini -p`); `codex login` does not.
 */
export function detectAgentCli(command, depth = 0) {
  const text = String(command || '')
  if (!/\b(codex|claude|cursor-agent|cursor|opencode|gemini)\b/.test(text)) return null
  for (const seg of segments(text)) {
    const hit = cliIn(seg, text, depth)
    if (hit) return hit
  }
  return null
}

// --- Steps from session logs and streams ----------------------------------------

const clipStep = (s) => {
  const out = { ...s }
  if (out.text) out.text = truncate(out.text, STEP_TEXT)
  if (out.input) out.input = truncate(out.input, STEP_INPUT)
  if (out.output) out.output = truncate(out.output, STEP_OUTPUT)
  if (out.detail) out.detail = truncate(out.detail, 400)
  return out
}

const toolStep = (id, card, extra = {}) => clipStep({
  id, kind: 'tool', title: card.title, ...(card.detail ? { detail: card.detail } : {}),
  ...(card.kind ? { tool: card.kind } : {}), ...(card.server ? { server: card.server } : {}),
  ...(card.input ? { input: card.input } : {}), ...extra,
})

const textOf = (content) => (Array.isArray(content)
  ? content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('')
  : String(content || ''))

/**
 * One Claude Code record (a stream-json event or a line of its session file:
 * the two share a shape) as agent steps and facts. `at` stamps new steps.
 */
export function claudeRecordSteps(record, at = Date.now()) {
  const steps = []
  const patch = {}
  const msg = record?.message
  if (record?.type === 'assistant' && Array.isArray(msg?.content)) {
    if (msg.model && !/^<synthetic>$/.test(msg.model)) patch.model = msg.model
    msg.content.forEach((b, i) => {
      const key = `${record.uuid || msg.id || 'm'}:${i}`
      if (b?.type === 'thinking' && String(b.thinking || '').trim()) steps.push(clipStep({ id: key, kind: 'thinking', text: b.thinking.trim(), at }))
      else if (b?.type === 'text' && String(b.text || '').trim()) steps.push(clipStep({ id: key, kind: 'text', text: b.text.trim(), at }))
      else if (b?.type === 'tool_use' && b.id) steps.push(toolStep(b.id, chatToolFromClaude(b), { status: 'running', at }))
    })
  } else if (record?.type === 'user' && Array.isArray(msg?.content)) {
    for (const b of msg.content) {
      if (b?.type !== 'tool_result' || !b.tool_use_id) continue
      steps.push(clipStep({ id: b.tool_use_id, kind: 'tool', status: b.is_error ? 'error' : 'done', output: resultText(b.content), endedAt: at }))
    }
  }
  return { steps, patch }
}

const commandText = (c) => (Array.isArray(c) ? c[c.length - 1] : String(c || ''))
const changedFiles = (changes) => (Array.isArray(changes) ? changes.map((c) => c?.path).filter(Boolean) : Object.keys(changes || {}))

function codexItemStep(item, at) {
  const id = item.id || ''
  const failed = item.status === 'failed' || item.error != null || (item.exit_code != null && item.exit_code !== 0)
  const status = failed ? 'error' : 'done'
  switch (item.type) {
    case 'AgentMessage': {
      const text = textOf(item.content).trim()
      return text ? clipStep({ id, kind: 'text', text, at }) : null
    }
    case 'Reasoning': {
      const text = [...(item.summary_text || []), ...(item.raw_content || [])].map((t) => (typeof t === 'string' ? t : t?.text || '')).join('\n\n').trim()
      return text ? clipStep({ id, kind: 'thinking', text, at }) : null
    }
    case 'CommandExecution':
      return toolStep(id, describeCommand(commandText(item.command), ''), { status, output: item.aggregated_output || [item.stdout, item.stderr].filter(Boolean).join('\n'), at, endedAt: at })
    case 'McpToolCall':
      return toolStep(id, describeMcpCall({ name: item.tool, server: item.server, input: item.arguments }), { status, output: resultText(item.result ?? item.error), at, endedAt: at })
    case 'FileChange': {
      const files = changedFiles(item.changes)
      return toolStep(id, { kind: 'edit', title: files.length > 1 ? `Edited ${files.length} files` : 'Edited a file', detail: files.join(', ') }, { status, at, endedAt: at })
    }
    case 'ImageView':
      return toolStep(id, { kind: 'view_image', title: 'Looked at an image', detail: String(item.path || '').replace(/^file:\/\//, '') }, { status, at, endedAt: at })
    case 'Extension':
      if (/image_gen/.test(item.kind || '')) return toolStep(id, { kind: 'image_generation', title: 'Made an image', detail: item.revisedPrompt || item.prompt || '' }, { status, output: item.savedPath || item.path || '', at, endedAt: at })
      if (/search/.test(item.kind || '')) return toolStep(id, { kind: 'web_search', title: 'Searched the web', detail: item.query || item.action?.query || '' }, { status, at, endedAt: at })
      return toolStep(id, { kind: 'tool', title: humanizeTool(String(item.kind || 'extension').split('.').pop()) }, { status, at, endedAt: at })
    case 'UserMessage':
    case 'ContextCompaction':
      return null
    default:
      return item.type ? toolStep(id, { kind: 'tool', title: humanizeTool(item.type) }, { status, at, endedAt: at }) : null
  }
}

/**
 * One line of a Codex rollout file as agent steps and facts. Newer Codex writes
 * every step as `event_msg/item_completed`; older builds wrote `agent_message`,
 * `exec_command_end` and the like, which share ids with the new form (`exec-…`),
 * so a file holding both folds each step once.
 */
export function codexRolloutSteps(record, at = Date.now()) {
  const steps = []
  const patch = {}
  const p = record?.payload || {}
  if (record?.type === 'turn_context' && p.model) patch.model = p.model
  if (record?.type === 'event_msg') {
    switch (p.type) {
      case 'item_completed': { const s = p.item && codexItemStep(p.item, at); if (s) steps.push(s); break }
      case 'agent_message': if (String(p.message || '').trim()) steps.push(clipStep({ id: `msg:${hashText(p.message)}`, kind: 'text', text: p.message.trim(), at })); break
      case 'agent_reasoning': if (String(p.text || '').trim()) steps.push(clipStep({ id: `rs:${hashText(p.text)}`, kind: 'thinking', text: p.text.trim(), at })); break
      case 'exec_command_end': steps.push(toolStep(p.call_id || '', describeCommand(commandText(p.command), ''), { status: p.exit_code ? 'error' : 'done', output: p.aggregated_output || p.stdout || '', at, endedAt: at })); break
      case 'mcp_tool_call_end': {
        const inv = p.invocation || {}
        steps.push(toolStep(p.call_id || '', describeMcpCall({ name: inv.tool, server: inv.server, input: inv.arguments }), { status: p.result?.Err ? 'error' : 'done', output: resultText(p.result?.Ok ?? p.result?.Err ?? p.result), at, endedAt: at }))
        break
      }
      case 'patch_apply_end': {
        const files = changedFiles(p.changes)
        steps.push(toolStep(p.call_id || '', { kind: 'edit', title: files.length > 1 ? `Edited ${files.length} files` : 'Edited a file', detail: files.join(', ') }, { status: p.success === false ? 'error' : 'done', at, endedAt: at }))
        break
      }
      case 'web_search_end': steps.push(toolStep(p.call_id || '', { kind: 'web_search', title: 'Searched the web', detail: p.query || '' }, { status: 'done', at, endedAt: at })); break
      case 'sub_agent_activity': if (p.kind === 'started') steps.push(toolStep(p.event_id || `sa:${p.agent_thread_id}`, { kind: 'agent', title: 'Started a sub-agent', detail: String(p.agent_path || '').split('/').pop() }, { status: 'done', at })); break
      case 'token_count': { const n = p.info?.total_token_usage?.total_tokens; if (Number.isFinite(n)) patch.tokens = n; break }
      case 'task_complete': if (String(p.last_agent_message || '').trim()) patch.summary = truncate(p.last_agent_message.trim(), AGENT_SUMMARY); break
      default: break
    }
  }
  return { steps, patch }
}

// Old-form messages carry no id; their text is their identity, so the same
// message written twice (event and item) folds once.
function hashText(s) {
  let h = 0
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0
  return (h >>> 0).toString(36)
}

// --- Folding into the tool card ---------------------------------------------------

const AGENT_STATUSES = new Set(['running', 'done', 'error', 'stopped'])
const PATCH_KEYS = ['provider', 'via', 'name', 'title', 'prompt', 'model', 'status', 'progress', 'summary', 'tokens', 'toolUses', 'log', 'startedAt', 'endedAt']

/**
 * Fold one `agent` event ({ toolId, agent: patch, step }) into a tool part.
 * Returns a new agent object; the part is not mutated. The browser's twin is
 * web/src/chat/reduce.ts › foldAgent; keep the two in step.
 */
export function foldAgent(current, event) {
  const next = { status: 'running', steps: [], ...(current || {}) }
  const patch = event?.agent || {}
  for (const k of PATCH_KEYS) if (patch[k] !== undefined && patch[k] !== null && patch[k] !== '') next[k] = patch[k]
  if (next.prompt) next.prompt = truncate(next.prompt, AGENT_PROMPT)
  if (next.summary) next.summary = truncate(next.summary, AGENT_SUMMARY)
  const step = event?.step
  if (step?.id || step?.kind) {
    const steps = next.steps.slice()
    const at = step.id ? steps.findIndex((s) => s.id === step.id) : -1
    if (at >= 0) steps[at] = { ...steps[at], ...step }
    else if (step.kind) steps.push({ ...step, id: step.id || `s${steps.length}` })
    if (steps.length > MAX_STEPS) {
      next.dropped = (next.dropped || 0) + steps.length - MAX_STEPS
      steps.splice(0, steps.length - MAX_STEPS)
    }
    next.steps = steps
  }
  return next
}

/** A stored `part.agent`, cleaned (chat/store.mjs › normalizePart). */
export function normalizeAgent(a) {
  if (!a || typeof a !== 'object') return null
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0)
  const out = { provider: str(a.provider, 40) || 'agent', status: AGENT_STATUSES.has(a.status) ? a.status : 'done' }
  for (const [k, n] of [['via', 20], ['name', 80], ['title', 300], ['prompt', AGENT_PROMPT], ['model', 120], ['progress', 300], ['summary', AGENT_SUMMARY], ['log', 20]]) {
    const v = str(a[k], n)
    if (v) out[k] = v
  }
  for (const k of ['tokens', 'toolUses', 'startedAt', 'endedAt', 'dropped']) if (num(a[k])) out[k] = num(a[k])
  out.steps = (Array.isArray(a.steps) ? a.steps : []).slice(-MAX_STEPS).map((s, i) => {
    if (!s || typeof s !== 'object' || !['thinking', 'text', 'tool'].includes(s.kind)) return null
    const step = { id: str(s.id, 160) || `s${i}`, kind: s.kind }
    for (const [k, n] of [['text', STEP_TEXT], ['title', 200], ['detail', 400], ['tool', 80], ['server', 80], ['input', STEP_INPUT], ['output', STEP_OUTPUT]]) {
      const v = str(s[k], n)
      if (v) step[k] = v
    }
    if (['running', 'done', 'error'].includes(s.status)) step.status = s.status
    if (num(s.at)) step.at = num(s.at)
    if (num(s.endedAt)) step.endedAt = num(s.endedAt)
    return step
  }).filter(Boolean)
  return out
}

// --- Tailing another CLI's session log -------------------------------------------

const POLL_MS = 900
const HEAD_BYTES = 512 * 1024
const CLOCK_SLACK_MS = 5000

const needleOf = (prompt) => String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 80)
const squash = (s) => String(s || '').replace(/\s+/g, ' ')

function dateDirs(root, at) {
  const out = new Set()
  for (const t of [at, at - 86_400_000]) {
    const d = new Date(t)
    const local = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')]
    const utc = [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')]
    out.add(join(root, ...local.map(String)))
    out.add(join(root, ...utc.map(String)))
  }
  return [...out]
}

async function listJsonl(dir) {
  try { return (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f)) } catch { return [] }
}

async function readSlice(path, from, max) {
  let fh
  try {
    fh = await open(path, 'r')
    const buf = Buffer.alloc(max)
    const { bytesRead } = await fh.read(buf, 0, max, from)
    return buf.subarray(0, bytesRead)
  } catch { return null } finally { await fh?.close().catch(() => {}) }
}

const parseLines = (text) => text.split('\n').map((l) => { try { return l.trim() ? JSON.parse(l) : null } catch { return null } }).filter(Boolean)

// Does a session file belong to this delegation? `null` = can't tell yet.
function codexMatch(records, { needle, startedAt, threadId }) {
  const meta = records.find((r) => r.type === 'session_meta')?.payload
  if (!meta) return null
  if (threadId) return meta.id === threadId || meta.session_id === threadId
  const t = Date.parse(meta.timestamp || '')
  if (Number.isFinite(t) && t < startedAt - CLOCK_SLACK_MS) return false
  if (!needle) return meta.originator === 'codex_exec' || meta.source === 'exec'
  // The prompt itself is the `user_message` event (or UserMessage item); the
  // user-role messages before it are AGENTS.md and environment context.
  const asked = records.filter((r) => r.type === 'event_msg' && (r.payload?.type === 'user_message' || r.payload?.item?.type === 'UserMessage'))
    .map((r) => squash(r.payload.message ?? textOf(r.payload.item?.content)))
  if (asked.some((s) => s.includes(needle))) return true
  if (asked.length) return false
  const said = records.filter((r) => r.type === 'response_item' && r.payload?.role === 'user').map((r) => squash(textOf(r.payload.content)))
  return said.some((s) => s.includes(needle)) ? true : null
}

function claudeMatch(records, { needle, startedAt }) {
  const first = records.find((r) => r.type === 'user' && r.message)
  if (!first) return null
  const t = Date.parse(first.timestamp || '')
  if (Number.isFinite(t) && t < startedAt - CLOCK_SLACK_MS) return false
  if (first.isSidechain) return false
  if (!needle) return true
  return squash(typeof first.message.content === 'string' ? first.message.content : textOf(first.message.content)).includes(needle)
}

/** Where a CLI keeps its session logs, given the environment the child ran in. */
export function sessionRoots(provider, env = process.env) {
  if (provider === 'codex') return [join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')]
  if (provider === 'claude') return [join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')]
  return []
}

/**
 * Find and tail the session log of an agent started at `startedAt` with
 * `prompt` (or, for a Codex sub-agent, known by `threadId`). Each new record is
 * parsed into steps for `onStep` and facts for `onPatch`. `stop()` reads what is
 * left and stops; it resolves to whether a log was ever found.
 */
export function watchSessionLog({ provider, prompt = '', threadId = '', startedAt = Date.now(), env = process.env, onStep, onPatch, log = () => {} }) {
  const roots = sessionRoots(provider, env)
  const parse = provider === 'codex' ? codexRolloutSteps : claudeRecordSteps
  const match = provider === 'codex' ? codexMatch : claudeMatch
  const needle = needleOf(prompt)
  const rejected = new Set()
  let file = ''
  let offset = 0
  let partial = ''
  let stopped = false
  let timer = null
  let busy = Promise.resolve()

  const emitRecords = (records) => {
    for (const r of records) {
      const { steps, patch } = parse(r)
      if (Object.keys(patch).length) onPatch?.(patch)
      for (const s of steps) onStep?.(s)
    }
  }

  async function candidates() {
    if (provider === 'codex') {
      const files = (await Promise.all(roots.flatMap((r) => dateDirs(r, startedAt)).map(listJsonl))).flat()
      return threadId ? files.filter((f) => f.endsWith(`${threadId}.jsonl`)) : files
    }
    // Claude: a project folder gains a file when a session starts in it.
    const out = []
    for (const root of roots) {
      let dirs = []
      try { dirs = await readdir(root) } catch { continue }
      for (const d of dirs) {
        const dir = join(root, d)
        const s = await stat(dir).catch(() => null)
        if (s?.isDirectory() && s.mtimeMs >= startedAt - CLOCK_SLACK_MS) out.push(...await listJsonl(dir))
      }
    }
    return out
  }

  async function find() {
    for (const path of await candidates()) {
      if (rejected.has(path)) continue
      const s = await stat(path).catch(() => null)
      const born = s?.birthtimeMs || s?.ctimeMs || 0
      if (!s || (!threadId && born < startedAt - CLOCK_SLACK_MS)) { rejected.add(path); continue }
      const head = await readSlice(path, 0, Math.min(HEAD_BYTES, s.size))
      if (!head) continue
      const verdict = match(parseLines(head.toString('utf8')), { needle, startedAt, threadId })
      if (verdict === false) { rejected.add(path); continue }
      if (verdict === true) return path
    }
    return ''
  }

  async function tail() {
    for (;;) {
      const chunk = await readSlice(file, offset, 1024 * 1024)
      if (!chunk?.length) return
      offset += chunk.length
      const text = partial + chunk.toString('utf8')
      const cut = text.lastIndexOf('\n')
      partial = cut < 0 ? text : text.slice(cut + 1)
      if (cut >= 0) emitRecords(parseLines(text.slice(0, cut)))
      if (chunk.length < 1024 * 1024) return
    }
  }

  const tick = () => {
    busy = busy.then(async () => {
      if (!file) {
        file = await find()
        if (file) { onPatch?.({ log: 'live' }); log(`subagent: tailing ${provider} log ${file}`) }
      }
      if (file) await tail()
    }).catch((e) => log('subagent log read failed', e?.message || e))
    return busy
  }

  const loop = () => { if (stopped) return; tick().finally(() => { if (!stopped) timer = setTimeout(loop, POLL_MS) }) }
  loop()

  return {
    async stop() {
      stopped = true
      clearTimeout(timer)
      await busy
      // One last look: the child writes its final lines as it exits.
      await tick()
      if (partial.trim()) { emitRecords(parseLines(partial)); partial = '' }
      if (!file) onPatch?.({ log: 'none' })
      return !!file
    },
    get file() { return file },
  }
}

/**
 * Per chat run: watches tool cards for commands that start another agent CLI,
 * and for each one tails that CLI's own log into the card. `emit` receives
 * `agent` events ({ toolId, agent, step }).
 */
export function createCliAgentWatch({ emit, env = process.env, log = () => {} }) {
  const live = new Map() // toolId -> { watcher, info }

  function tool(t) {
    if (!t?.id) return
    if (t.phase !== 'end') {
      if (live.has(t.id) || t.kind !== 'command') return
      const hit = detectAgentCli(t.input || t.detail || '')
      if (!hit) return
      const startedAt = Date.now()
      const info = { provider: hit.provider, via: 'cli', title: firstLine(hit.prompt) || `Ran ${agentLabel(hit.provider)}`, prompt: hit.prompt, status: 'running', startedAt }
      emit({ toolId: t.id, agent: info })
      const canTail = sessionRoots(hit.provider, env).length > 0
      const watcher = canTail
        ? watchSessionLog({
          provider: hit.provider, prompt: hit.prompt, startedAt, env, log,
          onStep: (step) => emit({ toolId: t.id, step }),
          onPatch: (patch) => emit({ toolId: t.id, agent: patch }),
        })
        : null
      if (!canTail) emit({ toolId: t.id, agent: { log: 'none' } })
      live.set(t.id, { watcher, info, steps: 0 })
      return
    }
    const entry = live.get(t.id)
    if (!entry) return
    live.delete(t.id)
    finish(t.id, entry, t.status === 'error' ? 'error' : 'done', t.output || '')
  }

  async function finish(toolId, entry, status, output) {
    if (entry.watcher) await entry.watcher.stop().catch(() => {})
    const endedAt = Date.now()
    emit({ toolId, agent: { status, endedAt, ...(output ? { summary: truncate(output, AGENT_SUMMARY) } : {}) } })
  }

  /** The run is over: settle every delegation still open. */
  async function close(status = 'done') {
    const open = [...live.entries()]
    live.clear()
    await Promise.all(open.map(([id, entry]) => finish(id, entry, status === 'error' ? 'error' : status === 'stopped' ? 'stopped' : 'done', '')))
  }

  return { tool, close }
}

const firstLine = (s) => truncate(String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || '', 140)
