// Settings → Connections: what each MCP server's row says, the order rows are listed
// in, and the "Needs you" line at the top. Pure, so the rules can be tested apart
// from the pane (components/McpSettingsView.tsx).
import { isMcpSource, sortSources, type SourceHealthPayload } from '../sources/health'

export type ServerState = 'signin' | 'error' | 'checking' | 'live' | 'off'

// The order is the order the list shows them in: what needs the owner first.
export const SERVER_STATES: Record<ServerState, { chip: string; group: string; rank: number }> = {
  signin: { chip: 'warn', group: 'Needs sign-in', rank: 0 },
  error: { chip: 'bad', group: 'Not working', rank: 1 },
  checking: { chip: '', group: 'Not checked yet', rank: 2 },
  live: { chip: 'on', group: 'Live', rank: 3 },
  off: { chip: '', group: 'Switched off', rank: 4 },
}

export const isRemote = (app: { transport?: string }) => app.transport === 'remote' || app.transport === 'http'

/**
 * An installed server's state, from the gateway's one status check. A local
 * command that wants auth has nothing to sign in to here (its env or headers are
 * wrong), so it counts as not working rather than waiting on a sign-in.
 */
export function serverState(app: { enabled?: boolean; transport?: string }, health: { ok?: boolean; needsAuth?: boolean } | null | undefined): ServerState {
  if (!app.enabled) return 'off'
  if (!health) return 'checking'
  if (health.ok) return 'live'
  if (health.needsAuth && isRemote(app)) return 'signin'
  return 'error'
}

/** Installed servers in list order: by state, then by name. */
export function sortServers<A extends { name: string }>(rows: { app: A; state: ServerState }[]) {
  return rows.slice().sort((a, b) => SERVER_STATES[a.state].rank - SERVER_STATES[b.state].rank || a.app.name.localeCompare(b.app.name))
}

export interface AttentionItem { tone: 'bad' | 'warn'; text: string; target: string }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * The "Needs you" line: one item per kind of problem, each pointing at the section
 * that fixes it. `sources` is undefined until the source log first answers and
 * null if it could not be read; `gateway` is null until the gateway answers.
 * `accounts` lists the Accounts rows that need the owner (a grant to reconnect, a
 * Bushido that does not answer).
 */
export function attentionItems({ sources, mcpOn, gateway, states, accounts }: {
  sources: SourceHealthPayload | null | undefined
  mcpOn: boolean
  gateway: { ok?: boolean; servers?: { builtin?: boolean; ok?: boolean }[] } | null
  states: ServerState[]
  accounts: string[]
}): AttentionItem[] {
  const items: AttentionItem[] = []
  if (sources === null) items.push({ tone: 'warn', text: 'Data sources could not be checked', target: 'conn-sources' })
  if (sources?.disabled) items.push({ tone: 'warn', text: 'Source health is off', target: 'conn-sources' })
  const { problems } = sortSources(sources ?? null, { exclude: isMcpSource })
  const failing = problems.filter((s) => s.state === 'failing').length
  if (failing) items.push({ tone: 'bad', text: `${plural(failing, 'source')} failing`, target: 'conn-sources' })
  if (problems.length - failing) items.push({ tone: 'warn', text: `${plural(problems.length - failing, 'source')} erroring`, target: 'conn-sources' })
  if (mcpOn) {
    const count = (s: ServerState) => states.filter((x) => x === s).length
    if (gateway && gateway.ok === false) items.push({ tone: 'bad', text: 'Gateway not answering', target: 'conn-mcp' })
    const broken = count('error') + (gateway?.servers || []).filter((s) => s.builtin && !s.ok).length
    if (broken) items.push({ tone: 'bad', text: `${plural(broken, 'server')} not working`, target: 'conn-mcp' })
    const signin = count('signin')
    if (signin) items.push({ tone: 'warn', text: `${plural(signin, 'server')} need${signin === 1 ? 's' : ''} sign-in`, target: 'conn-mcp' })
  }
  if (accounts.length) items.push({ tone: 'bad', text: accounts.length === 1 ? `${accounts[0]} needs you` : `${accounts.length} accounts need you`, target: 'conn-accounts' })
  return items
}
