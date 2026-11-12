// Settings → Connections (web McpSettingsView.tsx), in the web's order: what
// needs you, Data sources, MCP servers, Accounts, Built-in data, Claude tools,
// then Add a connection. A server or an account opens its own screen
// (connections/ConnectionDetail.tsx); adding one is a sheet (AddConnection.tsx).
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import {
  api, AuthError, getGatewayStatus, getMcpCatalog, getMcpSettings, getStravaStatus, getStudio, getWhoopStatus,
  setMcpMode, setStudioConnection,
} from '../../../lib/api'
import { attentionItems, serverState, sortServers, SERVER_STATES, type ServerState } from '../../../lib/connections/state'
import { loadConnectionIcons } from '../../../lib/connections/icons'
import {
  getSourceHealth, isMcpSource, since, sortSources, sourceSummary, waitingLabel,
  type SourceHealth, type SourceHealthPayload,
} from '../../../lib/sources/health'
import { plainError } from '../../../lib/sources/plainError'
import {
  Hi, ArrowPathIcon, CheckCircleIcon, ChevronDownIcon, CloudIcon, CubeIcon, ExclamationTriangleIcon, FlagIcon,
  HeartIcon, MapIcon, NewspaperIcon, SquaresPlusIcon, WrenchScrewdriverIcon,
} from '../../../lib/icons'
import { pushError, pushSuccess } from '../../../lib/toast'
import { colors, fonts } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn, Press } from '../../../ui/kit'
import { tap } from '../../../ui/haptics'
import { Field, Loading, Note, Notice, Pill, Row, Section, Switch } from '../ui'
import {
  ConnectionIcon, Dot, GOOGLE, GRANT_LABEL, GRANT_PROBLEMS, GRANT_TONE, STATE_CHIP, SourceRuns, errorText, grantState, hostOf, splitCatalog,
} from '../connections/shared'

const SOURCE_LABEL = { ok: 'OK', degraded: 'Erroring', failing: 'Failing', unconfigured: 'Not set up', unknown: 'Not read' }
const SOURCE_COLOR = { ok: colors.green, degraded: colors.amber, failing: colors.red, unconfigured: colors.muted, unknown: colors.muted }

/** Open a server's or an account's own screen. */
export const openConnection = (params: { server: string } | { account: string }) =>
  router.push({ pathname: '/settings/connection', params })

/**
 * Scroll to a section (the "Needs you" items): the pane screen hands its `row`
 * param to PaneScroll. Cleared first, so the same item works twice.
 */
const jump = (row: string) => {
  router.setParams({ row: '' })
  setTimeout(() => router.setParams({ row }), 0)
}

/** The caret that says a row opens in place. */
function Caret({ open }: { open: boolean }) {
  return <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><Hi icon={ChevronDownIcon} size={15} color={colors.muted} /></View>
}

/** A small heading inside a group, the web's `.conn-list-label`. */
function Caption({ text }: { text: string }) {
  return (
    <View style={{ paddingHorizontal: 14, paddingTop: 10, paddingBottom: 6, borderBottomWidth: 0.5, borderBottomColor: colors.line }}>
      <T size={11.5} weight={600} muted style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>{text}</T>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Data sources (web sources/SourceHealthPanel.tsx)
// ---------------------------------------------------------------------------

function SourceRow({ source, compact }: { source: SourceHealth; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState(false)
  const problem = source.state === 'failing' || source.state === 'degraded'
  return (
    <Row
      title={source.label}
      icon={<Dot color={SOURCE_COLOR[source.state]} dim={source.state === 'unknown' || source.state === 'unconfigured'} />}
      description={sourceSummary(source)}
      status={problem && source.error && !open ? <T size={12.5} color={colors.red} lineHeight={17}>{plainError(source.error)}</T> : undefined}
      onPress={() => setOpen(!open)}
      accessibilityLabel={`${source.label}, ${SOURCE_LABEL[source.state]}. ${sourceSummary(source)}${problem && source.error && !open ? `. ${plainError(source.error)}` : ''}`}
      accessory={<>{compact ? null : <T size={12} color={SOURCE_COLOR[source.state]}>{SOURCE_LABEL[source.state]}</T>}<Caret open={open} /></>}
    >
      {open ? (
        <View style={{ gap: 8 }}>
          {source.error ? (
            <>
              <T size={13} color={colors.red} lineHeight={18}>{plainError(source.error)}</T>
              <Press onPress={() => { tap(); setRaw(!raw) }} accessibilityRole="button" accessibilityState={{ expanded: raw }}>
                <T size={12.5} weight={600} color={colors.accent}>{raw ? 'Hide details' : 'Details'}</T>
              </Press>
              {raw ? <T size={11.5} selectable color={colors.red} lineHeight={16} style={{ fontFamily: fonts.mono }}>{source.error}</T> : null}
            </>
          ) : null}
          {source.goals.length ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Hi icon={FlagIcon} size={11} color={colors.muted} />
              <T size={12.5} muted style={{ flex: 1 }}>Feeds {source.goals.map((g) => g.title).join(', ')}.</T>
            </View>
          ) : null}
          {source.via ? <T size={12.5} muted>{source.label} is {source.via}.</T> : null}
          <SourceRuns source={source.source} />
        </View>
      ) : problem && source.goals.length ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Hi icon={FlagIcon} size={11} color={colors.muted} />
          <T size={11.5} muted>{source.goals.map((g) => g.title).join(', ')}</T>
        </View>
      ) : null}
    </Row>
  )
}

/** A folded group: one row with a count and the names, opening onto compact rows. */
function SourceFold({ color, label, sources }: { color: string; label: string; sources: SourceHealth[] }) {
  const [open, setOpen] = useState(false)
  if (!sources.length) return null
  return (
    <>
      <Row
        title={label}
        icon={<Dot color={color} />}
        description={<T size={12.5} muted numberOfLines={open ? undefined : 1}>{sources.map((s) => s.label).join(', ')}</T>}
        onPress={() => setOpen(!open)}
        accessory={<Caret open={open} />}
      />
      {open ? sources.map((s) => <SourceRow key={s.source} source={s} compact />) : null}
    </>
  )
}

function SourcesSection({ data, failed, loading, onRefresh }: { data: SourceHealthPayload | null | undefined; failed: boolean; loading: boolean; onRefresh: () => void }) {
  const action = <Btn compact kind="ghost" icon={ArrowPathIcon} loading={loading} onPress={onRefresh} title="Check" />
  if (data?.disabled) return <Section id="conn-sources" title="Data sources" action={action} description={`Source health is off until Totem restarts: ${data.disabled}`} plain />
  if (failed && !data) return <Section id="conn-sources" title="Data sources" action={action} description="Totem could not read its source log. Check again." plain />
  if (data === undefined) return <Section id="conn-sources" title="Data sources"><Loading label="Checking sources…" /></Section>
  const { problems, waiting, healthy } = sortSources(data ?? null, { exclude: isMcpSource })
  if (!problems.length && !waiting.length && !healthy.length) {
    return <Section id="conn-sources" title="Data sources" action={action} description="Nothing has been read from a connected source yet." plain />
  }
  const failing = problems.filter((s) => s.state === 'failing').length
  const meta = failed ? 'Last check failed · showing the previous result'
    : [failing ? `${failing} failing` : '', problems.length - failing ? `${problems.length - failing} erroring` : ''].filter(Boolean).join(' · ')
  return (
    <Section id="conn-sources" title="Data sources" action={action} description={meta || undefined}>
      {problems.map((s) => <SourceRow key={s.source} source={s} />)}
      <SourceFold color={colors.green} label={problems.length ? `${healthy.length} working` : `All ${healthy.length} working`} sources={healthy} />
      <SourceFold color={colors.muted} label={waitingLabel(waiting)} sources={waiting} />
    </Section>
  )
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

function ServerRow({ app, state, health, mcpOn, checking }: { app: any; state: ServerState; health?: any; mcpOn: boolean; checking: boolean }) {
  const chip = STATE_CHIP[state]
  const sub = state === 'error' && health?.error ? plainError(health.error)
    : state === 'live' ? `${health.toolCount} tool${health.toolCount === 1 ? '' : 's'} · ${hostOf(app)}` : hostOf(app)
  return (
    <Row
      title={app.name}
      icon={<ConnectionIcon id={app.id} name={app.name} size={26} />}
      description={<T size={12.5} color={state === 'error' ? colors.red : colors.muted} numberOfLines={2}>{sub}</T>}
      onPress={() => openConnection({ server: app.id })}
      chevron
      accessory={<Pill label={state === 'checking' && checking ? 'Checking…' : state === 'live' && !mcpOn ? 'Ready' : chip.label} tone={state === 'live' && !mcpOn ? undefined : chip.tone} />}
    />
  )
}

/** Totem's own tool slices (tasks, goals, …). Always there, so one row, folded. */
function BuiltinFold({ servers }: { servers: any[] }) {
  const [open, setOpen] = useState(false)
  if (!servers.length) return null
  const tools = servers.reduce((n, s) => n + (s.toolCount || 0), 0)
  const down = servers.filter((s) => !s.ok)
  return (
    <>
      <Row
        title="Built into Totem"
        icon={<ConnectionIcon id="builtin" size={26} icon={CubeIcon} color={colors.bg3} />}
        description={`${servers.length} tool sets · ${tools} tools`}
        onPress={() => setOpen(!open)}
        accessory={<><Pill label={down.length ? `${down.length} not working` : 'Live'} tone={down.length ? 'error' : 'ok'} /><Caret open={open} /></>}
      />
      {open ? servers.map((s) => (
        <Row
          key={s.id}
          title={s.id}
          icon={<Dot color={s.ok ? colors.green : s.needsAuth ? colors.amber : colors.red} />}
          description={s.ok ? `${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}` : plainError(s.error) || (s.needsAuth ? 'Needs sign-in' : 'Error')}
        />
      )) : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

function GoogleRow({ which, reloadKey, onProblem }: { which: keyof typeof GOOGLE; reloadKey: number; onProblem: (name: string, problem: boolean) => void }) {
  const g = GOOGLE[which]
  const [info, setInfo] = useState<any>(null)
  useEffect(() => { g.list().then(setInfo).catch((e: any) => { if (!(e instanceof AuthError)) setInfo({ error: errorText(e) }) }) }, [g, reloadKey])
  const count = info?.accounts?.length || 0
  const broken = info?.accounts?.some((a: any) => a.status === 'error')
  const configured = info?.configured !== false
  const chip = !info ? '' : info.error ? 'Error' : !configured ? 'Not set up' : !count ? 'Not signed in' : broken ? 'Reconnect needed' : `${count} account${count === 1 ? '' : 's'}`
  const bad = !!info && (!!info.error || broken)
  useEffect(() => { if (info) onProblem(g.name, bad) }, [info, bad, g.name, onProblem])
  return (
    <Row
      title={g.name}
      icon={<ConnectionIcon id={g.id} name={g.name} size={26} />}
      description={g.summary}
      onPress={() => openConnection({ account: which })}
      chevron
      accessory={chip ? <Pill label={chip} tone={bad ? 'error' : configured && count ? 'ok' : undefined} /> : null}
    />
  )
}

function BushidoRow({ which, reloadKey, onProblem }: { which: 'whoop' | 'strava'; reloadKey: number; onProblem: (name: string, problem: boolean) => void }) {
  const [status, setStatus] = useState<any>(null)
  const name = which === 'whoop' ? 'WHOOP' : 'Strava'
  useEffect(() => {
    (which === 'whoop' ? getWhoopStatus() : getStravaStatus()).then(setStatus).catch(() => setStatus(null))
  }, [which, reloadKey])
  const state = grantState(status)
  useEffect(() => { if (status) onProblem(name, GRANT_PROBLEMS.has(state)) }, [status, state, name, onProblem])
  if (!status) return null
  return (
    <Row
      title={name}
      icon={<ConnectionIcon id={which} size={26} icon={which === 'whoop' ? HeartIcon : MapIcon} color={which === 'whoop' ? '#d4204c' : '#fc4c02'} />}
      description={which === 'whoop' ? 'Sleep, workouts and recovery · through Bushido'
        : `Rides, runs, mileage and gear · through Bushido${status.athlete?.name ? ` · ${status.athlete.name}` : ''}`}
      onPress={() => openConnection({ account: which })}
      chevron
      accessory={<Pill label={GRANT_LABEL[state]} tone={state === 'unconfigured' ? undefined : GRANT_TONE[state]} />}
    />
  )
}

// ---------------------------------------------------------------------------
// Built-in data (web DataConnectionsPanel.tsx): keyless sources the bridge reads itself
// ---------------------------------------------------------------------------

const DATA_FIELDS: Record<string, { key: string; label: string; number?: boolean; placeholder: string }[]> = {
  weather: [
    { key: 'location', label: 'Location label', placeholder: 'New York, NY' },
    { key: 'lat', label: 'Latitude', number: true, placeholder: '40.7128' },
    { key: 'lon', label: 'Longitude', number: true, placeholder: '-74.0060' },
  ],
  news: [
    { key: 'aiQuery', label: 'AI headlines query', placeholder: 'artificial intelligence when:1d' },
    { key: 'worldQuery', label: 'World headlines query', placeholder: 'world news when:1d' },
    { key: 'maxItems', label: 'Headlines per topic (1–10)', number: true, placeholder: '5' },
  ],
}

function DataRow({ conn, busy, onPatch }: { conn: any; busy: boolean; onPatch: (patch: any, ok?: string) => void }) {
  const [open, setOpen] = useState(false)
  const fields = DATA_FIELDS[conn.id] || []
  const [form, setForm] = useState<Record<string, string>>({})
  useEffect(() => { setForm(Object.fromEntries(fields.map((f) => [f.key, String(conn[f.key] ?? '')]))) }, [conn]) // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = fields.some((f) => form[f.key] !== String(conn[f.key] ?? ''))
  return (
    <Row
      title={conn.name}
      icon={<ConnectionIcon id={conn.id} size={26} icon={conn.id === 'news' ? NewspaperIcon : CloudIcon} color={conn.id === 'news' ? '#8a5cf6' : '#2f80ed'} />}
      description={conn.enabled ? `${conn.provider} · read by the morning brief` : `${conn.provider} · off`}
      onPress={fields.length ? () => setOpen(!open) : undefined}
      control={<><Switch label={conn.name} value={!!conn.enabled} disabled={busy} onChange={(v) => onPatch({ enabled: v })} />{fields.length ? <Caret open={open} /> : null}</>}
    >
      {open ? (
        <View style={{ gap: 8 }}>
          {conn.description ? <T size={12.5} muted lineHeight={17}>{conn.description}</T> : null}
          {fields.map((f) => (
            <View key={f.key} style={{ gap: 4 }}>
              <T size={12.5} muted>{f.label}</T>
              <Field
                value={form[f.key] ?? ''}
                placeholder={f.placeholder}
                keyboardType={f.number ? 'numbers-and-punctuation' : 'default'}
                accessibilityLabel={f.label}
                onChangeText={(v) => setForm((x) => ({ ...x, [f.key]: v }))}
              />
            </View>
          ))}
          <Btn
            compact
            kind="primary"
            title="Save changes"
            disabled={!dirty}
            loading={busy}
            style={{ alignSelf: 'flex-start' }}
            onPress={() => onPatch(Object.fromEntries(fields.map((f) => [f.key, f.number ? Number(form[f.key]) : form[f.key]])), `Saved ${conn.name}`)}
          />
        </View>
      ) : null}
    </Row>
  )
}

function DataSection() {
  const [conns, setConns] = useState<any[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => { getStudio().then((s: any) => setConns(s.dataConnections || [])).catch(() => setConns([])) }, [])
  async function patch(id: string, p: any, ok?: string) {
    setBusy(id)
    try {
      setConns(((await setStudioConnection(id, p)) as any).dataConnections || [])
      if (ok) pushSuccess(ok)
    } catch (e) {
      if (!(e instanceof AuthError)) pushError('Could not update connection')
    } finally {
      setBusy(null)
    }
  }
  if (!conns?.length) return null
  return (
    <Section id="conn-data" title="Built-in data" description="No sign-in. Read by the morning brief.">
      {conns.map((c) => <DataRow key={c.id} conn={c} busy={busy === c.id} onPatch={(p, ok) => void patch(c.id, p, ok)} />)}
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Claude tools (web ClaudeToolsPanel.tsx; providers/claude-tools.mjs)
// ---------------------------------------------------------------------------

interface ClaudeServer { name: string; prefix: string; source: string; status: string; enabled: boolean; enabledCount: number; tools: { name: string; enabled: boolean }[] }
interface ClaudePayload {
  servers: ClaudeServer[]
  accounts: Record<string, { pulledAt: string | null; error: string | null; servers: number }>
  claudeAccounts: { id: string; name: string }[]
}

const CLAUDE_SOURCE: Record<string, string> = { claudeai: 'claude.ai connector', plugin: 'Plugin', user: 'MCP server', project: 'Project MCP', local: 'MCP server' }
const CLAUDE_STATUS: Record<string, string> = { 'needs-auth': 'Needs sign-in', pending: 'Was still connecting', failed: 'Failed' }
const claudeName = (name: string) => name.replace(/^claude\.ai\s+/i, '').replace(/^plugin:[^:]+:/, '')

function ClaudeToolsSection() {
  const [data, setData] = useState<ClaudePayload | null>(null)
  const [pulling, setPulling] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const fail = (e: unknown) => { if (!(e instanceof AuthError)) setError(errorText(e)) }
  useEffect(() => { api<ClaudePayload>('/api/claude-tools').then(setData).catch(fail) }, [])

  async function pull() {
    setPulling(true); setError('')
    try { setData(await api<ClaudePayload>('/api/claude-tools/pull', { method: 'POST' })) } catch (e) { fail(e) } finally { setPulling(false) }
  }
  async function toggle(body: { server?: string; tool?: string; all?: boolean; enabled: boolean }) {
    setBusy(true); setError('')
    try {
      setData(await api<ClaudePayload>('/api/claude-tools/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  const needle = q.trim().toLowerCase()
  const servers = useMemo(() => (data?.servers || []).map((s) => {
    if (!needle || s.name.toLowerCase().includes(needle)) return s
    const tools = s.tools.filter((t) => t.name.toLowerCase().includes(needle))
    return tools.length ? { ...s, tools } : null
  }).filter(Boolean) as ClaudeServer[], [data, needle])

  const accounts = data?.claudeAccounts || []
  const pulls = accounts.map((a) => ({ ...a, ...(data?.accounts[a.id] || { pulledAt: null, error: null, servers: 0 }) }))
  const total = (data?.servers || []).reduce((n, s) => n + s.tools.length, 0)
  const on = (data?.servers || []).reduce((n, s) => n + s.enabledCount, 0)
  const pulledAt = pulls.map((a) => a.pulledAt).filter(Boolean).sort().pop() || null
  const meta = !data ? '' : !accounts.length ? 'No Claude account'
    : data.servers.length ? `${on} of ${total} tools on · pulled ${since(pulledAt) || 'never'}`
      : pulledAt ? `Pulled ${since(pulledAt)}, nothing found` : 'Not pulled yet'

  return (
    <Section
      id="conn-claude"
      title="Claude tools"
      action={<Btn compact kind="ghost" icon={ArrowPathIcon} loading={pulling} disabled={!accounts.length} title={data?.servers.length ? 'Pull again' : 'Pull tools'} onPress={() => void pull()} />}
      description={`The connectors your Claude account brings. On runs in chats without asking; off is always blocked.${meta ? ` ${meta}.` : ''}`}
      footer={error ? <Note text={error} error /> : undefined}
    >
      {!data ? <Loading error={error || undefined} /> : null}
      {data && !accounts.length ? <Row title="No Claude account" description="Add one in Settings → Providers." /> : null}
      {pulls.filter((a) => a.error || (accounts.length > 1 && !a.pulledAt)).map((a) => (
        <Row key={a.id} title={a.name} description={<T size={12.5} color={a.error ? colors.red : colors.muted}>{a.error ? `Pull failed: ${plainError(a.error)}` : 'Not pulled yet.'}</T>} />
      ))}
      {data?.servers.length ? (
        <>
          <Row
            title="Everything"
            description={`${on} of ${total} on`}
            control={(
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <Btn compact title="All on" disabled={busy || on === total} onPress={() => void toggle({ all: true, enabled: true })} />
                <Btn compact title="All off" disabled={busy || on === 0} onPress={() => void toggle({ all: true, enabled: false })} />
              </View>
            )}
          />
          {total > 12 ? (
            <View style={{ padding: 10, borderBottomWidth: 0.5, borderBottomColor: colors.line }}>
              <Field value={q} onChangeText={setQ} placeholder={`Filter ${total} tools`} accessibilityLabel="Filter tools" returnKeyType="search" />
            </View>
          ) : null}
          {servers.map((s) => {
            const expanded = open === s.prefix || !!needle
            return (
              <Row
                key={s.prefix}
                title={claudeName(s.name)}
                description={`${CLAUDE_SOURCE[s.source] || s.source || 'MCP server'}${CLAUDE_STATUS[s.status] ? ` · ${CLAUDE_STATUS[s.status]}` : ''} · ${!s.enabled ? 'Off' : s.tools.length ? `${s.enabledCount}/${s.tools.length} on` : 'On'}`}
                onPress={() => setOpen(open === s.prefix ? null : s.prefix)}
                control={<><Switch label={claudeName(s.name)} value={s.enabled} disabled={busy} onChange={(v) => void toggle({ server: s.name, enabled: v })} /><Caret open={expanded} /></>}
              >
                {expanded ? (s.tools.length ? (
                  <View style={{ gap: 6 }}>
                    {s.tools.map((t) => (
                      <View key={t.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <T size={12.5} style={{ flex: 1, fontFamily: fonts.mono }} numberOfLines={1}>{t.name}</T>
                        <Switch label={t.name} value={t.enabled} disabled={busy} onChange={(v) => void toggle({ server: s.name, tool: t.name, enabled: v })} />
                      </View>
                    ))}
                  </View>
                ) : (
                  <T size={12.5} muted lineHeight={17}>
                    {s.status === 'needs-auth' ? 'Sign in to this connector in Claude first, then pull again.' : 'No tools listed yet. The server may still have been connecting; pull again to list them.'}
                    {s.enabled ? ' While it is on, every tool it offers is allowed.' : ''}
                  </T>
                )) : null}
              </Row>
            )
          })}
        </>
      ) : null}
    </Section>
  )
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

export default function ConnectionsPane(_: { target?: string }) {
  const [data, setData] = useState<any>(null)
  const [catalog, setCatalog] = useState<any>(null)
  const [gateway, setGateway] = useState<any>(null)
  const [gatewayLoading, setGatewayLoading] = useState(false)
  // undefined until Data sources first answers, null if it could not be read.
  const [sources, setSources] = useState<SourceHealthPayload | null | undefined>(undefined)
  const [sourcesFailed, setSourcesFailed] = useState(false)
  const [sourcesLoading, setSourcesLoading] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [issues, setIssues] = useState<Record<string, boolean>>({})
  const [error, setError] = useState('')
  const [busyMode, setBusyMode] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const report = useCallback((name: string, problem: boolean) => {
    setIssues((m) => (m[name] === problem ? m : { ...m, [name]: problem }))
  }, [])

  const loadGateway = useCallback((force = false) => {
    setGatewayLoading(true)
    getGatewayStatus({ force })
      .then(setGateway)
      .catch((e) => { if (!(e instanceof AuthError)) setGateway((g: any) => ({ servers: [], totalTools: 0, ...g, ok: false, error: errorText(e) })) })
      .finally(() => setGatewayLoading(false))
  }, [])

  const loadSources = useCallback(() => {
    setSourcesLoading(true)
    getSourceHealth()
      .then((d) => { setSources(d); setSourcesFailed(false) })
      .catch((e) => {
        if (e instanceof AuthError) return
        setSourcesFailed(true)
        // A failed refresh keeps what is shown; only a first load that fails reads as "could not be checked".
        setSources((s) => (s === undefined ? null : s))
      })
      .finally(() => setSourcesLoading(false))
  }, [])

  const load = useCallback(() => {
    setError('')
    Promise.all([getMcpCatalog(), getMcpSettings({ verify: false })])
      .then(([cat, settings]) => { setCatalog(cat); setData(settings); loadGateway(false) })
      .catch((e) => { if (!(e instanceof AuthError)) setError(errorText(e)) })
    loadSources()
    void loadConnectionIcons()
    setReloadKey((k) => k + 1)
  }, [loadGateway, loadSources])

  // Every return from a server's screen or the add sheet reads again: they change the manifest.
  useFocusEffect(load)

  const mcpOn = data?.mcpMode === 'gateway'
  const { installed, available } = splitCatalog(catalog, data)
  const health = Object.fromEntries((gateway?.servers || []).map((s: any) => [s.id, s]))
  const builtins = (gateway?.servers || []).filter((s: any) => s.builtin)
  const rows = sortServers(installed.map((app) => ({ app, state: serverState(app, health[app.id]) })))
  const count = (s: ServerState) => rows.filter((r) => r.state === s).length

  const attention = attentionItems({
    sources, mcpOn, gateway, states: rows.map((r) => r.state),
    accounts: Object.keys(issues).filter((k) => issues[k]),
  })
  const checking = !gateway || sources === undefined

  async function switchMode(on: boolean) {
    setBusyMode(true); setError('')
    try { setData(await setMcpMode(on ? 'gateway' : 'off')); loadGateway(true) }
    catch (e) { if (!(e instanceof AuthError)) setError(errorText(e)) }
    finally { setBusyMode(false) }
  }

  // Writes the gateway into every agent's MCP config again (or strips it when off).
  async function resync() {
    setSyncing(true); setError('')
    try {
      const next = await setMcpMode(mcpOn ? 'gateway' : 'off')
      setData(next)
      loadGateway(true)
      const failed = (next?.synced || []).filter((r: any) => !r.ok)
      if (failed.length) pushError(`${failed.map((r: any) => r.provider).join(', ')}: ${failed[0].message || 'sync failed'}`)
      else pushSuccess('Synced to every agent')
    } catch (e) { if (!(e instanceof AuthError)) setError(errorText(e)) }
    finally { setSyncing(false) }
  }

  // Nothing below can be told truthfully without the settings: MCP would read as off.
  if (!data) {
    return error ? (
      <Notice tone="error">
        <T size={13} lineHeight={19}>Totem’s connections could not be read: {error}</T>
        <Btn compact title="Try again" onPress={load} style={{ alignSelf: 'flex-start' }} />
      </Notice>
    ) : <Loading />
  }

  let lastGroup = ''
  return (
    <>
      {/* What needs the owner; says all is well only once the gateway and the source log have answered. */}
      <Section title={attention.length ? 'Needs you' : undefined}>
        {attention.length ? attention.map((it) => (
          <Row
            key={it.text}
            title={it.text}
            icon={<Hi icon={ExclamationTriangleIcon} size={15} color={it.tone === 'bad' ? colors.red : colors.amber} />}
            onPress={() => jump(it.target)}
            chevron
          />
        )) : (
          <Row
            title={checking ? 'Checking your connections…' : 'Everything connected is working.'}
            icon={<Hi icon={checking ? ArrowPathIcon : CheckCircleIcon} size={15} color={checking ? colors.muted : colors.green} />}
            description={gateway && !mcpOn ? 'MCP is off.' : undefined}
          />
        )}
      </Section>
      <Note text={error} error style={{ marginTop: -16, marginBottom: 12 }} />

      <SourcesSection data={sources} failed={sourcesFailed} loading={sourcesLoading} onRefresh={loadSources} />

      <Section
        id="conn-mcp"
        title="MCP servers"
        action={<Btn compact kind="ghost" title={syncing ? 'Syncing…' : 'Re-sync'} disabled={syncing || !installed.length} onPress={() => void resync()} />}
        description={mcpOn
          ? `Every agent reaches these through one gateway, so each server is added and signed in to once, here. ${count('live')} live${gateway?.totalTools != null ? ` · ${gateway.totalTools} tools` : ''}.`
          : 'MCP is off, so no agent can reach these servers. Switch it on to serve them all through one gateway.'}
        footer={gateway && gateway.ok === false ? <Note text={plainError(gateway.error) || 'The gateway did not answer its status check.'} error /> : undefined}
      >
        <Row
          title="MCP for every agent"
          description={gatewayLoading ? 'Checking servers…' : mcpOn ? 'On, through the gateway' : 'Off'}
          control={<Switch label="MCP for every agent" value={mcpOn} disabled={busyMode} onChange={(v) => void switchMode(v)} />}
        />
        {rows.map(({ app, state }) => {
          const group = SERVER_STATES[state].group
          const label = group !== lastGroup ? <Caption key={`label-${group}`} text={`${group} · ${count(state)}`} /> : null
          lastGroup = group
          return (
            <React.Fragment key={app.id}>
              {label}
              <ServerRow app={app} state={state} health={health[app.id]} mcpOn={mcpOn} checking={gatewayLoading} />
            </React.Fragment>
          )
        })}
        {!installed.length ? <Row title="No servers yet" description="Add one from the catalog below." /> : null}
        {mcpOn && builtins.length ? <Caption text="Built in" /> : null}
        {mcpOn ? <BuiltinFold servers={builtins} /> : null}
      </Section>

      <Section id="conn-accounts" title="Accounts" description="Served by Totem itself, not through MCP.">
        <GoogleRow which="gmail" reloadKey={reloadKey} onProblem={report} />
        <GoogleRow which="drive" reloadKey={reloadKey} onProblem={report} />
        <GoogleRow which="calendar" reloadKey={reloadKey} onProblem={report} />
        <BushidoRow which="whoop" reloadKey={reloadKey} onProblem={report} />
        <BushidoRow which="strava" reloadKey={reloadKey} onProblem={report} />
      </Section>

      <DataSection />

      <ClaudeToolsSection />

      <Section id="conn-add" title="Add a connection">
        <Row
          title="Browse the catalog"
          icon={<ConnectionIcon id="catalog" size={26} icon={SquaresPlusIcon} color={colors.bg3} />}
          description={available.length ? `${available.length} apps ready to add: ${available.slice(0, 3).map((a) => a.name).join(', ')}${available.length > 3 ? '…' : ''}` : 'Everything in the catalog is added.'}
          onPress={() => router.push('/settings/add-connection')}
          disabled={!available.length}
          chevron
        />
        <Row
          title="Custom MCP server"
          icon={<ConnectionIcon id="custom" size={26} icon={WrenchScrewdriverIcon} color={colors.accent} />}
          description="Any URL or local command"
          onPress={() => router.push({ pathname: '/settings/add-connection', params: { custom: '1' } })}
          chevron
        />
      </Section>
    </>
  )
}
