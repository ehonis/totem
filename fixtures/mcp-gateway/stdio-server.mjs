// A downstream stdio MCP server that misbehaves on purpose, for mcp-gateway.test.mjs.
// argv[2] is the mode:
//   hang           never answers, ignores SIGTERM and outlives a closed stdin
//   launcher       starts `hang` as its own child and waits, as npx starts a real server
//   repeat-cursor  answers every tools/list page with the same nextCursor
//   endless        a new cursor on every tools/list page, for ever
//   slow-call      a normal server whose tools/call answers after $FIXTURE_CALL_MS
// Every process appends its pid to $FIXTURE_PID_FILE, so a test can check it died.
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const mode = process.argv[2]
if (process.env.FIXTURE_PID_FILE) appendFileSync(process.env.FIXTURE_PID_FILE, `${process.pid}\n`)

if (mode === 'launcher') {
  const child = spawn(process.execPath, [process.argv[1], 'hang'], { stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 1))
} else {
  if (mode === 'hang') {
    process.on('SIGTERM', () => {})
    setInterval(() => {}, 60_000)
  }
  const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  const tool = (name) => ({ name, description: name, inputSchema: { type: 'object' } })
  let page = 0
  createInterface({ input: process.stdin }).on('line', (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.id == null || mode === 'hang') return
    if (msg.method === 'initialize') {
      send(msg.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `fixture-${mode}`, version: '1.0.0' } })
    } else if (msg.method === 'tools/list') {
      page += 1
      if (mode === 'repeat-cursor') send(msg.id, { tools: [tool('echo')], nextCursor: 'again' })
      else if (mode === 'endless') send(msg.id, { tools: [tool(`tool_${page}`)], nextCursor: `page-${page}` })
      else send(msg.id, { tools: [tool('slow_echo')] })
    } else if (msg.method === 'tools/call') {
      setTimeout(() => send(msg.id, { content: [{ type: 'text', text: `done: ${msg.params?.name}` }] }), Number(process.env.FIXTURE_CALL_MS || 0))
    }
  })
}
