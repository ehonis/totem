// One connection's own screen, pushed from Settings → Connections: an MCP server
// (`?server=<id>`, the web's expanded server row) or an account (`?account=gmail|
// drive|calendar|whoop|strava`, the web's Accounts rows).
import React, { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import {
  AuthError, getGatewayStatus, getMcpCatalog, getMcpSettings, getStravaGear, getStravaStats, getStravaStatus, getWhoopStatus,
  removeMcpConnection, resetGatewayOAuth, startGatewayOAuth, syncStrava, toggleMcpConnection,
} from '../../../lib/api'
import { isRemote, serverState } from '../../../lib/connections/state'
import { plainError } from '../../../lib/sources/plainError'
import { Hi, CheckCircleIcon, PlusIcon } from '../../../lib/icons'
import { pushError, pushSuccess } from '../../../lib/toast'
import { colors, fonts } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn, Press } from '../../../ui/kit'
import { confirm, prompt, showMenu } from '../../../ui/menu'
import { tap } from '../../../ui/haptics'
import { Code, Field, Loading, Note, Notice, PaneScroll, Pill, Row, Section, Switch } from '../ui'
import {
  ConnectionIcon, GOOGLE, GRANT_LABEL, GRANT_TONE, STATE_CHIP, SignInHelper, SourceRuns, errorText, grantState, hostOf, splitCatalog,
  type GoogleAccountsApi,
} from './shared'

export default function ConnectionDetail() {
  const { server, account } = useLocalSearchParams<{ server?: string; account?: string }>()
  return (
    <PaneScroll>
      {server ? <ServerDetail id={server} />
        : account === 'whoop' || account === 'strava' ? <BushidoDetail which={account} />
          : account && account in GOOGLE ? <GoogleDetail g={GOOGLE[account as keyof typeof GOOGLE]} />
            : <Loading error="No such connection." />}
    </PaneScroll>
  )
}

// ---------------------------------------------------------------------------
// An MCP server
// ---------------------------------------------------------------------------

type Session =
  | { authUrl: string; redirect: string | null; done?: boolean }
  | { needsCreds: true; message?: string; redirectUri?: string }

function ServerDetail({ id }: { id: string }) {
  const [app, setApp] = useState<any>(null)
  const [mcpOn, setMcpOn] = useState(false)
  const [gateway, setGateway] = useState<any>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [raw, setRaw] = useState(false)
  const [cid, setCid] = useState('')
  const [csec, setCsec] = useState('')

  const fail = (e: unknown) => { if (!(e instanceof AuthError)) setError(errorText(e)) }

  const load = useCallback(async (force = false) => {
    try {
      const [cat, settings] = await Promise.all([getMcpCatalog(), getMcpSettings({ verify: false })])
      const found = splitCatalog(cat, settings).installed.find((a) => a.id === id)
      setApp(found || false)
      setMcpOn(settings?.mcpMode === 'gateway')
      setGateway(await getGatewayStatus({ force }))
    } catch (e) { fail(e) }
  }, [id])
  useEffect(() => { void load() }, [load])

  // While a sign-in is open, re-check until the gateway holds a live token (the
  // callback lands on the server, out of band). Capped at three minutes.
  const waiting = !!session && 'authUrl' in session && !session.done
  useEffect(() => {
    if (!waiting) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const g = await getGatewayStatus({ force: true })
        if (!alive) return
        setGateway(g)
        if ((g.servers || []).find((s: any) => s.id === id)?.ok) {
          setSession((s) => (s && 'authUrl' in s ? { ...s, done: true } : s))
          pushSuccess(`Signed in to ${app?.name || id}`)
          return
        }
      } catch { /* keep trying */ }
      if (alive) timer = setTimeout(tick, 5000)
    }
    timer = setTimeout(tick, 4000)
    const stop = setTimeout(() => { alive = false; if (timer) clearTimeout(timer) }, 180_000)
    return () => { alive = false; if (timer) clearTimeout(timer); clearTimeout(stop) }
  }, [waiting, id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function startAuth(clientId?: string, clientSecret?: string) {
    setBusy(true); setError('')
    try {
      const r: any = await startGatewayOAuth(id, clientId ? { clientId, clientSecret } : {})
      if (r.ok) setSession({ authUrl: r.authUrl, redirect: r.redirectHost ? `${r.redirectHost}:${r.redirectPort}` : null })
      else if (r.code === 'needs-client-credentials') setSession({ needsCreds: true, message: r.message, redirectUri: r.redirectUri })
      else setError(r.message || 'Could not start sign-in')
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  async function signOut() {
    if (!(await confirm(`Sign ${app?.name || id} out?`, { message: 'Models lose access until you sign in again.', confirmLabel: 'Sign out' }))) return
    setBusy(true)
    try { await resetGatewayOAuth(id); setSession(null); await load(true) } catch (e) { fail(e) } finally { setBusy(false) }
  }

  async function toggle(enabled: boolean) {
    setBusy(true)
    try { await toggleMcpConnection(id, enabled); await load(true) } catch (e) { fail(e) } finally { setBusy(false) }
  }

  async function remove() {
    if (!(await confirm(`Remove ${app?.name || id}?`, { message: 'Every agent loses it. You can add it again from the catalog.', confirmLabel: 'Remove' }))) return
    setBusy(true)
    try { await removeMcpConnection(id); pushSuccess(`Removed ${app?.name || id}`); router.back() } catch (e) { fail(e); setBusy(false) }
  }

  if (app === null) return <Loading error={error || undefined} />
  if (app === false) return <Loading error="This server is not in the manifest any more." />

  const health = (gateway?.servers || []).find((s: any) => s.id === id)
  const state = serverState(app, health)
  const remote = isRemote(app)
  const chip = STATE_CHIP[state]
  return (
    <>
      <Stack.Screen options={{ title: app.name }} />
      <Section
        title="Status"
        footer={error ? <Note text={error} error /> : undefined}
        description={!mcpOn ? 'MCP is off, so no agent reaches this server until it is switched on in Connections.' : undefined}
      >
        <Row
          title={app.name}
          icon={<ConnectionIcon id={app.id} name={app.name} size={26} />}
          description={state === 'live' ? `${health.toolCount} tool${health.toolCount === 1 ? '' : 's'} · ${hostOf(app)}` : hostOf(app)}
          control={<Pill label={state === 'checking' && !gateway ? 'Checking…' : chip.label} tone={chip.tone} />}
        />
        {state === 'error' && health?.error ? (
          <Row title={plainError(health.error)} tone="danger">
            <Press onPress={() => { tap(); setRaw(!raw) }} accessibilityRole="button" accessibilityState={{ expanded: raw }}>
              <T size={12.5} weight={600} color={colors.accent}>{raw ? 'Hide details' : 'Details'}</T>
            </Press>
            {raw ? <T size={11.5} selectable color={colors.red} lineHeight={16} style={{ fontFamily: fonts.mono, marginTop: 6 }}>{health.error}</T> : null}
          </Row>
        ) : null}
        <Row title={remote ? 'Endpoint' : 'Command'} stacked control={<Code>{app.url || `${app.command || ''}${app.package ? ` ${app.package}` : ''}`}</Code>} />
        {app.envKeys?.length ? <Row title="Environment" stacked control={<Code>{app.envKeys.join(', ')}</Code>} /> : null}
        {app.headerKeys?.length ? <Row title="Headers" stacked control={<Code>{app.headerKeys.join(', ')}</Code>} /> : null}
      </Section>

      {remote && state !== 'off' ? (
        <Section
          title="Sign-in"
          description="The gateway holds the token, so every agent uses this one sign-in."
          footer={session && 'authUrl' in session && !session.done ? <T size={12.5} muted>Waiting for you to finish; this updates on its own.</T> : undefined}
        >
          {session && 'authUrl' in session && session.done ? (
            <Row title="Signed in" icon={<Hi icon={CheckCircleIcon} size={15} color={colors.green} />} description="The gateway holds the token now." />
          ) : null}
          {state === 'live' ? (
            <>
              <Row title="Sign in again" onPress={() => void startAuth()} disabled={busy} tone="accent" />
              <Row title="Sign out" onPress={() => void signOut()} disabled={busy} tone="danger" />
            </>
          ) : (
            <Row title={state === 'error' ? 'Sign in again' : 'Sign in'} onPress={() => void startAuth()} disabled={busy} tone="accent" />
          )}
          {session && 'needsCreds' in session ? (
            <Row
              title="OAuth app credentials"
              stacked
              description={`${session.message ? `${session.message} ` : ''}This service cannot register itself. Create an app in its developer console${session.redirectUri ? ` with the redirect URI ${session.redirectUri}` : ''}, then paste its credentials.`}
            >
              <View style={{ gap: 8 }}>
                <Field value={cid} onChangeText={setCid} placeholder="Client ID" accessibilityLabel="Client ID" />
                <Field value={csec} onChangeText={setCsec} secureTextEntry placeholder="Client secret (blank if none)" accessibilityLabel="Client secret" />
                <Btn kind="primary" title="Start sign-in" disabled={!cid.trim()} loading={busy} style={{ alignSelf: 'flex-start' }} onPress={() => void startAuth(cid.trim(), csec.trim())} />
              </View>
            </Row>
          ) : null}
        </Section>
      ) : null}
      {session && 'authUrl' in session && !session.done ? (
        <SignInHelper authUrl={session.authUrl} redirect={session.redirect} onDone={() => void load(true)} onCancel={() => setSession(null)} />
      ) : null}

      {app.id === 'google-calendar' ? <GoogleAccounts g={GOOGLE.calendar} /> : null}

      {state !== 'off' ? (
        <Section title="Recent checks">
          <Row title="Gateway checks" stacked><SourceRuns source={`mcp:${app.id}`} /></Row>
        </Section>
      ) : null}

      <Section description="Off keeps the server in the manifest but hides it from every agent.">
        <Row title="On for every agent" control={<Switch label="On for every agent" value={!!app.enabled} disabled={busy} onChange={(v) => void toggle(v)} />} />
        <Row title="Remove this server" tone="danger" disabled={busy} onPress={() => void remove()} />
      </Section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Google accounts (Calendar's, Gmail's or Drive's)
// ---------------------------------------------------------------------------

function GoogleDetail({ g }: { g: GoogleAccountsApi }) {
  return (
    <>
      <Stack.Screen options={{ title: g.name }} />
      <Section plain description={g.about}><View /></Section>
      <GoogleAccounts g={g} />
    </>
  )
}

/** The signed-in accounts: rename, disconnect, or add one through Google sign-in. */
function GoogleAccounts({ g }: { g: GoogleAccountsApi }) {
  const [info, setInfo] = useState<any>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [auth, setAuth] = useState<{ label: string; authUrl: string; redirect: string | null } | null>(null)

  const load = useCallback(async () => {
    try { setInfo(await g.list()); setError('') } catch (e) { if (!(e instanceof AuthError)) setError(errorText(e)) }
  }, [g])
  useEffect(() => { void load() }, [load])

  async function run(label: string, fn: () => Promise<any>) {
    setBusy(label); setError('')
    try { const r = await fn(); setInfo((i: any) => ({ ...i, ...r })) } catch (e) { if (!(e instanceof AuthError)) setError(errorText(e)) } finally { setBusy('') }
  }

  async function rename(label: string) {
    const to = await prompt('Rename account', { defaultValue: label })
    if (to && to !== label) void run(label, () => g.rename(label, to))
  }

  async function disconnect(label: string) {
    if (await confirm(`Disconnect “${label}”?`, { message: g.removes, confirmLabel: 'Disconnect' })) void run(label, () => g.remove(label))
  }

  /** Start Google's sign-in for a label; the walkthrough below finishes it. */
  async function begin(label: string, busyKey = '__add__') {
    setBusy(busyKey); setError('')
    try {
      const r: any = await g.start(label)
      setAuth({ label, authUrl: r.authUrl, redirect: r.redirectHost ? `${r.redirectHost}:${r.redirectPort}` : null })
    } catch (e) { if (!(e instanceof AuthError)) setError(errorText(e)) } finally { setBusy('') }
  }

  async function add() {
    const label = await prompt('Add a Google account', { message: 'A label for it, e.g. work.', placeholder: 'work' })
    if (label) await begin(label)
  }

  // The bridge refuses a label that is already connected, so the web's remedy
  // for a broken token, re-adding the account, is done whole: remove it, then
  // sign the same label in again.
  async function signInAgain(label: string) {
    const ok = await confirm(`Sign “${label}” in again?`, {
      message: 'Its broken sign-in is removed. Then you sign the same label back in with Google, below.',
      confirmLabel: 'Sign in again',
      destructive: false,
    })
    if (!ok) return
    setBusy(label); setError('')
    try {
      const r = await g.remove(label)
      setInfo((i: any) => ({ ...i, ...r }))
    } catch (e) {
      if (!(e instanceof AuthError)) setError(errorText(e))
      setBusy('')
      return
    }
    await begin(label, label)
  }

  if (!info) return <Section title="Accounts"><Loading error={error || undefined} /></Section>
  if (info.configured === false) {
    return <Notice tone="warn">No Google OAuth client yet. Set one up as for Calendar (docs/self-hosting.md), then come back.</Notice>
  }
  const accounts: any[] = info.accounts || []
  return (
    <>
      <Section
        title="Signed-in accounts"
        description="Tap an account to rename or disconnect it."
        footer={error ? <Note text={error} error /> : undefined}
      >
        {accounts.length ? accounts.map((a) => (
          <Row
            key={a.label}
            title={a.label}
            description={<T size={12.5} color={a.status === 'error' ? colors.red : colors.muted} numberOfLines={2}>{a.status === 'error' ? plainError(a.error) || 'Token error: add this account again' : a.email || 'resolving…'}</T>}
            disabled={busy === a.label}
            onPress={() => showMenu([
              // A broken token is fixed the web's way: sign the account in again.
              ...(a.status === 'error' ? [{ label: 'Sign in again', onPress: () => void signInAgain(a.label) }] : []),
              { label: 'Rename', onPress: () => void rename(a.label) },
              { label: 'Disconnect', destructive: true, onPress: () => void disconnect(a.label) },
            ], { title: a.email || a.label })}
            accessory={a.status === 'error' ? <Pill label="Token error" tone="error" /> : null}
          />
        )) : <Row title="No accounts yet" description="Add one below." />}
        <Row
          title={busy === '__add__' ? 'Opening…' : 'Add account'}
          tone="accent"
          icon={<Hi icon={PlusIcon} size={15} color={colors.accent} />}
          disabled={busy === '__add__'}
          onPress={() => void add()}
        />
      </Section>
      {auth ? (
        <SignInHelper authUrl={auth.authUrl} redirect={auth.redirect} onDone={() => { setAuth(null); void load() }} onCancel={() => setAuth(null)} />
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// WHOOP and Strava: Bushido holds the grants, so reconnecting happens there
// ---------------------------------------------------------------------------

const mi = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v).toLocaleString()} mi`)

function BushidoDetail({ which }: { which: 'whoop' | 'strava' }) {
  const [status, setStatus] = useState<any>(undefined)
  const [stats, setStats] = useState<any>(null)
  const [gear, setGear] = useState<any>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const name = which === 'whoop' ? 'WHOOP' : 'Strava'

  const load = useCallback(async () => {
    try { setStatus(await (which === 'whoop' ? getWhoopStatus() : getStravaStatus())) } catch { setStatus(null) }
  }, [which])
  useEffect(() => { void load() }, [load])
  const state = grantState(status)

  // Totals and gear are two live Strava reads, so only on this screen and only with a healthy grant.
  useEffect(() => {
    if (which !== 'strava' || state !== 'ready') return
    let alive = true
    getStravaStats().then((s) => { if (alive) setStats(s) }).catch((e) => { if (alive) setStats({ error: errorText(e) }) })
    getStravaGear().then((g) => { if (alive) setGear(g) }).catch(() => {})
    return () => { alive = false }
  }, [which, state, status?.connectedAt])

  async function sync(full: boolean) {
    setBusy(full ? 'full' : 'sync')
    try {
      const r: any = await syncStrava({ full })
      pushSuccess(`${r.added} new, ${r.updated} refreshed · ${r.count} activities cached${r.complete ? '' : ' (more history remains; run again)'}`)
    } catch (e) { pushError(errorText(e)) } finally { setBusy(null); void load() }
  }

  if (status === undefined) return <Loading />
  if (status === null) return <Loading error={`Could not read ${name}’s status.`} />
  const rl = status.rateLimit?.read || status.rateLimit?.overall
  return (
    <>
      <Stack.Screen options={{ title: name }} />
      <Section
        title="Status"
        description={which === 'whoop'
          ? 'Fills the sleep habit each morning with last night’s sleep and recovery. Bushido holds the grant: connect, reconnect or disconnect it there (docs/whoop-sleep-ingest.md).'
          : 'Every ride, run and walk, plus each bike’s odometer, for agents (strava__*) and goals. Bushido holds the grant: connect, reconnect or disconnect it there (docs/strava.md).'}
      >
        <Row
          title={name}
          description={status.athlete?.name || undefined}
          control={<Pill label={GRANT_LABEL[state]} tone={state === 'unconfigured' ? undefined : GRANT_TONE[state]} />}
        />
        {state !== 'ready' ? (
          <Row
            title={status.detail || GRANT_LABEL[state]}
            description={status.lastError && state === 'needs-reauth' ? plainError(status.lastError) : undefined}
            tone={GRANT_TONE[state] === 'error' ? 'danger' : undefined}
          />
        ) : null}
        {status.connectedAt ? (
          <Row
            title="Grant last written"
            description={[
              new Date(status.connectedAt).toLocaleString(),
              status.cache ? (status.cache.count ? `${status.cache.count.toLocaleString()} activities cached${status.cache.complete ? '' : ' (history incomplete)'}` : 'nothing cached yet') : '',
              rl ? `API budget ${rl.usage15}/${rl.limit15} this quarter-hour, ${rl.usageDay}/${rl.limitDay} today` : '',
            ].filter(Boolean).join(' · ')}
          />
        ) : null}
        {status.scopes?.length || status.missingScopes?.length ? (
          <Row
            title="Access"
            stacked
            description={[
              status.scopes?.length ? `Granted: ${status.scopes.join(', ')}` : '',
              status.missingScopes?.length ? `Not granted (reconnect in Bushido to add): ${status.missingScopes.join(', ')}` : '',
            ].filter(Boolean).join('. ')}
          />
        ) : null}
      </Section>

      {which === 'strava' && state === 'ready' && stats ? (
        <Section title="Totals" description={stats.error ? `Totals unavailable: ${plainError(stats.error)}` : 'Strava’s own totals.'}>
          {!stats.error ? (['ride', 'run', 'swim'] as const).filter((k) => k !== 'swim' || stats.swim?.all?.count).map((k) => (
            <Row
              key={k}
              title={k === 'ride' ? 'Rides' : k === 'run' ? 'Runs' : 'Swims'}
              description={`${mi(stats[k]?.recent?.distanceMi)} in 4 weeks · ${mi(stats[k]?.ytd?.distanceMi)} this year · ${mi(stats[k]?.all?.distanceMi)} all time`}
            />
          )) : null}
          {(gear?.bikes || []).map((b: any) => (
            <Row key={b.id} title={b.name || b.id} description={`${mi(b.distanceMi)}${b.primary ? ' · primary' : ''}${b.retired ? ' · retired' : ''}`} />
          ))}
        </Section>
      ) : null}

      <Section>
        {status.bushidoUrl ? (
          <Row
            title={state === 'ready' ? 'Open Bushido' : 'Connect in Bushido'}
            description={`Profile → Settings → Connect ${name}`}
            tone="accent"
            onPress={() => { void WebBrowser.openBrowserAsync(status.bushidoUrl).then(() => load()) }}
          />
        ) : null}
        {which === 'strava' && state === 'ready' ? (
          <>
            <Row title={busy === 'sync' ? 'Syncing…' : 'Sync now'} description="New and recently edited activities." disabled={busy !== null} onPress={() => void sync(false)} />
            <Row
              title={busy === 'full' ? 'Syncing…' : status.cache?.complete ? 'Re-read history' : 'Sync history'}
              description="Walks back through your whole history, a few hundred activities a run."
              disabled={busy !== null}
              onPress={() => void sync(true)}
            />
          </>
        ) : null}
        <Row title="Refresh status" onPress={() => void load()} />
      </Section>
    </>
  )
}
