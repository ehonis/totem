// CLIProxy: the web's /cliproxy page (web/src/cliproxy/CliproxyView.tsx) on a
// phone. The quota history and forecast graphs first (QuotaGraphs.tsx), then
// every Claude and Codex login the proxy pools, with what each has left.
//
// The phone reads only. Switching a login off, signing one in again, resetting a
// cooldown and spending a reset grant are approval routes the dashboard makes,
// and the foot of the page opens it for them (a deliberate difference from the web).
//
// Quota rides the live usage stream (the same numbers as the top bar's pill); the
// proxy's own list is re-read every 30 s while the page is in view.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useIsFocused } from 'expo-router'
import { AuthError, isAccountChanged } from '../../lib/api'
import { getProxy, type ProxyAccount, type ProxyOverview } from '../../lib/cliproxy/api'
import { useAiUsageLive } from '../../lib/useAiUsageLive'
import { isScopedMeter, poolSentence, providerGroups, stateLabel, whenLabel, type ProviderGroup } from '../../lib/usagePools'
import { Screen, FAB_CLEARANCE } from '../../shell/Screen'
import { navigateTo } from '../../shell/nav'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Spinner } from '../../ui/kit'
import { ArrowPathIcon } from '../../lib/icons'
import { ProviderLogo } from '../chat/ui'
import { Notice, openDashboard } from '../settings/ui'
import { QuotaGraphs, usePoolGraphs } from './QuotaGraphs'

const POLL_MS = 30_000
// What the live stream knows better than the proxy's list (CliproxyView.tsx QUOTA_FIELDS).
const QUOTA_FIELDS = ['meters', 'state', 'headroomPct', 'limitedUntil', 'plan', 'planSize', 'fetchedAt', 'passive', 'stale', 'servingRecently', 'authProblem', 'displayName', 'resetCredits', 'activeError', 'hidden'] as const

const STATE_COLOR: Record<string, string> = { ok: colors.green, low: colors.amber, limited: colors.red, error: colors.red, disabled: colors.muted }

function ago(ts?: number | string | null) {
  const t = typeof ts === 'string' ? Date.parse(ts) : ts
  if (!t) return ''
  const mins = Math.floor((Date.now() - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 48 * 60) return `${Math.floor(mins / 60)}h ago`
  return `${Math.floor(mins / 1440)}d ago`
}

function host(url: string | null) {
  if (!url) return ''
  try { return new URL(url).host } catch { return url }
}

function Meter({ m }: { m: any }) {
  const left = Math.max(0, Math.min(100, Math.round(m.remainingPct)))
  const tone = left < 2 ? colors.red : left < 25 ? colors.amber : colors.text
  return (
    <View style={[st.meter, isScopedMeter(m) && { opacity: 0.75 }]} accessible accessibilityLabel={`${m.label}, ${left}% left${m.resetsAt ? `, resets ${whenLabel(m.resetsAt)}` : ''}`}>
      <View style={st.meterTop}>
        <T size={13} numberOfLines={1} style={{ flexShrink: 1 }}>{m.label}</T>
        <T size={13} weight={500} color={tone} style={st.num}>{`${left}% left`}</T>
      </View>
      <View style={st.bar}><View style={[st.fill, { width: `${left}%`, backgroundColor: tone === colors.text ? colors.text : tone }]} /></View>
      <T size={11.5} muted style={st.num}>{m.refilled ? 'refilled' : m.resetsAt ? `resets ${whenLabel(m.resetsAt)}` : ' '}</T>
    </View>
  )
}

/** One login: its state, every window it reports, and why it is held back. Read only. */
function LoginCard({ account }: { account: ProxyAccount }) {
  const who = account.email || account.name
  const state = account.servingRecently && account.state !== 'disabled' ? 'In use' : stateLabel(account) || (account.state === 'low' ? 'Low' : 'Ready')
  const meters = (account.meters || []).filter((m: any) => typeof m.remainingPct === 'number')
  const cooldowns = account.cooldowns || []
  const cooldown = cooldowns.filter((c) => c.scope === 'credential').reduce((m, c) => Math.max(m, c.until), 0)
  const modelCooldowns = cooldowns.filter((c) => c.scope === 'model' && c.until > Date.now())
  const fileName = account.displayName !== account.email ? account.email : null
  const dot = STATE_COLOR[account.state || 'ok'] || colors.green
  return (
    <View style={[st.login, account.stale && { opacity: 0.7 }]}>
      <View style={st.loginHead}>
        <View style={[st.dot, account.state === 'disabled' ? { borderWidth: 1.5, borderColor: dot } : { backgroundColor: dot }]} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={15} weight={600} numberOfLines={1}>{account.displayName || who}</T>
          {fileName || account.plan ? <T size={12} muted numberOfLines={1}>{[fileName, account.plan].filter(Boolean).join(' · ')}</T> : null}
        </View>
        <T size={12.5} weight={500} color={account.state === 'limited' || account.state === 'error' ? colors.red : account.servingRecently ? colors.green : colors.muted}>{state}</T>
      </View>
      {account.authProblem ? <Notice tone="error">{account.statusReason || 'This login needs signing in again. Do it from the dashboard.'}</Notice> : null}
      {account.state === 'error' && !account.authProblem && account.error ? <Notice tone="error">{account.error}</Notice> : null}
      {meters.length > 0 && account.state !== 'disabled' ? <View style={{ gap: 10 }}>{meters.map((m: any) => <Meter key={m.key || m.label} m={m} />)}</View> : null}
      {cooldown > Date.now() || modelCooldowns.length > 0 ? (
        <Notice tone="warn">
          {`${cooldown > Date.now() ? `Cooling down, back ${whenLabel(cooldown)}` : 'Cooling down'}${modelCooldowns.length ? ` · ${modelCooldowns.slice(0, 4).map((c) => c.model).join(', ')}` : ''}`}
        </Notice>
      ) : null}
      <T size={11.5} muted>
        {[
          account.stale ? null : `${(account.successCount ?? 0).toLocaleString()} ok · ${(account.failedCount ?? 0).toLocaleString()} failed`,
          account.priority ? `priority ${account.priority}` : null,
          account.weight ? `weight ${account.weight}` : null,
          account.passive ? `from its last request ${ago(account.fetchedAt)}` : account.fetchedAt ? `read ${ago(account.fetchedAt)}` : null,
          account.stale ? 'stale' : null,
        ].filter(Boolean).join(' · ')}
      </T>
    </View>
  )
}

/**
 * What the forecast reads from the accounts (lib/cliproxy/pool/poolInputs.ts), as
 * one string: only the pooled logins that are on, each window's level and reset,
 * and when a login with windows was read, to the five minutes (the clock rebuilds
 * the forecast every minute anyway; a new reading time alone needn't).
 */
function poolSignature(accounts: ProxyAccount[]): string {
  return JSON.stringify(accounts.filter((a) => a.source === 'cliproxy' && !a.disabled).map((a) => [
    a.id, a.backend, a.displayName, a.email, a.label, a.plan, a.planSize,
    a.meters?.length && a.fetchedAt ? Math.floor(Number(a.fetchedAt) / 300_000) : null,
    (a.meters || []).map((m: any) => [m.key, m.remainingPct, m.usedPct, m.resetsAt, m.windowMinutes, m.beforeRefill?.remainingPct, m.beforeRefill?.resetsAt]),
  ]))
}

/**
 * The accounts the graphs are built from. Rebuilding the forecast walks three
 * weeks of history (a noticeable stall on a phone), and every usage update and
 * list poll hands over a new array, so the graphs keep the same one until a
 * reading they use changes, and hold it while the page is out of view (the
 * drawer keeps it mounted) or a finger is on a chart.
 */
function useGraphAccounts(accounts: ProxyAccount[], live: boolean): ProxyAccount[] {
  const held = useRef<{ key: string; accounts: ProxyAccount[] } | null>(null)
  if (live || !held.current) {
    const key = poolSignature(accounts)
    if (held.current?.key !== key) held.current = { key, accounts }
  }
  return held.current.accounts
}

function ProviderSection({ group }: { group: ProviderGroup }) {
  return (
    <View style={{ gap: 10 }}>
      <View style={st.providerHead}>
        <ProviderLogo driver={group.backend} name={group.name} size={20} />
        <T size={17} weight={600}>{group.name}</T>
        <T size={12.5} muted numberOfLines={2} style={{ flex: 1 }}>{poolSentence(group).replace(`${group.name}: `, '')}</T>
      </View>
      {group.accounts.map((a) => <LoginCard key={a.id} account={a as ProxyAccount} />)}
    </View>
  )
}

export default function CliproxyScreen() {
  const focused = useIsFocused()
  const [overview, setOverview] = useState<ProxyOverview | null>(null)
  const [error, setError] = useState('')
  const [scrollLocked, setScrollLocked] = useState(false)
  // Watching here is what puts the poller on its fast cadence, as the web tab does.
  const live = useAiUsageLive() as any

  const load = useCallback(async (retry = false) => {
    try {
      setOverview(await getProxy(retry))
      setError('')
    } catch (e: any) {
      if (isAccountChanged(e) || e instanceof AuthError) return
      setError(e?.message || 'Could not reach CLIProxy.')
    }
  }, [])

  useEffect(() => {
    if (!focused) return
    void load()
    const id = setInterval(() => { void load() }, POLL_MS)
    return () => clearInterval(id)
  }, [focused, load])

  // The live stream's quota wins over the list's copy of it.
  const accounts = useMemo(() => {
    const quota = new Map(((live.data?.accounts || []) as any[]).filter((a) => a.source === 'cliproxy').map((a) => [a.id, a]))
    return (overview?.accounts || []).map((a) => {
      const q = quota.get(a.id)
      if (!q) return a
      const merged: any = { ...a }
      for (const k of QUOTA_FIELDS) if (q[k] !== undefined) merged[k] = q[k]
      return merged as ProxyAccount
    })
  }, [overview, live.data])
  const groups = useMemo(
    () => providerGroups({ accounts: accounts.map((a) => ({ ...a, hidden: false })), pools: live.data?.pools || overview?.pools, providers: live.data?.providers }, { all: true }),
    [accounts, live.data, overview],
  )
  const graphAccounts = useGraphAccounts(accounts, focused && !scrollLocked)
  const graphs = usePoolGraphs(graphAccounts, focused && accounts.length > 0, scrollLocked)

  const refresh = () => {
    void load()
    void live.forceRefresh()
    void graphs.history.reload()
  }

  let body: React.ReactNode
  if (!overview) {
    body = error ? <Notice tone="warn">{error}</Notice> : <Spinner label="Loading…" />
  } else if (!overview.configured) {
    body = (
      <View style={{ gap: 12 }}>
        <T size={14.5} lineHeight={21}>
          Point Totem at your CLIProxyAPI and this page shows every Claude and Codex login it pools: what each has left, and where the
          pool is heading.
        </T>
        <T size={14.5} lineHeight={21} muted>
          Set the proxy URL and a management key in Settings → Providers › CLIProxy. Use a scoped key: the proxy’s full key can read
          every login’s tokens.
        </T>
        <Btn kind="primary" title="Open settings" onPress={() => navigateTo({ tab: 'settings', sub: 'providers', hash: 'cliproxy' })} style={{ alignSelf: 'flex-start' }} />
      </View>
    )
  } else {
    body = (
      <View style={{ gap: 20 }}>
        <View style={st.head}>
          <T size={13} muted numberOfLines={1} style={{ flex: 1 }}>
            {`${accounts.length} login${accounts.length === 1 ? '' : 's'}${overview.url ? ` · ${host(overview.url)}` : ''}`}
          </T>
          <Btn compact icon={ArrowPathIcon} title={live.busy ? 'Refreshing…' : 'Refresh usage'} disabled={live.busy} onPress={() => { void live.forceRefresh() }} />
        </View>
        {overview.reachable === false ? (
          <View style={{ gap: 8 }}>
            <Notice tone="error">
              {overview.code === 'bad_key'
                ? 'CLIProxy refused the management key. Update it in Settings → Providers › CLIProxy.'
                : `CLIProxy is not answering: ${overview.error}`}
            </Notice>
            <Btn compact title="Retry" onPress={() => { void load(true) }} style={{ alignSelf: 'flex-start' }} />
          </View>
        ) : null}
        {!groups.length && overview.reachable !== false ? <Notice>The proxy has no Claude or Codex logins yet. Add one from the dashboard.</Notice> : null}
        {accounts.length > 0 ? <QuotaGraphs graphs={graphs} onTouching={setScrollLocked} /> : null}
        {groups.map((g) => <ProviderSection key={g.backend} group={g} />)}
        <T size={12} muted lineHeight={17}>
          Switching logins on or off, signing in, cooldown resets and reset grants are on the dashboard.{' '}
          <T size={12} weight={600} color={colors.accent} onPress={() => openDashboard('/cliproxy')} accessibilityRole="link" suppressHighlighting>Open CLIProxy on the web</T>
        </T>
      </View>
    )
  }

  return (
    <Screen title="CLIProxy">
      <ScrollView
        scrollEnabled={!scrollLocked}
        contentContainerStyle={[st.page, { paddingBottom: FAB_CLEARANCE }]}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.muted} />}
      >
        {body}
      </ScrollView>
    </Screen>
  )
}

const st = StyleSheet.create({
  page: { paddingHorizontal: 16, paddingTop: 8, width: '100%', maxWidth: 720, alignSelf: 'center' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  providerHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  login: { gap: 12, padding: 14, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.bg2 },
  loginHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  meter: { gap: 5 },
  meterTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 },
  bar: { height: 6, borderRadius: 3, backgroundColor: '#2a2f3c', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },
  num: { fontVariant: ['tabular-nums'] },
})
