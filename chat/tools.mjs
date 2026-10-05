// chat/tools.mjs — one readable name for a tool call, whichever CLI made it.
//
// The four CLIs spell the same call four ways: cursor nests it as
// `mcpToolCall.args.toolName`, claude as `mcp__totem-gateway__tasks__get_tasks`,
// codex as `{server, tool}`, opencode as `totem-gateway_tasks__get_tasks`. All of
// them, for a Totem app, end in the gateway's own `<app>__<tool>`. The chat shows
// "Looked up tasks" with the Tasks icon rather than any of those strings, so this
// file is where that translation lives — once, for every provider.

const APP_LABELS = {
  tasks: 'Tasks', goals: 'Goals', lists: 'Lists', strava: 'Strava', plaud: 'Plaud', github: 'GitHub',
  'google-calendar': 'Calendar', calendar: 'Calendar', krakatoa: 'Krakatoa', vercel: 'Vercel', habits: 'Habits',
  'youtube-transcript': 'YouTube', notion: 'Notion', gmail: 'Gmail', slack: 'Slack', linear: 'Linear',
  'computer-use': 'Computer', computer_use: 'Computer', browser: 'Browser', playwright: 'Browser',
}

const VERBS = [
  [/^(get|list|read|fetch|search|find|query|lookup|view|show|check|status)$/, 'Looked up'],
  [/^(create|add|new|insert|log|save|post|send|upload|start)$/, 'Added'],
  [/^(update|edit|set|patch|move|rename|modify|complete|close|reopen|respond|link|unlink|postpone)$/, 'Updated'],
  [/^(delete|remove|archive|purge|cancel)$/, 'Removed'],
  [/^(sync|refresh|import)$/, 'Synced'],
]

const OBJECT_FIXES = { 'free busy': 'availability', 'freebusy': 'availability', 'current time': 'the time', 'me': 'account' }

export const truncate = (s, n) => {
  const t = String(s ?? '')
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

export function appLabel(app) {
  if (!app) return ''
  return APP_LABELS[app] || app.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

/**
 * Split any provider's spelling into { server, app, tool }. `server` is the MCP
 * server the CLI connected to (usually `totem-gateway`); `app` is the Totem app
 * behind it when the tool came through the gateway.
 */
export function parseToolName(raw, serverHint = '') {
  let name = String(raw || '').trim()
  let server = String(serverHint || '').trim()
  const claude = /^mcp__([^_]+(?:[-_][^_]+)*?)__(.+)$/.exec(name)
  if (claude) { server = server || claude[1]; name = claude[2] }
  // opencode prefixes the server with a single underscore; cursor with a dash.
  for (const prefix of [`${server}-`, `${server}_`, 'totem-gateway-', 'totem-gateway_']) {
    if (prefix.length > 1 && name.startsWith(prefix)) { name = name.slice(prefix.length); break }
  }
  const gw = /^([a-z0-9][a-z0-9-]*)__(.+)$/i.exec(name)
  if (gw) return { server: server || 'totem-gateway', app: gw[1].toLowerCase(), tool: gw[2] }
  return { server, app: server && server !== 'totem-gateway' ? server.toLowerCase() : '', tool: name }
}

export function humanizeTool(tool) {
  const words = String(tool || '').replace(/([a-z])([A-Z])/g, '$1 $2').split(/[\s_\-]+/).filter(Boolean).map((w) => w.toLowerCase())
  if (!words.length) return 'Used a tool'
  const [first, ...rest] = words
  const verb = VERBS.find(([re]) => re.test(first))?.[1]
  let object = rest.join(' ')
  object = OBJECT_FIXES[object] || object
  if (verb && object) return `${verb} ${object}`
  if (verb) return verb
  const all = words.join(' ')
  return all.charAt(0).toUpperCase() + all.slice(1)
}

export function inputDetail(input) {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? truncate(input, 300) : ''
  const pick = input.command || input.query || input.q || input.title || input.content || input.text || input.name ||
    input.summary || input.file_path || input.filePath || input.path || input.url || input.pattern || input.prompt ||
    input.description || input.id
  if (typeof pick === 'string' && pick.trim()) return truncate(pick.trim().replace(/\s+/g, ' '), 300)
  return ''
}

export function stringifyInput(input) {
  if (input == null) return ''
  if (typeof input === 'string') return truncate(input, 4000)
  try { return truncate(JSON.stringify(input, null, 2), 4000) } catch { return '' }
}

/** Flatten an MCP/tool result (string, content blocks, nested success) to text. */
export function resultText(result) {
  if (result == null) return ''
  if (typeof result === 'string') return truncate(result, 6000)
  if (Array.isArray(result)) {
    return truncate(result.map((c) => {
      if (typeof c === 'string') return c
      if (typeof c?.text === 'string') return c.text
      if (typeof c?.text?.text === 'string') return c.text.text
      if (c?.type === 'image') return '[image]'
      return ''
    }).filter(Boolean).join('\n'), 6000)
  }
  if (typeof result === 'object') {
    if (result.success !== undefined) return resultText(result.success)
    if (result.error !== undefined) return resultText(result.error)
    if (result.content !== undefined) return resultText(result.content)
    if (typeof result.stdout === 'string' || typeof result.stderr === 'string') {
      return truncate([result.stdout, result.stderr].filter(Boolean).join('\n').trim(), 6000)
    }
    try { return truncate(JSON.stringify(result, null, 2), 6000) } catch { return '' }
  }
  return truncate(String(result), 6000)
}

/** The card for an MCP call. */
// The browser's preview_* calls, said the way a person would: "Opened
// example.com", "Clicked Learn more". Whichever CLI made the call (totem-browser
// directly, or browser__preview_* through the gateway), the card reads the same.
const host = (u) => { try { return new URL(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`).host.replace(/^www\./, '') } catch { return String(u || '').slice(0, 60) } }
const target = (a) => {
  const m = /name=["']([^"']+)["']/.exec(a?.locator || '') || /^text=["']?([^"']+)["']?$/.exec(a?.locator || '')
  return m ? `“${m[1]}”` : a?.locator || a?.selector || (a?.x !== undefined ? `${a.x}, ${a.y}` : 'the page')
}
export function describeBrowserCall(tool, input) {
  let a = input
  if (typeof a === 'string') { try { a = JSON.parse(a) } catch { a = {} } }
  a = a || {}
  switch (tool) {
    case 'preview_open': return a.url ? `Opened ${host(a.url)}` : 'Opened the browser'
    case 'preview_navigate': return a.url || a.target?.url ? `Went to ${host(a.url || a.target.url)}` : a.target?.port ? `Went to localhost:${a.target.port}${a.target.path || ''}` : 'Navigated'
    case 'preview_snapshot': return 'Looked at the page'
    case 'preview_status': return 'Checked the browser'
    case 'preview_click': return `Clicked ${target(a)}`
    case 'preview_type': return `Typed into ${a.locator || a.selector ? target(a) : 'the page'}`
    case 'preview_press': return `Pressed ${[...(a.modifiers || []), a.key].filter(Boolean).join('+') || 'a key'}`
    case 'preview_scroll': return (a.deltaY || 0) < 0 ? 'Scrolled up' : 'Scrolled down'
    case 'preview_evaluate': return 'Ran JavaScript on the page'
    case 'preview_wait_for': return a.text ? `Waited for “${String(a.text).slice(0, 40)}”` : 'Waited for the page'
    case 'preview_resize': return a.mode === 'preset' ? `Resized to ${String(a.preset || '').replace(/-/g, ' ')}` : 'Resized the page'
    case 'preview_set_appearance': return `Switched to ${a.colorScheme || 'system'} mode`
    default: return null
  }
}

export function describeMcpCall({ name, server, input }) {
  const parsed = parseToolName(name, server)
  const browser = /^preview_/.test(parsed.tool) ? describeBrowserCall(parsed.tool, input) : null
  return {
    kind: 'mcp',
    ...(browser ? { browser: true } : {}),
    title: browser || humanizeTool(parsed.tool),
    detail: inputDetail(input),
    server: parsed.app || parsed.server || '',
    tool: parsed.tool,
    input: stringifyInput(input),
  }
}

export function describeCommand(command, description) {
  return { kind: 'command', title: description ? truncate(description, 120) : 'Ran a command', detail: truncate(command || '', 400), input: truncate(command || '', 4000) }
}
