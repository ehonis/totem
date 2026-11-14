// The gateway re-serves the bridge's totem_usage_* tools as usage__*. A fake bridge
// on 127.0.0.1 stands in for /mcp; nothing reaches the network or a real bridge.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const calls = []
const auth = []
const TOOLS = ['totem_usage_get_current', 'totem_usage_get_history', 'totem_usage_limit_report', 'totem_usage_forecast', 'totem_usage_plan', 'totem_usage_set_plan', 'totem_away_list']
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const msg = JSON.parse(body)
    auth.push(req.headers.authorization)
    if (msg.id == null) { res.writeHead(202); return res.end() }
    const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })) }
    if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'totem', version: 'test' } })
    if (msg.method === 'tools/list') return reply({ tools: TOOLS.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) })
    if (msg.method === 'tools/call') { calls.push(msg.params); return reply({ content: [{ type: 'text', text: '{}' }] }) }
    reply({})
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))

const oauth = mkdtempSync(join(tmpdir(), 'totem-usage-gateway-'))
process.env.GATEWAY_OAUTH_DIR = oauth
process.env.BRIDGE_SECRET = 'test-bridge-secret'
process.env.BRIDGE_PORT = String(server.address().port)
delete process.env.TOTEM_BROWSER_TOKEN
const { Gateway } = await import('../mcp-gateway.mjs')

const fake = (name) => ({
  async start() {},
  async listTools() { return [{ name, description: name, inputSchema: { type: 'object' } }] },
  async callTool() { return { content: [] } },
  close() {},
})

test('usage__* is a gateway builtin over the bridge, limited to the five read tools', { timeout: 10_000 }, async (t) => {
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(oauth, { recursive: true, force: true }) })
  const gateway = new Gateway({ servers: {} }, {
    taskClient: fake('get_tasks'), goalClient: fake('get_goals'), listClient: fake('get_lists'), recClient: fake('list'),
  })
  await gateway.connectAll()
  const names = gateway.tools.map((tool) => tool.name)
  const usage = names.filter((n) => n.startsWith('usage__')).sort()
  assert.deepEqual(usage, ['usage__forecast', 'usage__get_current', 'usage__get_history', 'usage__limit_report', 'usage__plan'])
  assert.equal(gateway.health.get('usage').ok, true)

  await gateway.callTool('usage__limit_report', { days: 21 })
  assert.deepEqual(calls.at(-1), { name: 'totem_usage_limit_report', arguments: { days: 21 } })
  await gateway.callTool('usage__plan', { size: 'large', withinHours: 12 })
  assert.deepEqual(calls.at(-1), { name: 'totem_usage_plan', arguments: { size: 'large', withinHours: 12 } })
  assert.ok(auth.every((a) => a === 'Bearer test-bridge-secret'))
  gateway.closeAll()
})
