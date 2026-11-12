import { describe, expect, it } from 'vitest'
import { attentionItems, serverState, sortServers } from './state'
import type { SourceHealth, SourceHealthPayload } from '../sources/health'

const source = (over: Partial<SourceHealth>): SourceHealth => ({
  source: 'strava', kind: 'strava', instance: null, label: 'Strava', via: null, state: 'ok',
  lastRunAt: null, lastOkAt: null, lastErrorAt: null, failures: 0, failingSince: null, error: null, rows: null, goals: [], ...over,
})
const payload = (sources: SourceHealth[], disabled: string | null = null): SourceHealthPayload => ({
  generatedAt: '2026-11-05T12:00:00.000Z', disabled, sources, goals: [], metricSources: {},
})
const remote = { enabled: true, transport: 'http' }
const local = { enabled: true, transport: 'stdio' }
const base = { sources: payload([]), mcpOn: true, gateway: { ok: true, servers: [] }, states: [], accounts: [] }
const texts = (over: Partial<Parameters<typeof attentionItems>[0]>) => attentionItems({ ...base, ...over }).map((i) => i.text)

describe('serverState', () => {
  it('reads the gateway probe, and a switched-off server is off whatever it says', () => {
    expect(serverState({ ...remote, enabled: false }, { ok: true })).toBe('off')
    expect(serverState(remote, null)).toBe('checking')
    expect(serverState(remote, { ok: true })).toBe('live')
    expect(serverState(remote, { ok: false, needsAuth: true })).toBe('signin')
    expect(serverState(remote, { ok: false })).toBe('error')
  })
  it('counts a local command that wants auth as not working: there is nothing to sign in to', () => {
    expect(serverState(local, { ok: false, needsAuth: true })).toBe('error')
  })
})

describe('sortServers', () => {
  it('lists what needs a sign-in first, then what is broken, then live, then off, by name within each', () => {
    const rows = sortServers([
      { app: { name: 'Zed' }, state: 'live' as const },
      { app: { name: 'Off one' }, state: 'off' as const },
      { app: { name: 'Broken' }, state: 'error' as const },
      { app: { name: 'Beta' }, state: 'signin' as const },
      { app: { name: 'Alpha' }, state: 'signin' as const },
      { app: { name: 'Able' }, state: 'live' as const },
    ])
    expect(rows.map((r) => r.app.name)).toEqual(['Alpha', 'Beta', 'Broken', 'Able', 'Zed', 'Off one'])
  })
})

describe('attentionItems', () => {
  it('is empty when nothing needs the owner', () => {
    expect(texts({ states: ['live', 'live'] })).toEqual([])
  })
  it('counts failing and erroring sources, leaving MCP servers to their own section', () => {
    const sources = payload([
      source({ state: 'failing' }),
      source({ source: 'drive:work', kind: 'drive', state: 'degraded' }),
      source({ source: 'mcp:notion', kind: 'mcp', state: 'failing' }),
    ])
    expect(texts({ sources })).toEqual(['1 source failing', '1 source erroring'])
  })
  it('says when the source log could not be read, or source health is off', () => {
    expect(texts({ sources: null })).toEqual(['Data sources could not be checked'])
    expect(texts({ sources: payload([], 'unable to open database file') })).toEqual(['Source health is off'])
  })
  it('counts servers waiting on a sign-in, broken servers and broken built-in tool sets', () => {
    const gateway = { ok: true, servers: [{ builtin: true, ok: false }, { builtin: true, ok: true }] }
    expect(texts({ gateway, states: ['signin', 'signin', 'error', 'live'] })).toEqual(['2 servers not working', '2 servers need sign-in'])
  })
  it('says the gateway is not answering, and says nothing about servers while MCP is off', () => {
    expect(texts({ gateway: { ok: false, servers: [] } })).toEqual(['Gateway not answering'])
    expect(texts({ mcpOn: false, gateway: { ok: false, servers: [] }, states: ['signin', 'error'] })).toEqual([])
  })
  it('names one account that needs the owner, and counts several', () => {
    expect(texts({ accounts: ['Gmail'] })).toEqual(['Gmail needs you'])
    expect(texts({ accounts: ['Gmail', 'WHOOP'] })).toEqual(['2 accounts need you'])
  })
})
