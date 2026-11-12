// Settings → Usage (web UsageView.tsx): what is left in each AI account's limits,
// read live; what Totem answered, by channel and account; and each subscription's
// price, renewal and token use. "Edit tracking" (AiUsageSettings.tsx) is its own
// pushed screen; this pane re-reads when it comes back.
import React, { useCallback, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { AuthError, getAssistantUsage, getUsage } from '../../../lib/api'
import { useAiUsageLive } from '../../../lib/useAiUsageLive'
import { useSettings } from '../../../lib/settings'
import {
  CHANNEL_META, CHANNEL_ORDER, PROVIDER_META, PROVIDER_ORDER, fmtInt, fmtTok, fmtUsd, relTime,
} from '../../../lib/usageMeta'
import { Hi, ArrowPathIcon, Cog6ToothIcon } from '../../../lib/icons'
import { colors, alpha } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn } from '../../../ui/kit'
import { QuotaCard } from '../../chat/UsageChips'
import { ProviderLogo } from '../../chat/ui'
import { ActivityChart } from '../usage/ActivityChart'
import { Group, Loading, Notice, Pill, Row, Section } from '../ui'

const POLL_MS = 30_000

function renewLabel(iso: any) {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  const days = Math.round((d.getTime() - Date.now()) / 86400000)
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return days >= 0 ? `renews ${date} · ${days}d` : `renewed ${date}`
}

/** A number over its caption (.stat). */
function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={{ flex: 1, minWidth: 64 }}>
      <T size={18} weight={600} style={{ fontVariant: ['tabular-nums'] }}>{value}</T>
      <T size={11.5} muted>{label}</T>
    </View>
  )
}

function Chip({ label, count, color, icon }: { label: string; count: number; color?: string; icon?: any }) {
  const c = color || colors.muted
  return (
    <View style={[st.chip, { borderColor: alpha(c, 0.4), backgroundColor: alpha(c, 0.1) }]}>
      {icon ? <Hi icon={icon} size={12} color={c} /> : null}
      <T size={12}>{label}</T>
      <T size={12} weight={600}>{fmtInt(count)}</T>
    </View>
  )
}

function LiveQuota() {
  const live = useAiUsageLive() as any
  const data = live.data
  const accounts: any[] = data?.accounts || []
  const ok = accounts.filter((a) => a.status === 'ok' && a.meters?.length)
  const failed = accounts.filter((a) => a.status && a.status !== 'ok')
  if (live.err) return <Notice tone="warn">{live.err}</Notice>
  if (!data) return <Loading label="Loading live quota…" />
  if (!data.ok) return <Notice tone="warn">{`${data.error || 'Quota polling is not answering.'} Polling runs inside the bridge; check its log on the server.`}</Notice>
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}>
        <T size={12.5} muted style={{ flex: 1 }}>
          {accounts.length} account{accounts.length === 1 ? '' : 's'} · live{data.updatedAt ? ` · updated ${relTime(data.updatedAt)}` : ''}
        </T>
        <Btn compact icon={ArrowPathIcon} title={live.busy ? 'Polling…' : 'Re-poll'} disabled={live.busy} onPress={() => { void live.forceRefresh() }} />
      </View>
      {!ok.length && !failed.length ? <Notice>No accounts report limits yet. Turn quota polling on under Edit tracking.</Notice> : null}
      {ok.map((a) => <QuotaCard key={a.id} account={a} style={{ backgroundColor: colors.bg2, borderRadius: 12 }} />)}
      {failed.length ? (
        <Group>
          {failed.map((a) => (
            <Row
              key={a.id}
              icon={<ProviderLogo driver={a.backend} name={a.displayName} size={16} />}
              title={a.displayName || a.label}
              description={a.error || a.status}
              control={<Pill label={a.status} tone="error" />}
            />
          ))}
        </Group>
      ) : null}
    </View>
  )
}

function AssistantActivity({ a }: { a: any }) {
  if (!a) return null
  if (!(a.total > 0)) {
    return <Group><Row title="Never used" description="No requests logged yet; usage is tracked from now on. Use the chat, the Shortcut or an MCP client and it shows up here." /></Group>
  }
  const channels = CHANNEL_ORDER.map((id) => [id, a.byChannel?.[id] || 0] as const).filter(([, n]) => n > 0)
  const byProvider = a.byProvider || {}
  const providers = [...PROVIDER_ORDER, ...Object.keys(byProvider).filter((id) => !PROVIDER_ORDER.includes(id))]
    .map((id) => [id, byProvider[id] || 0] as const).filter(([, n]) => n > 0)
  const facts = [
    a.avgMs != null ? `~${(a.avgMs / 1000).toFixed(1)}s avg reply` : '',
    a.errorRate > 0 ? `${a.errorRate}% errors` : '',
    a.since ? `since ${new Date(a.since).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : '',
    a.lastUsed ? `last used ${relTime(a.lastUsed)}` : '',
  ].filter(Boolean).join(' · ')
  return (
    <Group>
      <View style={st.card}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Stat value={fmtInt(a.today)} label="today" />
          <Stat value={fmtInt(a.last7d)} label="7 days" />
          <Stat value={fmtInt(a.last30d)} label="30 days" />
          <Stat value={fmtInt(a.total)} label="all time" />
        </View>
        <ActivityChart daily={a.daily} />
        {channels.length ? (
          <View style={st.chips}>
            {channels.map(([id, n]) => <Chip key={id} label={CHANNEL_META[id]?.label || id} count={n} color={CHANNEL_META[id]?.color} icon={CHANNEL_META[id]?.icon} />)}
          </View>
        ) : null}
        {providers.length ? (
          <View style={st.chips}>
            {providers.map(([id, n]) => <Chip key={id} label={PROVIDER_META[id]?.label || id} count={n} color={PROVIDER_META[id]?.color} />)}
          </View>
        ) : null}
        {facts ? <T size={12} muted>{facts}</T> : null}
      </View>
      {(a.recent || []).slice(0, 8).map((e: any, i: number) => (
        <Row
          key={i}
          title={e.preview || '(no preview)'}
          description={`${relTime(e.ts) || ''} · ${CHANNEL_META[e.channel]?.label || e.channel}`}
          control={e.ok ? undefined : <Pill label="error" tone="error" />}
        />
      ))}
    </Group>
  )
}

function ServiceRow({ s }: { s: any }) {
  if (s.error) return <Row title={s.name || s.id} description={s.error} control={<Pill label="error" tone="error" />} />
  const u = s.usage || {}
  const sub = [
    s.priceUsd != null ? `${fmtUsd(s.priceUsd)}/mo` : 'price -',
    renewLabel(s.renewsAt) || 'renewal -',
    u.lastActivity ? `active ${relTime(u.lastActivity)}` : '',
  ].filter(Boolean).join(' · ')
  // The live quota above already draws each window, so this sticks to what it doesn't know.
  const stats: string[] = []
  if (s.id === 'claude') {
    stats.push(`${fmtTok(u.totalTokens)} tokens`, `${fmtUsd(u.estCostUsd)} est. value`, `${fmtInt(u.messages)} messages`)
  } else if (s.id === 'codex') {
    stats.push(u.windows?.length ? `${fmtTok(u.totalTokens)} session tokens` : 'No recent session activity.')
  } else if (s.id === 'cursor') {
    if (u.totalPercentUsed != null) stats.push(`${Math.round(u.totalPercentUsed)}% of included used`)
    if (u.units) stats.push(`${fmtInt(u.units.used)}/${fmtInt(u.units.limit)} usage units`)
    if (u.aiEdits != null) stats.push(`${fmtInt(u.aiEdits)} AI edits`)
  }
  const models = s.id === 'claude' && u.byModel
    ? Object.entries(u.byModel).map(([model, m]: [string, any]) => ({ model, ...m })).sort((a, b) => (b.tokens || 0) - (a.tokens || 0)).slice(0, 3)
    : []
  const notes = [u.note, u.message, u.apiMessage].filter(Boolean)
  return (
    <Row
      icon={<ProviderLogo driver={s.id} name={s.name} size={16} />}
      title={s.name}
      control={s.plan ? <Pill label={s.plan} /> : undefined}
      description={sub}
      status={
        <View style={{ gap: 2, marginTop: 2 }}>
          {stats.length ? <T size={12.5}>{stats.join(' · ')}</T> : null}
          {models.map((m) => (
            <T key={m.model} size={12} muted>{m.model.replace('claude-', '')} · {fmtTok(m.tokens)} · {fmtUsd(Math.round((m.costUsd || 0) * 100) / 100)}</T>
          ))}
          {notes.map((n, i) => <T key={i} size={12} muted>{n}</T>)}
        </View>
      }
    />
  )
}

export default function UsagePane(_: { target?: string }) {
  const { autoRefresh } = useSettings()
  const [data, setData] = useState<any>(null)
  const [assistant, setAssistant] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const alive = useRef(true)

  const load = useCallback(async () => {
    try {
      const [d, a] = await Promise.all([getUsage(), getAssistantUsage()])
      if (!alive.current) return
      setData(d); setAssistant(a); setErr(null)
    } catch (e: any) {
      if (e instanceof AuthError || !alive.current) return
      setErr(e?.message || String(e))
    }
  }, [])

  // Re-read on every return (Edit tracking may have renamed or hidden something),
  // and poll only while the pane is on screen.
  useFocusEffect(useCallback(() => {
    alive.current = true
    void load()
    const timer = autoRefresh ? setInterval(load, POLL_MS) : null
    return () => { alive.current = false; if (timer) clearInterval(timer) }
  }, [load, autoRefresh]))

  const services: any[] = data?.services || []
  const monthly = services.reduce((sum, s) => sum + (s.priceUsd || 0), 0)
  return (
    <>
      <Section
        id="quota"
        title="Live quota"
        plain
        action={<Btn compact icon={Cog6ToothIcon} title="Edit tracking" onPress={() => router.push('/settings/usage-tracking')} />}
        description={`${monthly ? `${fmtUsd(monthly)}/mo across ${services.length} subscriptions. ` : ''}What is left in each account’s limits, read live. A short bar means running out.`}
      >
        <LiveQuota />
      </Section>
      {err ? <Notice tone="warn">{err}</Notice> : !data ? <Loading label="Loading activity and subscriptions…" /> : (
        <>
          <Section id="activity" title="Assistant activity" plain description="Requests Totem answered, by channel and account.">
            <AssistantActivity a={assistant} />
          </Section>
          <Section id="subscriptions" title="Subscriptions" description="Price, renewal and token use per subscription.">
            {services.length ? services.map((s) => <ServiceRow key={s.id} s={s} />) : <Row title="No subscriptions found" />}
          </Section>
        </>
      )}
    </>
  )
}

const st = StyleSheet.create({
  card: { gap: 12, padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, borderWidth: 1 },
})
