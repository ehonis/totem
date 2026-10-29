// Fleet: the owner's machines at a glance. Totals across the fleet (power now,
// what it costs a month and a year at the local rate), then one card per machine
// with its status, uptime, power, CPU and memory, and its health issues. A card
// opens the btop-like detail. Polls every 5 s while on screen.
import React, { useCallback, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { getFleet, setFleetSettings, type FleetDevice, type FleetStatus } from '../../lib/fleet/api'
import { MEASURED_LABEL, duration, money, pct, uptimeSince, watts } from '../../lib/fleet/format'
import { pushError, pushToast } from '../../lib/toast'
import { Screen, FAB_CLEARANCE } from '../../shell/Screen'
import { colors, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Card, Input, Spinner, Toggle } from '../../ui/kit'
import { success } from '../../ui/haptics'
import IconChevronRight from '@tabler/icons-react-native/dist/esm/icons/IconChevronRight.mjs'
import { Bar, HEALTH_COLOR, Stat, StatusDot, rateLabel } from './parts'

const POLL_MS = 5_000

export function openFleetDevice(id: string) {
  router.push({ pathname: '/fleet/[id]', params: { id } })
}

function Totals({ status }: { status: FleetStatus }) {
  const t = status.totals
  return (
    <Card style={st.totals}>
      <View style={st.totalsRow}>
        <Stat label="Now" value={watts(t.watts)} style={{ flex: 1 }} />
        <Stat label="Per month" value={money(t.projectedMonthCost)} style={{ flex: 1 }} />
        <Stat label="Per year" value={money(t.projectedYearCost)} style={{ flex: 1 }} />
      </View>
      <T size={12.5} muted>{rateLabel(status.rate)}</T>
    </Card>
  )
}

function Uptime({ device }: { device: FleetDevice }) {
  const u = device.uptime
  return (
    <T size={12.5} muted numberOfLines={1}>
      Uptime <T size={12.5} color={textAlpha(86)}>{pct(u.pct24h, u.pct24h != null && u.pct24h < 100 ? 1 : 0)}</T> 24h ·{' '}
      <T size={12.5} color={textAlpha(86)}>{pct(u.pct7d, u.pct7d != null && u.pct7d < 100 ? 1 : 0)}</T> 7d ·{' '}
      <T size={12.5} color={textAlpha(86)}>{pct(u.pct30d, u.pct30d != null && u.pct30d < 100 ? 1 : 0)}</T> 30d
    </T>
  )
}

function DeviceCard({ device }: { device: FleetDevice }) {
  const now = device.now
  const memPct = now && now.mem.total ? (now.mem.used / now.mem.total) * 100 : null
  const e = device.energy
  const sub = device.online
    ? [device.os, device.bootedAt ? `up ${uptimeSince(device.bootedAt)}` : null].filter(Boolean).join(' · ')
    : [device.os, device.lastSeen ? `last seen ${duration((Date.now() - device.lastSeen) / 1000)} ago` : 'never reported'].filter(Boolean).join(' · ')
  return (
    <Card style={st.card} onPress={() => openFleetDevice(device.id)}>
      <View style={st.cardHead}>
        <StatusDot level={device.health.level} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={16} weight={600} numberOfLines={1}>{device.name}</T>
          <T size={12.5} muted numberOfLines={1}>{sub}</T>
        </View>
        <IconChevronRight size={18} color={colors.muted} />
      </View>

      <Uptime device={device} />

      <View style={st.row}>
        <View style={{ flex: 1, gap: 2 }}>
          <T size={22} weight={600} lineHeight={27}>{watts(now?.watts ?? null)}</T>
          <T size={11.5} muted>{now ? MEASURED_LABEL[now.measured] : 'No reading'}</T>
        </View>
        <View style={{ flex: 1.3, gap: 7 }}>
          <View style={st.mini}>
            <T size={12} muted style={{ width: 32 }}>CPU</T>
            <Bar pct={now?.cpu} style={{ flex: 1 }} />
            <T size={12} mono align="right" style={{ width: 38 }}>{pct(now?.cpu)}</T>
          </View>
          <View style={st.mini}>
            <T size={12} muted style={{ width: 32 }}>Mem</T>
            <Bar pct={memPct} style={{ flex: 1 }} />
            <T size={12} mono align="right" style={{ width: 38 }}>{pct(memPct)}</T>
          </View>
        </View>
      </View>

      <View style={st.costs}>
        <Stat label="Today" value={money(e.todayCost)} style={{ flex: 1 }} />
        <Stat label="Month so far" value={money(e.monthCost)} style={{ flex: 1 }} />
        <Stat label="Projected" value={money(e.projectedMonthCost)} style={{ flex: 1 }} />
      </View>

      {device.health.issues.length ? (
        <View style={{ gap: 4 }}>
          {device.health.issues.map((issue, i) => (
            <View key={i} style={st.issue}>
              <View style={[st.issueDot, { backgroundColor: HEALTH_COLOR[issue.level] }]} />
              <T size={13} color={textAlpha(86)} style={{ flex: 1 }}>{issue.text}</T>
            </View>
          ))}
        </View>
      ) : null}
    </Card>
  )
}

function TurnOn({ onOn }: { onOn: (s: FleetStatus) => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Card style={[st.card, { gap: 12 }]}>
      <T size={14} lineHeight={21} color={textAlpha(86)}>
        Fleet watches your machines: whether each one is up, what is wrong with it, what it draws from the wall and
        what that costs at your electricity rate. It is off until you turn it on.
      </T>
      <View style={st.switchRow}>
        <T size={15} weight={500} style={{ flex: 1 }}>Turn on Fleet</T>
        <Toggle
          value={false}
          disabled={busy}
          onChange={async () => {
            setBusy(true)
            try { onOn(await setFleetSettings({ enabled: true })); success() } catch (e: any) { pushError(e.message) } finally { setBusy(false) }
          }}
        />
      </View>
    </Card>
  )
}

function FleetSettings({ status, onChange }: { status: FleetStatus; onChange: (s: FleetStatus) => void }) {
  const [zip, setZip] = useState(status.zip || '')
  const [rate, setRate] = useState(status.rate.source === 'custom' ? String(status.rate.centsPerKwh) : '')
  const [busy, setBusy] = useState(false)
  const typed = rate.trim() ? Number(rate) : null
  const rateOk = typed === null || (Number.isFinite(typed) && typed > 0)
  const dirty = zip.trim() !== (status.zip || '') || (typed ?? null) !== (status.rate.source === 'custom' ? status.rate.centsPerKwh : null)
  async function save(patch: Parameters<typeof setFleetSettings>[0], message?: string) {
    setBusy(true)
    try {
      onChange(await setFleetSettings(patch))
      success()
      if (message) pushToast(message, 'info')
    } catch (e: any) { pushError(e.message) } finally { setBusy(false) }
  }
  return (
    <View style={{ gap: 10, marginTop: 10 }}>
      <T size={13} weight={600}>Settings</T>
      <Card style={[st.card, { gap: 12 }]}>
        <View style={st.switchRow}>
          <T size={15} style={{ flex: 1 }}>Fleet</T>
          <Toggle value={status.enabled} disabled={busy} onChange={(v) => { void save({ enabled: v }) }} />
        </View>
        <T size={13} muted lineHeight={19}>
          Your ZIP code picks your state’s average electricity price. A rate from your bill, in cents per kWh, wins over it.
        </T>
        <Input value={zip} onChangeText={setZip} placeholder="ZIP code" keyboardType="number-pad" maxLength={10} />
        <Input value={rate} onChangeText={setRate} placeholder="Your rate, ¢/kWh (optional)" keyboardType="decimal-pad" />
        <View style={{ flexDirection: 'row' }}>
          <Btn
            kind="primary"
            title={busy ? 'Saving…' : 'Save'}
            disabled={busy || !dirty || !rateOk}
            onPress={() => { void save({ zip: zip.trim(), rateCents: typed }, 'Saved the electricity rate') }}
          />
        </View>
      </Card>
    </View>
  )
}

export default function FleetScreen() {
  const [status, setStatus] = useState<FleetStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pulling, setPulling] = useState(false)

  const load = useCallback(async () => {
    try { setStatus(await getFleet()); setError(null) } catch (e: any) { setError(e.message || 'Could not load Fleet') }
  }, [])

  useFocusEffect(useCallback(() => {
    void load()
    const t = setInterval(() => { void load() }, POLL_MS)
    return () => clearInterval(t)
  }, [load]))

  const devices = (status?.devices || []).filter((d) => !d.hidden)

  return (
    <Screen title="Fleet" glow="fleet">
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 18, paddingBottom: FAB_CLEARANCE, gap: 12 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
        refreshControl={<RefreshControl refreshing={pulling} tintColor={colors.muted} onRefresh={async () => { setPulling(true); await load(); setPulling(false) }} />}
      >
        <View style={{ marginBottom: 6 }}>
          <T size={26} weight={600} lineHeight={32} style={{ letterSpacing: -0.26 }}>Fleet</T>
          <T size={14} muted lineHeight={22} style={{ marginTop: 6 }}>
            Your machines: whether they’re up, what’s wrong, and what they cost to run.
          </T>
        </View>

        {!status ? (
          error ? <T size={14} color={colors.red}>{error}</T> : <Spinner />
        ) : !status.enabled ? (
          <TurnOn onOn={setStatus} />
        ) : (
          <>
            {error ? <T size={13} color={colors.amber}>Couldn’t refresh: {error}</T> : null}
            <Totals status={status} />
            {devices.length ? (
              devices.map((d) => <DeviceCard key={d.id} device={d} />)
            ) : (
              <T muted size={14} lineHeight={21}>No machines are reporting yet. Set one up from Fleet on the dashboard.</T>
            )}
            <FleetSettings key={`${status.zip}-${status.rate.source}-${status.rate.centsPerKwh}`} status={status} onChange={setStatus} />
          </>
        )}
      </ScrollView>
    </Screen>
  )
}

const st = StyleSheet.create({
  totals: { padding: 14, gap: 10 },
  totalsRow: { flexDirection: 'row', gap: 10 },
  card: { padding: 14, gap: 12 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  mini: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  costs: { flexDirection: 'row', gap: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  issue: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  issueDot: { width: 6, height: 6, borderRadius: 3, marginTop: 7 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
})
