// fleet/power.mjs — how many watts this machine draws, measured where the
// hardware says and estimated where it does not.
//
// The collector reports the parts it can see; `wallWatts` turns them into an
// estimate at the wall (adding what no sensor covers, then power-supply loss).
//
//   macOS (Apple Silicon): macmon reads the SMC's total system power, CPU, GPU and
//     temperatures without root. One `macmon pipe` runs for the collector's life.
//     Without macmon, CPU load is scaled between an idle and a busy figure.
//   Linux: RAPL (/sys/class/powercap/intel-rapl:*) measures the CPU package. Its
//     energy counter is root-only by default; `fleet/agent.mjs --rapl-rule` prints
//     the one-time rule that makes it readable. NVIDIA GPUs report through
//     nvidia-smi. Anything unreadable is estimated and labelled so.
import { execFile, spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

const read = (p) => readFile(p, 'utf8')
const round = (w) => (w == null ? null : Math.round(w * 10) / 10)
const NVIDIA_RETRY_MS = 5 * 60_000

/** Typical draw of what no sensor sees, by platform, before power-supply loss. */
export const DEFAULT_MODEL = {
  linux: { baseWatts: 25, efficiency: 0.85, gpuIdleWatts: 12 },
  darwin: { baseWatts: 0, efficiency: 0.9, gpuIdleWatts: 0 },
}

/**
 * Wall watts from a snapshot's `power.parts`, with the owner's per-device
 * overrides (`baseWatts`, `efficiency`). Returns `{ watts, measured }`, where
 * `measured` is 'measured', 'partial' or 'estimated'.
 */
export function wallWatts(power, platform, overrides = {}) {
  if (!power?.parts) return { watts: null, measured: 'estimated' }
  const model = { ...(DEFAULT_MODEL[platform] || DEFAULT_MODEL.linux) }
  if (Number.isFinite(overrides.baseWatts) && overrides.baseWatts >= 0) model.baseWatts = overrides.baseWatts
  if (Number.isFinite(overrides.efficiency) && overrides.efficiency > 0.3 && overrides.efficiency <= 1) model.efficiency = overrides.efficiency
  const { system, cpu, gpu } = power.parts
  let dc
  let kinds
  if (system) {
    dc = system.w
    kinds = [system.measured]
  } else {
    dc = (cpu?.w || 0) + (gpu?.w || 0)
    kinds = [cpu?.measured, ...(gpu ? [gpu.measured] : [])]
  }
  dc += model.baseWatts
  const measured = kinds.every(Boolean) ? 'measured' : kinds.some(Boolean) ? 'partial' : 'estimated'
  return { watts: round(dc / model.efficiency), measured, model }
}

// ---- macOS ----------------------------------------------------------------

function findMacmon() {
  const env = process.env.FLEET_MACMON
  if (env) return existsSync(env) ? env : null
  return ['/opt/homebrew/bin/macmon', '/usr/local/bin/macmon'].find((p) => existsSync(p)) || null
}

function createMacPower() {
  const bin = findMacmon()
  let latest = null
  let child = null
  let stopped = false
  const start = () => {
    if (!bin || stopped) return
    child = spawn(bin, ['pipe', '-i', '2000'], { stdio: ['ignore', 'pipe', 'ignore'] })
    createInterface({ input: child.stdout }).on('line', (line) => {
      try { latest = { at: Date.now(), m: JSON.parse(line) } } catch {}
    })
    child.on('exit', () => { child = null; if (!stopped) setTimeout(start, 30_000).unref?.() })
    child.on('error', () => {})
  }
  start()

  return {
    async read({ cpuPct }) {
      const m = latest && Date.now() - latest.at < 15_000 ? latest.m : null
      if (!m) {
        // No macmon: an Apple Silicon desktop idles near 4 W at the board.
        const w = 4 + (cpuPct / 100) * 36
        return {
          power: { parts: { cpu: { w: round(w), measured: false } }, note: bin ? 'macmon has not answered yet' : 'Install macmon (brew install macmon) to measure power' },
          temps: {},
        }
      }
      const parts = {
        cpu: { w: round(m.cpu_power), measured: true },
        gpu: { w: round(m.gpu_power), measured: true },
      }
      if (Number.isFinite(m.sys_power) && m.sys_power > 0) parts.system = { w: round(m.sys_power), measured: true }
      const temps = {}
      if (Number.isFinite(m.temp?.cpu_temp_avg) && m.temp.cpu_temp_avg > 0) temps.cpu = round(m.temp.cpu_temp_avg)
      if (Number.isFinite(m.temp?.gpu_temp_avg) && m.temp.gpu_temp_avg > 0) temps.gpu = round(m.temp.gpu_temp_avg)
      return {
        power: { parts },
        temps,
        fans: (m.fans || []).map((f) => ({ name: f.name, rpm: Math.round(f.rpm), maxRpm: f.max_rpm || null })),
        gpu: { name: 'Apple GPU', usage: round((m.gpu_active_ratio || 0) * 100), watts: round(m.gpu_power) },
        memory: m.memory?.ram_total ? { total: m.memory.ram_total, used: m.memory.ram_usage, swapTotal: m.memory.swap_total, swapUsed: m.memory.swap_usage } : null,
      }
    },
    stop() { stopped = true; child?.kill() },
  }
}

// ---- Linux ----------------------------------------------------------------

async function raplPackages() {
  const base = '/sys/class/powercap'
  const out = []
  for (const d of await readdir(base).catch(() => [])) {
    if (!/^intel-rapl:\d+$/.test(d)) continue
    const name = (await read(`${base}/${d}/name`).catch(() => '')).trim()
    if (!name.startsWith('package')) continue
    const range = Number(await read(`${base}/${d}/max_energy_range_uj`).catch(() => 0))
    const maxUw = Number(await read(`${base}/${d}/constraint_0_max_power_uw`).catch(() => 0))
    out.push({ path: `${base}/${d}/energy_uj`, range, maxW: maxUw > 0 && maxUw < 500e6 ? maxUw / 1e6 : null })
  }
  return out
}

async function discreteGpu() {
  for (const d of await readdir('/sys/bus/pci/devices').catch(() => [])) {
    const dir = `/sys/bus/pci/devices/${d}`
    const cls = (await read(`${dir}/class`).catch(() => '')).trim()
    const vendor = (await read(`${dir}/vendor`).catch(() => '')).trim()
    if (cls.startsWith('0x03') && (vendor === '0x10de' || vendor === '0x1002')) return vendor === '0x10de' ? 'nvidia' : 'amd'
  }
  return null
}

const nvidiaQuery = () => new Promise((resolve) => {
  execFile('nvidia-smi', ['--query-gpu=name,power.draw,utilization.gpu,temperature.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 4000 }, (err, stdout) => {
    if (err) return resolve(null)
    const f = String(stdout).split('\n')[0].split(',').map((s) => s.trim())
    const watts = Number(f[1])
    resolve(Number.isFinite(watts) ? { name: f[0], watts, usage: Number(f[2]), temp: Number(f[3]), memUsed: Number(f[4]) * 1048576, memTotal: Number(f[5]) * 1048576 } : null)
  })
})

function createLinuxPower() {
  let packages = null
  let prev = null
  let gpuKind
  let nvidiaFailedAt = 0
  let raplNote = null

  async function cpuWatts(cpuPct) {
    packages ??= await raplPackages()
    if (packages.length) {
      try {
        const now = { at: Date.now(), uj: await Promise.all(packages.map((p) => read(p.path).then(Number))) }
        const before = prev
        prev = now
        if (!before) return null // the first reading only sets the baseline
        const dt = (now.at - before.at) / 1000
        let joules = 0
        now.uj.forEach((v, i) => { let d = v - before.uj[i]; if (d < 0) d += packages[i].range; joules += d / 1e6 })
        return dt > 0 ? { w: round(joules / dt), measured: true } : null
      } catch (e) {
        if (e.code === 'EACCES') raplNote = 'CPU power is estimated: RAPL is root-only here (run `node fleet/agent.mjs --rapl-rule`)'
      }
    }
    return null
  }

  // A desktop CPU idles near a tenth of its rated power.
  function cpuEstimate(cpuPct) {
    const maxW = packages?.find((p) => p.maxW)?.maxW || 65
    const idle = maxW * 0.08
    return { w: round(idle + (maxW - idle) * (cpuPct / 100)), measured: false }
  }

  return {
    async read({ cpuPct }) {
      const cpu = (await cpuWatts(cpuPct)) || cpuEstimate(cpuPct)
      if (gpuKind === undefined) gpuKind = await discreteGpu()
      let gpuPart = null
      let gpu = null
      const temps = {}
      let gpuNote = null
      if (gpuKind === 'nvidia' && Date.now() - nvidiaFailedAt > NVIDIA_RETRY_MS) {
        const q = await nvidiaQuery()
        if (q) {
          gpu = { name: q.name, usage: q.usage, watts: q.watts, memUsed: q.memUsed, memTotal: q.memTotal }
          gpuPart = { w: round(q.watts), measured: true }
          if (Number.isFinite(q.temp)) temps.gpu = q.temp
        } else nvidiaFailedAt = Date.now()
      }
      if (gpuKind && !gpuPart) {
        gpuPart = { w: DEFAULT_MODEL.linux.gpuIdleWatts, measured: false }
        gpuNote = gpuKind === 'nvidia' ? 'GPU power is estimated: nvidia-smi is not answering (a driver update usually needs a reboot)' : 'GPU power is estimated'
      }
      const note = [cpu.measured ? null : raplNote, gpuNote].filter(Boolean).join('. ') || null
      return { power: { parts: { cpu, ...(gpuPart ? { gpu: gpuPart } : {}) }, note }, temps, gpu }
    },
    stop() {},
  }
}

export function createPower() {
  return process.platform === 'darwin' ? createMacPower() : createLinuxPower()
}
