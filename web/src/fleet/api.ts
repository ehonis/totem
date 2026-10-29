// The Fleet tab's view of /api/fleet (fleet/http.mjs). Ported to the iPhone app
// at mobile/src/lib/fleet/api.ts; keep the two in step.
import { api } from '../api'

export type Health = 'ok' | 'warn' | 'bad' | 'down'
export interface Issue { level: Health; text: string }
export interface Point { t: number; cpu: number; mem: number; w: number | null; rx: number; tx: number }
export interface Memory { total: number; used: number; available?: number; swapTotal: number; swapUsed: number }
export interface PowerPart { w: number; measured: boolean }

export interface FleetDevice {
  id: string
  name: string
  hostname: string
  platform: 'linux' | 'darwin' | null
  os: string | null
  cpuModel: string | null
  cores: number | null
  local: boolean
  online: boolean
  lastSeen: number | null
  bootedAt: number | null
  uptime: { pct24h: number | null; pct7d: number | null; pct30d: number | null; since: number | null; watchedSince?: number | null }
  health: { level: Health; issues: Issue[] }
  now: null | {
    cpu: number
    load: number[]
    mem: Memory
    temps: { cpu?: number; gpu?: number; disk?: number }
    watts: number | null
    measured: 'measured' | 'partial' | 'estimated'
    net: { rxBps: number; txBps: number }
  }
  power: {
    note: string | null
    parts: { cpu?: PowerPart; gpu?: PowerPart; system?: PowerPart } | null
    model: { baseWatts: number; efficiency: number } | null
    overrides: { baseWatts: number | null; efficiency: number | null }
  }
  energy: {
    avgWatts: number | null
    todayKwh: number
    todayCost: number
    monthKwh: number
    monthCost: number
    projectedMonthKwh: number | null
    projectedMonthCost: number | null
    projectedYearCost: number | null
  }
  series: Point[]
  hidden: boolean
}

export interface FleetProcess {
  pid: number
  ppid: number
  name: string
  cmd: string
  user: string
  cpu: number
  mem: number
  memPct: number
  threads?: number
}

export interface FleetDeviceDetail extends FleetDevice {
  daily: { day: string; kwh: number; upPct: number }[]
  detail: null | {
    at: number
    cpu: { total: number; cores: number[]; load: number[] }
    memory: Memory
    disks: { mount: string; device: string; fs: string | null; size: number; used: number }[]
    net: { rxBps: number; txBps: number; rxTotal: number; txTotal: number }
    temps: { cpu?: number; gpu?: number; disk?: number }
    fans: { name: string; rpm: number; maxRpm: number | null }[]
    gpu: null | { name: string; usage: number; watts: number; memUsed?: number; memTotal?: number }
    processes: FleetProcess[] | null
  }
}

export interface FleetStatus {
  enabled: boolean
  zip: string | null
  rate: { centsPerKwh: number; source: 'custom' | 'state' | 'us'; state: string | null; asOf: string | null }
  devices: FleetDevice[]
  totals: { watts: number; todayCost: number; monthCost: number; projectedMonthCost: number; projectedYearCost: number }
}

const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(body) })

export const getFleet = () => api<FleetStatus>('/api/fleet')
export const getFleetDevice = (id: string) => api<FleetDeviceDetail>(`/api/fleet/devices/${encodeURIComponent(id)}`)
export const setFleetSettings = (patch: { enabled?: boolean; zip?: string; rateCents?: number | null }) =>
  put<FleetStatus>('/api/fleet/settings', patch)
export const setFleetDevice = (id: string, patch: { name?: string; hidden?: boolean; baseWatts?: number | null; efficiency?: number | null }) =>
  put<FleetDevice>(`/api/fleet/devices/${encodeURIComponent(id)}`, patch)
export const forgetFleetDevice = (id: string) => api<{ ok: true }>(`/api/fleet/devices/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const getFleetAgent = () => api<{ token: string; url: string | null }>('/api/fleet/agent')
export const rotateFleetToken = () => api<{ token: string; url: string | null }>('/api/fleet/agent/token', { method: 'POST', body: '{}' })
