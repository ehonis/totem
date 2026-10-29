// fleet/store.mjs — the owner's machines: live readings, uptime, energy and what
// it costs.
//
// Readings arrive from the bridge's own collector (the machine Totem runs on) and
// from fleet/agent.mjs on every other machine (POST /api/fleet/report). Live
// state is memory only; what survives a restart is
//   data/fleet.json          settings: on/off, ingest token, ZIP, ¢/kWh, per-device overrides
//   data/fleet-history.json  per device, per hour: [seconds up, watt-hours]
//
// Uptime is reconstructed, not just observed: when readings resume after a gap
// and the machine's boot time has not changed, it was up the whole time (only
// Totem or the agent was away), so the gap is credited at the average of the
// readings either side. A new boot time means it really went down.
import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { wallWatts } from './power.mjs'
import { resolveRate } from './pricing.mjs'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const KEEP_HOURS = 400 * 24
const SERIES_MAX = 360
export const FAST_MS = 3_000
export const SLOW_MS = 15_000
const WATCH_MS = 45_000
const OFFLINE_MS = 60_000
const ALERT_AFTER_MS = 5 * 60_000
const BACKFILL_MAX_MS = 14 * DAY
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/

export const validDeviceId = (id) => ID_RE.test(String(id || ''))

async function readJsonFile(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}
async function writeJsonFile(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
  await rename(tmp, file)
  await chmod(file, 0o600).catch(() => {})
}

const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }
const startOfMonth = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(1); return d.getTime() }
const daysInMonth = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() }
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const r1 = (n) => Math.round(n * 10) / 10
const r2 = (n) => Math.round(n * 100) / 100
const r3 = (n) => Math.round(n * 1000) / 1000
// A notification about a machine names it in the hash: the app opens that machine, the web its Fleet tab.
const deviceUrl = (id) => `/fleet#${encodeURIComponent(id)}`

/** Spread `[from, to)` over hour buckets: seconds up and watt-hours. */
export function credit(hours, from, to, watts) {
  let t = from
  while (t < to) {
    const h = Math.floor(t / HOUR)
    const end = Math.min(to, (h + 1) * HOUR)
    const sec = (end - t) / 1000
    const b = hours[h] || (hours[h] = [0, 0])
    b[0] = Math.min(3600, b[0] + sec)
    if (Number.isFinite(watts)) b[1] += (watts * sec) / 3600
    t = end
  }
}

/** Seconds up and watt-hours between two instants, from the hour buckets. */
export function totals(hours, from, to) {
  let up = 0
  let wh = 0
  for (let h = Math.floor(from / HOUR); h * HOUR < to; h++) {
    const b = hours[h]
    if (!b) continue
    const lo = Math.max(from, h * HOUR)
    const hi = Math.min(to, (h + 1) * HOUR)
    // A bucket cut by the window counts at most the overlap. Windows here start at
    // midnight or first sight and end now, so the bucket's time all lies inside.
    const part = Math.min(b[0], (hi - lo) / 1000)
    up += part
    wh += b[0] ? (b[1] * part) / b[0] : 0
  }
  return { up, wh }
}

/** What needs the owner's eye, worst first. */
export function healthOf(snap, { online, series }) {
  const issues = []
  if (!online) return { level: 'down', issues: [{ level: 'down', text: 'Not reporting' }] }
  const recent = series.slice(-100) // ~5 minutes at the fast rate, longer at the slow one
  const cpuAvg = recent.length ? recent.reduce((a, p) => a + p.cpu, 0) / recent.length : snap.cpu.total
  if (cpuAvg >= 90) issues.push({ level: 'warn', text: `CPU ${Math.round(cpuAvg)}% for the last few minutes` })
  const m = snap.memory
  if (m?.total && m.used / m.total >= 0.9) issues.push({ level: 'warn', text: `Memory ${Math.round((m.used / m.total) * 100)}% used` })
  if (m?.swapTotal && m.swapUsed / m.swapTotal >= 0.8) issues.push({ level: 'warn', text: `Swap ${Math.round((m.swapUsed / m.swapTotal) * 100)}% used` })
  for (const d of snap.disks || []) {
    const pct = d.used / d.size
    if (pct >= 0.9) issues.push({ level: pct >= 0.95 ? 'bad' : 'warn', text: `${d.mount} ${Math.round(pct * 100)}% full` })
  }
  if (snap.temps?.cpu >= 90) issues.push({ level: 'warn', text: `CPU at ${Math.round(snap.temps.cpu)}°C` })
  const order = { bad: 0, warn: 1 }
  issues.sort((a, b) => order[a.level] - order[b.level])
  return { level: issues[0]?.level || 'ok', issues }
}

export function createFleetStore({ file, historyFile, notify = () => {}, log = () => {}, now = () => Date.now() }) {
  let config = null
  let history = null
  let dirty = false
  const live = new Map() // id → { snap, receivedAt, series, watts, measured }
  const watching = new Map() // id → last time a detail view asked
  let lastViewed = 0
  const alerted = new Set()

  async function load() {
    if (config) return
    config = await readJsonFile(file, {})
    config.devices ||= {}
    history = await readJsonFile(historyFile, {})
  }
  const saveConfig = () => writeJsonFile(file, config)
  async function flush() {
    if (!dirty || !history) return
    dirty = false
    const cutoff = Math.floor(now() / HOUR) - KEEP_HOURS
    for (const dev of Object.values(history)) {
      for (const h of Object.keys(dev.hours || {})) if (Number(h) < cutoff) delete dev.hours[h]
    }
    await writeJsonFile(historyFile, history).catch((e) => { dirty = true; log(`fleet history write failed: ${e.message}`) })
  }

  const overrides = (id) => config.devices[id] || {}

  function record(snap) {
    const at = now()
    const id = snap.id
    const prior = live.get(id)
    let dev = history[id]
    if (!dev) {
      // Its boot time says it has been up since then, so uptime starts there (up to
      // 30 days back). Energy starts now: nothing measured it before.
      const upFrom = Math.max(at - 30 * DAY, Math.min(at, Number(snap.bootedAt) || at))
      dev = history[id] = { firstSeen: upFrom, watchedSince: at, hours: {} }
      credit(dev.hours, upFrom, at, null)
    }
    dev.watchedSince ??= dev.firstSeen
    Object.assign(dev, { hostname: snap.hostname, platform: snap.platform, os: snap.os, cpuModel: snap.cpuModel, cores: snap.cores })
    const { watts, measured } = wallWatts(snap.power, snap.platform, overrides(id))
    const lastAt = prior?.receivedAt ?? dev.lastAt
    const lastBoot = prior?.snap.bootedAt ?? dev.bootedAt
    const lastWatts = prior?.watts ?? dev.lastWatts
    if (lastAt && at > lastAt) {
      const gap = at - lastAt
      // A boot time that moved by more than clock jitter is a reboot.
      const sameBoot = lastBoot && Math.abs(snap.bootedAt - lastBoot) < 120_000
      if (gap <= OFFLINE_MS || (sameBoot && gap <= BACKFILL_MAX_MS)) {
        const avg = Number.isFinite(lastWatts) && Number.isFinite(watts) ? (lastWatts + watts) / 2 : watts ?? lastWatts
        credit(dev.hours, lastAt, at, avg)
      } else if (snap.bootedAt > lastAt && snap.bootedAt < at) {
        credit(dev.hours, snap.bootedAt, at, watts)
      }
    }
    Object.assign(dev, { lastAt: at, bootedAt: snap.bootedAt, lastWatts: watts })
    dirty = true

    const series = prior?.series || []
    series.push({
      t: at,
      cpu: snap.cpu?.total ?? 0,
      mem: snap.memory?.total ? r1((snap.memory.used / snap.memory.total) * 100) : 0,
      w: watts,
      rx: Math.round(snap.net?.rxBps || 0),
      tx: Math.round(snap.net?.txBps || 0),
    })
    if (series.length > SERIES_MAX) series.splice(0, series.length - SERIES_MAX)
    // Processes only come when someone is looking; keep the last list until then.
    const keep = snap.processes || (prior && at - (watching.get(id) || 0) < WATCH_MS ? prior.snap.processes : null)
    live.set(id, { snap: { ...snap, processes: keep }, receivedAt: at, series, watts, measured })

    if (alerted.delete(id)) notify({ title: `${displayName(id)} is back`, body: `Reporting again${snap.bootedAt > lastAt ? ' after a restart' : ''}.`, key: `fleet-${id}`, url: deviceUrl(id) })
  }

  function cadence(id) {
    const at = now()
    const viewed = at - lastViewed < WATCH_MS
    const detail = at - (watching.get(id) || 0) < WATCH_MS
    return { next: viewed ? FAST_MS : SLOW_MS, processes: detail }
  }

  const displayName = (id) => overrides(id).name || live.get(id)?.snap.name || history[id]?.hostname || id
  const rate = () => resolveRate({ zip: config.zip, rateCents: config.rateCents })

  function summary(id) {
    const at = now()
    const l = live.get(id)
    const dev = history[id] || { hours: {} }
    const ov = overrides(id)
    const online = !!l && at - l.receivedAt < OFFLINE_MS
    const cents = rate().centsPerKwh
    const dollars = (wh) => r2((wh / 1000) * cents / 100)
    const windowPct = (ms) => {
      const from = Math.max(at - ms, dev.firstSeen || at)
      const span = (at - from) / 1000
      // An online machine was up since its last reading too; that is not credited yet.
      const pending = online ? Math.max(0, at - Math.max(from, l.receivedAt)) / 1000 : 0
      return span > 60 ? Math.min(100, r2(((totals(dev.hours, from, at).up + pending) / span) * 100)) : null
    }
    const today = totals(dev.hours, startOfDay(at), at)
    const month = totals(dev.hours, startOfMonth(at), at)
    // The average of the last week (or as much as there is) stands in for the future.
    const weekFrom = Math.max(at - 7 * DAY, dev.watchedSince || at)
    const week = totals(dev.hours, weekFrom, at)
    const avgW = at - weekFrom > 10 * 60_000 ? week.wh / ((at - weekFrom) / HOUR) : l?.watts ?? null
    const projMonthKwh = avgW == null ? null : (avgW * 24 * daysInMonth(at)) / 1000
    const snap = l?.snap
    const model = snap ? wallWatts(snap.power, snap.platform, ov).model : null
    return {
      id,
      name: displayName(id),
      hostname: snap?.hostname || dev.hostname || id,
      platform: snap?.platform || dev.platform || null,
      os: snap?.os || dev.os || null,
      cpuModel: snap?.cpuModel || dev.cpuModel || null,
      cores: snap?.cores || dev.cores || null,
      local: !!l?.local,
      online,
      lastSeen: l?.receivedAt || dev.lastAt || null,
      bootedAt: snap?.bootedAt || dev.bootedAt || null,
      uptime: { pct24h: windowPct(DAY), pct7d: windowPct(7 * DAY), pct30d: windowPct(30 * DAY), since: dev.firstSeen || null, watchedSince: dev.watchedSince || null },
      health: snap ? healthOf(snap, { online, series: l.series }) : { level: 'down', issues: [{ level: 'down', text: 'Never reported' }] },
      now: snap && online ? {
        cpu: snap.cpu.total,
        load: snap.cpu.load,
        mem: snap.memory,
        temps: snap.temps,
        watts: l.watts,
        measured: l.measured,
        net: { rxBps: snap.net.rxBps, txBps: snap.net.txBps },
      } : null,
      power: {
        note: snap?.power?.note || null,
        parts: snap?.power?.parts || null,
        model,
        overrides: { baseWatts: ov.baseWatts ?? null, efficiency: ov.efficiency ?? null },
      },
      energy: {
        avgWatts: avgW == null ? null : r1(avgW),
        todayKwh: r3(today.wh / 1000), todayCost: dollars(today.wh),
        monthKwh: r3(month.wh / 1000), monthCost: dollars(month.wh),
        projectedMonthKwh: projMonthKwh == null ? null : r1(projMonthKwh),
        projectedMonthCost: projMonthKwh == null ? null : r2((projMonthKwh * cents) / 100),
        projectedYearCost: avgW == null ? null : r2(((avgW * 8760) / 1000) * cents / 100),
      },
      series: (l?.series || []).slice(-120),
      hidden: !!ov.hidden,
    }
  }

  function dailyEnergy(id, days = 30) {
    const dev = history[id]
    if (!dev) return []
    const out = []
    let end = now()
    for (let i = 0; i < days; i++) {
      const start = startOfDay(end - (i ? 1 : 0))
      if (end <= (dev.watchedSince || 0)) break
      const t = totals(dev.hours, start, end)
      out.unshift({ day: localDay(start), kwh: r3(t.wh / 1000), upPct: r1((t.up / ((end - Math.max(start, dev.firstSeen)) / 1000)) * 100) })
      end = start
    }
    return out
  }

  return {
    load,
    flush,
    cadence,
    get enabled() { return !!config?.enabled },

    async token() {
      await load()
      if (!config.token) { config.token = randomBytes(24).toString('base64url'); await saveConfig() }
      return config.token
    },
    async rotateToken() {
      await load()
      config.token = randomBytes(24).toString('base64url')
      await saveConfig()
      return config.token
    },

    /** A reading from the bridge's own collector or an agent. */
    async report(snap, { local = false } = {}) {
      await load()
      if (!snap || typeof snap !== 'object' || !validDeviceId(snap.id) || !snap.cpu || !snap.memory) throw Object.assign(new Error('not a fleet reading'), { status: 400 })
      if (!config.enabled) return { next: SLOW_MS * 4, processes: false, enabled: false }
      record(snap)
      if (local) live.get(snap.id).local = true
      return { ...cadence(snap.id), enabled: true }
    },

    /** Called on the job tick: notice machines that stopped reporting. */
    checkOffline() {
      if (!config?.enabled) return
      const at = now()
      for (const [id, l] of live) {
        if (at - l.receivedAt > ALERT_AFTER_MS && !alerted.has(id) && !overrides(id).hidden) {
          alerted.add(id)
          notify({ title: `${displayName(id)} stopped reporting`, body: `No reading for ${Math.round((at - l.receivedAt) / 60_000)} minutes.`, key: `fleet-${id}`, url: deviceUrl(id) })
        }
      }
    },

    async status() {
      await load()
      lastViewed = now()
      const ids = [...new Set([...Object.keys(history), ...live.keys()])]
      const devices = ids.map(summary).sort((a, b) => Number(b.local) - Number(a.local) || a.name.localeCompare(b.name))
      const shown = devices.filter((d) => !d.hidden)
      const sum = (f) => r2(shown.reduce((a, d) => a + (f(d) || 0), 0))
      return {
        enabled: !!config.enabled,
        zip: config.zip || null,
        rate: rate(),
        devices,
        totals: {
          watts: r1(shown.reduce((a, d) => a + (d.now?.watts || 0), 0)),
          todayCost: sum((d) => d.energy.todayCost),
          monthCost: sum((d) => d.energy.monthCost),
          projectedMonthCost: sum((d) => d.energy.projectedMonthCost),
          projectedYearCost: sum((d) => d.energy.projectedYearCost),
        },
      }
    },

    async device(id) {
      await load()
      if (!history[id] && !live.has(id)) return null
      lastViewed = now()
      watching.set(id, now())
      const l = live.get(id)
      const snap = l?.snap
      return {
        ...summary(id),
        series: l?.series || [],
        daily: dailyEnergy(id),
        detail: snap ? {
          cpu: snap.cpu, memory: snap.memory, disks: snap.disks, net: snap.net, temps: snap.temps,
          fans: snap.fans, gpu: snap.gpu, processes: snap.processes || null, at: snap.at,
        } : null,
      }
    },

    async updateSettings(patch = {}) {
      await load()
      if ('enabled' in patch) config.enabled = !!patch.enabled
      if ('zip' in patch) {
        const zip = String(patch.zip || '').trim()
        if (zip && !/^\d{5}(-\d{4})?$/.test(zip)) throw Object.assign(new Error('ZIP must be five digits'), { status: 400 })
        config.zip = zip || null
      }
      if ('rateCents' in patch) {
        const v = patch.rateCents === null || patch.rateCents === '' ? null : Number(patch.rateCents)
        if (v !== null && !(v > 0 && v < 200)) throw Object.assign(new Error('Rate must be between 0 and 200 ¢/kWh'), { status: 400 })
        config.rateCents = v
      }
      await saveConfig()
      return this.status()
    },

    async updateDevice(id, patch = {}) {
      await load()
      if (!validDeviceId(id)) throw Object.assign(new Error('bad device id'), { status: 400 })
      const d = { ...config.devices[id] }
      if ('name' in patch) d.name = String(patch.name || '').trim().slice(0, 60) || undefined
      if ('hidden' in patch) d.hidden = !!patch.hidden || undefined
      for (const [k, lo, hi] of [['baseWatts', 0, 1000], ['efficiency', 0.3, 1]]) {
        if (!(k in patch)) continue
        const v = patch[k] === null || patch[k] === '' ? undefined : Number(patch[k])
        if (v !== undefined && !(v >= lo && v <= hi)) throw Object.assign(new Error(`${k} must be between ${lo} and ${hi}`), { status: 400 })
        d[k] = v
      }
      config.devices[id] = JSON.parse(JSON.stringify(d))
      await saveConfig()
      return summary(id)
    },

    async forget(id) {
      await load()
      delete history[id]
      delete config.devices[id]
      live.delete(id)
      dirty = true
      await saveConfig()
      await flush()
    },
  }
}
