// One machine, btop style: CPU (every core), memory, disks, network, GPU and
// fans, power and what it costs, 30 days of energy, and the process list. A
// pushed screen. Asking for the detail is also what makes the machine send its
// process list, so it polls every 3 s while on screen.
import React, { useCallback, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { getFleetDevice, type FleetDeviceDetail, type FleetProcess, type PowerPart } from '../../lib/fleet/api'
import { MEASURED_LABEL, bytes, duration, money, pct, rate, uptimeSince, watts } from '../../lib/fleet/format'
import { FAB_CLEARANCE } from '../../shell/Screen'
import { colors, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press, Segmented, Spinner } from '../../ui/kit'
import { Bar, Box, HEALTH_COLOR, HEALTH_LABEL, MeterRow, Sparkline, Stat, StatusDot, heatColor } from './parts'

const POLL_MS = 3_000
const PROCESS_PAGE = 40

const kwh = (n: number | null | undefined) => (n == null ? '–' : `${n < 10 ? n.toFixed(2) : n.toFixed(1)} kWh`)
const temp = (c: number | undefined) => (c == null ? null : `${Math.round(c)}°C`)
const usedPct = (used: number, total: number) => (total ? (used / total) * 100 : 0)

function Head({ d }: { d: FleetDeviceDetail }) {
  const facts = [d.os, d.cpuModel, d.cores ? `${d.cores} cores` : null].filter(Boolean).join(' · ')
  const state = d.online
    ? (d.bootedAt ? `up ${uptimeSince(d.bootedAt)}` : 'online')
    : d.lastSeen ? `last seen ${duration((Date.now() - d.lastSeen) / 1000)} ago` : 'never reported'
  return (
    <View style={{ gap: 8, marginBottom: 4 }}>
      <View style={st.line}>
        <StatusDot level={d.health.level} size={10} />
        <T size={14} weight={500} color={HEALTH_COLOR[d.health.level]}>{HEALTH_LABEL[d.health.level]}</T>
        <T size={14} muted>· {state}</T>
      </View>
      {facts ? <T size={13} muted lineHeight={19}>{facts}</T> : null}
      <T size={13} muted>
        Uptime {pct(d.uptime.pct24h, 1)} 24h · {pct(d.uptime.pct7d, 1)} 7d · {pct(d.uptime.pct30d, 1)} 30d
      </T>
      {d.health.issues.length ? (
        <View style={{ gap: 4, marginTop: 2 }}>
          {d.health.issues.map((issue, i) => (
            <View key={i} style={[st.line, { alignItems: 'flex-start' }]}>
              <View style={[st.dot, { backgroundColor: HEALTH_COLOR[issue.level] }]} />
              <T size={13.5} color={textAlpha(86)} style={{ flex: 1 }}>{issue.text}</T>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  )
}

function Cpu({ d }: { d: FleetDeviceDetail }) {
  const cpu = d.detail?.cpu
  const total = cpu?.total ?? d.now?.cpu ?? null
  const load = cpu?.load ?? d.now?.load ?? []
  const t = temp(d.detail?.temps.cpu ?? d.now?.temps.cpu)
  const cores = cpu?.cores || []
  // Two columns of cores, so a 16-core box is eight rows rather than sixteen.
  const half = Math.ceil(cores.length / 2)
  return (
    <Box title="CPU" right={t ? <T size={13} mono muted>{t}</T> : null}>
      <View style={st.line}>
        <T size={26} weight={600} lineHeight={31} color={total == null ? colors.muted : heatColor(total)}>{pct(total)}</T>
        <T size={12.5} muted style={{ flex: 1 }} align="right">
          load {load.length ? load.map((n) => n.toFixed(2)).join('  ') : '–'}
        </T>
      </View>
      <Sparkline series={[{ values: d.series.map((p) => p.cpu), color: colors.accent }]} max={100} />
      {cores.length ? (
        <View style={st.cols}>
          {[cores.slice(0, half), cores.slice(half)].map((col, c) => (
            <View key={c} style={{ flex: 1, gap: 5 }}>
              {col.map((p, i) => (
                <View key={i} style={st.core}>
                  <T size={11} mono muted style={{ width: 22 }}>{c * half + i}</T>
                  <Bar pct={p} height={5} style={{ flex: 1 }} />
                  <T size={11} mono align="right" style={{ width: 32 }}>{Math.round(p)}%</T>
                </View>
              ))}
            </View>
          ))}
        </View>
      ) : null}
    </Box>
  )
}

function Memory({ d }: { d: FleetDeviceDetail }) {
  const m = d.detail?.memory ?? d.now?.mem
  if (!m) return null
  return (
    <Box title="Memory" right={<T size={12.5} mono muted>{bytes(m.used)} / {bytes(m.total)}</T>}>
      <MeterRow label="Used" pct={usedPct(m.used, m.total)} value={pct(usedPct(m.used, m.total))} />
      {m.swapTotal ? <MeterRow label="Swap" pct={usedPct(m.swapUsed, m.swapTotal)} value={bytes(m.swapUsed)} /> : <T size={12.5} muted>No swap</T>}
      <Sparkline series={[{ values: d.series.map((p) => p.mem), color: colors.accent2 }]} max={100} height={34} />
    </Box>
  )
}

function Disks({ d }: { d: FleetDeviceDetail }) {
  const disks = d.detail?.disks || []
  if (!disks.length) return null
  const t = temp(d.detail?.temps.disk)
  return (
    <Box title="Disks" right={t ? <T size={13} mono muted>{t}</T> : null}>
      {disks.map((k) => (
        <View key={k.mount} style={{ gap: 5 }}>
          <View style={st.line}>
            <T size={13} weight={500} numberOfLines={1} style={{ flex: 1 }}>{k.mount}</T>
            <T size={12} mono muted>{bytes(k.used)} / {bytes(k.size)}</T>
          </View>
          <Bar pct={usedPct(k.used, k.size)} />
        </View>
      ))}
    </Box>
  )
}

function Network({ d }: { d: FleetDeviceDetail }) {
  const net = d.detail?.net ?? d.now?.net
  if (!net) return null
  const totals = d.detail?.net
  return (
    <Box title="Network">
      <View style={st.cols}>
        <Stat label="Down" value={rate(net.rxBps)} sub={totals ? `${bytes(totals.rxTotal)} total` : undefined} style={{ flex: 1 }} />
        <Stat label="Up" value={rate(net.txBps)} sub={totals ? `${bytes(totals.txTotal)} total` : undefined} style={{ flex: 1 }} />
      </View>
      <Sparkline series={[
        { values: d.series.map((p) => p.rx), color: colors.green },
        { values: d.series.map((p) => p.tx), color: colors.accent },
      ]} />
      <View style={st.line}>
        <View style={[st.dot, { backgroundColor: colors.green, marginTop: 0 }]} /><T size={11.5} muted>down</T>
        <View style={[st.dot, { backgroundColor: colors.accent, marginTop: 0, marginLeft: 8 }]} /><T size={11.5} muted>up</T>
      </View>
    </Box>
  )
}

function GpuAndFans({ d }: { d: FleetDeviceDetail }) {
  const gpu = d.detail?.gpu
  const fans = d.detail?.fans || []
  const t = temp(d.detail?.temps.gpu ?? d.now?.temps.gpu)
  return (
    <>
      {gpu ? (
        <Box title="GPU" right={t ? <T size={13} mono muted>{t}</T> : null}>
          <T size={13} muted numberOfLines={1}>{gpu.name}</T>
          <MeterRow label="Use" pct={gpu.usage} value={pct(gpu.usage)} />
          {gpu.memTotal ? <MeterRow label="VRAM" pct={usedPct(gpu.memUsed || 0, gpu.memTotal)} value={bytes(gpu.memUsed)} /> : null}
          <T size={12.5} muted>{watts(gpu.watts)}</T>
        </Box>
      ) : null}
      {fans.length ? (
        <Box title="Fans">
          {fans.map((f) => (
            f.maxRpm
              ? <MeterRow key={f.name} label={f.name} labelWidth={90} pct={(f.rpm / f.maxRpm) * 100} value={`${Math.round(f.rpm)} rpm`} color={colors.accent} />
              : (
                <View key={f.name} style={st.line}>
                  <T size={12.5} muted style={{ flex: 1 }}>{f.name}</T>
                  <T size={12.5} mono>{Math.round(f.rpm)} rpm</T>
                </View>
              )
          ))}
        </Box>
      ) : null}
    </>
  )
}

function Part({ label, part }: { label: string; part?: PowerPart }) {
  if (!part) return null
  return (
    <View style={st.line}>
      <T size={13} style={{ flex: 1 }}>{label}</T>
      <T size={12} muted>{part.measured ? 'measured' : 'estimated'}</T>
      <T size={13} mono style={{ width: 64 }} align="right">{watts(part.w)}</T>
    </View>
  )
}

function Power({ d }: { d: FleetDeviceDetail }) {
  const p = d.power
  const e = d.energy
  return (
    <Box title="Power" right={d.now ? <T size={12} muted>{MEASURED_LABEL[d.now.measured]}</T> : null}>
      <View style={st.line}>
        <T size={26} weight={600} lineHeight={31} style={{ flex: 1 }}>{watts(d.now?.watts ?? null)}</T>
        <T size={12.5} muted>avg {watts(e.avgWatts)}</T>
      </View>
      <Sparkline series={[{ values: d.series.map((s) => s.w ?? 0), color: colors.amber }]} height={34} />
      {p.parts ? (
        <View style={{ gap: 6 }}>
          <Part label="CPU" part={p.parts.cpu} />
          <Part label="GPU" part={p.parts.gpu} />
          <Part label="Rest of the system" part={p.parts.system} />
        </View>
      ) : null}
      {p.model ? (
        <T size={12.5} muted lineHeight={18}>
          Baseline {watts(p.model.baseWatts)}{p.overrides.baseWatts != null ? ' (yours)' : ''} · power supply {Math.round(p.model.efficiency * 100)}% efficient{p.overrides.efficiency != null ? ' (yours)' : ''}
        </T>
      ) : null}
      {p.note ? <T size={12.5} muted lineHeight={18}>{p.note}</T> : null}
      <View style={st.energy}>
        <Stat label="Today" value={money(e.todayCost)} sub={kwh(e.todayKwh)} style={{ flex: 1 }} />
        <Stat label="Month so far" value={money(e.monthCost)} sub={kwh(e.monthKwh)} style={{ flex: 1 }} />
      </View>
      <View style={st.energy}>
        <Stat label="Projected month" value={money(e.projectedMonthCost)} sub={kwh(e.projectedMonthKwh)} style={{ flex: 1 }} />
        <Stat label="Projected year" value={money(e.projectedYearCost)} sub={e.avgWatts != null ? kwh((e.avgWatts * 8760) / 1000) : undefined} style={{ flex: 1 }} />
      </View>
    </Box>
  )
}

function Daily({ d }: { d: FleetDeviceDetail }) {
  const days = d.daily.slice(-30)
  if (!days.length) return null
  const max = Math.max(0.001, ...days.map((x) => x.kwh))
  return (
    <Box title="Last 30 days">
      <View style={{ gap: 4 }}>
        {[...days].reverse().map((x) => {
          const date = new Date(`${x.day}T12:00:00`)
          return (
            <View key={x.day} style={st.line}>
              <T size={11.5} mono muted style={{ width: 52 }}>
                {date.toLocaleDateString([], { month: 'short', day: 'numeric' })}
              </T>
              <Bar pct={(x.kwh / max) * 100} color={colors.amber} height={5} style={{ flex: 1 }} />
              <T size={11.5} mono align="right" style={{ width: 62 }}>{kwh(x.kwh)}</T>
              <T size={11.5} mono muted align="right" style={{ width: 38 }}>{Math.round(x.upPct)}%</T>
            </View>
          )
        })}
      </View>
      <T size={11.5} muted>Energy used each day, and the share of the day the machine was up.</T>
    </Box>
  )
}

function ProcessRow({ p, open, onPress }: { p: FleetProcess; open: boolean; onPress: () => void }) {
  return (
    <Press onPress={onPress} style={st.proc}>
      <View style={st.line}>
        <T size={13} weight={500} numberOfLines={1} style={{ flex: 1 }}>{p.name}</T>
        <T size={12} mono align="right" color={heatColor(p.cpu)} style={{ width: 52 }}>{p.cpu.toFixed(1)}%</T>
        <T size={12} mono align="right" style={{ width: 64 }}>{bytes(p.mem)}</T>
      </View>
      <T size={11.5} muted numberOfLines={1}>pid {p.pid} · {p.user}{p.threads ? ` · ${p.threads} threads` : ''}</T>
      {open ? <T size={11.5} mono selectable color={textAlpha(80)} style={st.cmd}>{p.cmd || p.name}</T> : null}
    </Press>
  )
}

function Processes({ d }: { d: FleetDeviceDetail }) {
  const [sort, setSort] = useState<'cpu' | 'mem'>('cpu')
  const [open, setOpen] = useState<number | null>(null)
  const [all, setAll] = useState(false)
  const list = d.detail?.processes ?? null
  const sorted = useMemo(
    () => (list ? [...list].sort((a, b) => (sort === 'cpu' ? b.cpu - a.cpu || b.mem - a.mem : b.mem - a.mem || b.cpu - a.cpu)) : []),
    [list, sort],
  )
  const shown = all ? sorted : sorted.slice(0, PROCESS_PAGE)
  return (
    <Box title="Processes" right={list ? <T size={12} muted>{list.length}</T> : null}>
      <Segmented value={sort} onChange={setSort} options={[{ value: 'cpu', label: 'CPU' }, { value: 'mem', label: 'Memory' }]} />
      {!d.online ? (
        <T size={13} muted>The machine is offline.</T>
      ) : list === null ? (
        <T size={13} muted>Loading processes…</T>
      ) : (
        <View>
          {shown.map((p) => <ProcessRow key={p.pid} p={p} open={open === p.pid} onPress={() => setOpen(open === p.pid ? null : p.pid)} />)}
          {sorted.length > PROCESS_PAGE ? (
            <Btn compact style={{ alignSelf: 'flex-start', marginTop: 8 }} title={all ? 'Show fewer' : `Show all ${sorted.length}`} onPress={() => setAll(!all)} />
          ) : null}
        </View>
      )}
    </Box>
  )
}

export default function FleetDeviceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const [device, setDevice] = useState<FleetDeviceDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pulling, setPulling] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    try { setDevice(await getFleetDevice(id)); setError(null) } catch (e: any) { setError(e.message || 'Could not load this machine') }
  }, [id])

  useFocusEffect(useCallback(() => {
    void load()
    const t = setInterval(() => { void load() }, POLL_MS)
    return () => clearInterval(t)
  }, [load]))

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: device?.name || '' }} />
      {!device ? (
        error ? <T size={14} color={colors.red} style={{ padding: 20 }}>{error}</T> : <Spinner />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: FAB_CLEARANCE, gap: 12 }}
          refreshControl={<RefreshControl refreshing={pulling} tintColor={colors.muted} onRefresh={async () => { setPulling(true); await load(); setPulling(false) }} />}
        >
          {error ? <T size={13} color={colors.amber}>Couldn’t refresh: {error}</T> : null}
          <Head d={device} />
          <Cpu d={device} />
          <Memory d={device} />
          <Disks d={device} />
          <Network d={device} />
          <GpuAndFans d={device} />
          <Power d={device} />
          <Daily d={device} />
          <Processes d={device} />
        </ScrollView>
      )}
    </View>
  )
}

const st = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cols: { flexDirection: 'row', gap: 14 },
  core: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, marginTop: 7 },
  energy: { flexDirection: 'row', gap: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  proc: { paddingVertical: 8, gap: 2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  cmd: { marginTop: 4, padding: 8, borderRadius: 8, backgroundColor: colors.bg3 },
})
