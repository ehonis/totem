// sources/gateway.mjs — the MCP gateway's status check, as runs.
//
// The status check (`mcp-gateway.mjs --status`, run by the bridge when
// Connections is open) is the one place every manifest server is connected and
// listed, so each check is one run per server. Built-ins (tasks, goals, …) are
// Totem's own and not a source. A server waiting for its sign-in is not set up,
// not failing. Refreshing Connections three times in a row is three runs seconds
// apart, which is not long enough to count as failing (health.mjs).
export function recordGatewayStatus(runs, data, { at = new Date().toISOString() } = {}) {
  if (!data?.ok) return runs.record({ source: 'mcp-gateway', finishedAt: at, ok: false, error: data?.error || 'gateway status failed' })
  runs.record({ source: 'mcp-gateway', finishedAt: at, ok: true, rows: data.totalTools })
  for (const server of data.servers || []) {
    if (server.builtin) continue
    const source = `mcp:${server.id}`
    if (server.needsAuth) runs.markUnconfigured(source, 'waiting for its sign-in')
    else runs.record({ source, finishedAt: at, ok: server.ok, error: server.error, rows: server.toolCount })
  }
  return null
}
