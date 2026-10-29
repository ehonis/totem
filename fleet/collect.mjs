// fleet/collect.mjs — one reading of this machine: uptime, CPU, memory, disks,
// network, temperatures, power and (when someone is looking) the processes.
//
// Runs inside the bridge for the machine Totem is on, and inside fleet/agent.mjs
// on every other machine, so it imports nothing outside node: and ./power.mjs.
// Linux reads /proc and /sys; macOS shells out to ps, df, netstat and vm_stat, and
// reads power and temperatures from macmon when it is installed (fleet/power.mjs).
import os from 'node:os'
import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { createPower } from './power.mjs'

const run = (cmd, args, timeout = 5000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)))
})
const read = (p) => readFile(p, 'utf8').catch(() => '')
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)

const DISK_TTL_MS = 30_000
const SKIP_FS = /^(tmpfs|devtmpfs|overlay|squashfs|proc|sysfs|cgroup2?|efivarfs|autofs|fuse\..*|nsfs|ramfs|devfs|map .*)$/
// Interfaces that would count the same bytes twice (bridges, VPN tunnels, containers).
const SKIP_IF = /^(lo|veth|docker|br-|virbr|tailscale|utun|bridge|awdl|llw|anpi|ap\d|gif|stf)/

async function osName() {
  if (process.platform === 'darwin') {
    const v = (await run('sw_vers', ['-productVersion'])).trim()
    return v ? `macOS ${v}` : 'macOS'
  }
  const rel = await read('/etc/os-release')
  return /^PRETTY_NAME="?([^"\n]+)"?/m.exec(rel)?.[1] || `${os.type()} ${os.release()}`
}

function cpuTimes() {
  return os.cpus().map((c) => {
    const t = c.times
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq }
  })
}

async function memory() {
  if (process.platform === 'linux') {
    const m = Object.fromEntries((await read('/proc/meminfo')).split('\n').map((l) => {
      const [k, v] = l.split(':')
      return [k, Number.parseInt(v, 10) * 1024]
    }))
    const total = m.MemTotal || os.totalmem()
    const available = m.MemAvailable ?? os.freemem()
    return { total, used: total - available, available, swapTotal: m.SwapTotal || 0, swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0) }
  }
  // Activity Monitor's "Memory Used": app (active) + wired + compressed.
  const vm = await run('vm_stat', [])
  const page = Number(/page size of (\d+)/.exec(vm)?.[1] || 16384)
  const pages = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(vm)?.[1] || 0) * page
  const total = os.totalmem()
  const used = Math.min(total, pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor'))
  const swap = await run('sysctl', ['-n', 'vm.swapusage'])
  const mb = (k) => Number(new RegExp(`${k} = ([\\d.]+)M`).exec(swap)?.[1] || 0) * 1024 * 1024
  return { total, used, available: total - used, swapTotal: mb('total'), swapUsed: mb('used') }
}

async function disks() {
  const out = await run('df', process.platform === 'linux' ? ['-kPT'] : ['-kP'])
  const rows = []
  for (const line of out.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 6) continue
    const linux = process.platform === 'linux'
    const [dev, fsType] = linux ? [parts[0], parts[1]] : [parts[0], '']
    const [size, used] = (linux ? parts.slice(2, 4) : parts.slice(1, 3)).map((k) => Number(k) * 1024)
    let mount = parts.slice(linux ? 6 : 5).join(' ')
    if (linux && (SKIP_FS.test(fsType) || mount.startsWith('/snap') || mount.startsWith('/boot/efi'))) continue
    if (!linux) {
      // The sealed system snapshot at / is a few GB; the Data volume is the disk.
      // Outside it, only real external volumes count, not Recovery or the
      // simulator runtimes macOS mounts under /private/var.
      if (mount === '/System/Volumes/Data') mount = '/'
      else if (!dev.startsWith('/dev/') || !mount.startsWith('/Volumes/') || mount === '/Volumes/Recovery') continue
    }
    if (!size) continue
    rows.push({ mount, device: dev, fs: fsType || null, size, used })
  }
  return rows
}

async function netCounters() {
  let rx = 0
  let tx = 0
  if (process.platform === 'linux') {
    for (const line of (await read('/proc/net/dev')).split('\n').slice(2)) {
      const [name, rest] = line.split(':')
      if (!rest || SKIP_IF.test(name.trim())) continue
      const f = rest.trim().split(/\s+/).map(Number)
      rx += f[0]; tx += f[8]
    }
  } else {
    const seen = new Set()
    for (const line of (await run('netstat', ['-ibn'])).split('\n').slice(1)) {
      const f = line.trim().split(/\s+/)
      if (!f[2]?.startsWith('<Link#') || SKIP_IF.test(f[0]) || seen.has(f[0])) continue
      seen.add(f[0])
      // Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
      const addrLess = f.length === 10
      rx += Number(f[addrLess ? 5 : 6]) || 0
      tx += Number(f[addrLess ? 8 : 9]) || 0
    }
  }
  return { rx, tx }
}

async function linuxTemps() {
  const out = {}
  for (const d of await readdir('/sys/class/hwmon').catch(() => [])) {
    const base = `/sys/class/hwmon/${d}`
    const name = (await read(`${base}/name`)).trim()
    if (name === 'coretemp' || name === 'k10temp' || name === 'zenpower') {
      const v = num(await read(`${base}/temp1_input`))
      if (v != null) out.cpu = v / 1000
    } else if (name === 'nvme' && out.disk == null) {
      const v = num(await read(`${base}/temp1_input`))
      if (v != null) out.disk = v / 1000
    }
  }
  return out
}

// ---- processes ------------------------------------------------------------
// CPU % is of one core, as top and ps show it (a busy 4-thread process reads 400).

const users = new Map()
async function userName(uid) {
  if (!users.size) {
    for (const line of (await read('/etc/passwd')).split('\n')) {
      const f = line.split(':')
      if (f.length > 2) users.set(Number(f[2]), f[0])
    }
  }
  return users.get(uid) || String(uid)
}

const CLK_TCK = 100
async function linuxProcesses(prev, dtSec) {
  const now = new Map()
  const rows = []
  const page = 4096
  const total = os.totalmem()
  for (const pid of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(pid)) continue
    const raw = await read(`/proc/${pid}/stat`)
    if (!raw) continue
    const close = raw.lastIndexOf(')')
    const name = raw.slice(raw.indexOf('(') + 1, close)
    const f = raw.slice(close + 2).split(' ')
    const ticks = Number(f[11]) + Number(f[12])
    now.set(pid, ticks)
    const before = prev.get(pid)
    const cpu = before == null || !dtSec ? 0 : Math.max(0, ((ticks - before) / CLK_TCK / dtSec) * 100)
    const rss = Number(f[21]) * page
    rows.push({ pid: Number(pid), ppid: Number(f[1]), name, cpu, mem: rss, memPct: (rss / total) * 100, threads: Number(f[17]) })
  }
  rows.sort((a, b) => b.cpu - a.cpu || b.mem - a.mem)
  return { rows, ticks: now }
}

async function darwinProcesses() {
  // macOS keeps its users in Directory Services, not /etc/passwd, so ps names them.
  const out = await run('ps', ['-Ao', 'pid=,ppid=,user=,%cpu=,%mem=,rss=,comm='])
  const rows = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line)
    if (!m) continue
    const cmd = m[7].trim()
    rows.push({ pid: +m[1], ppid: +m[2], user: m[3], name: cmd.split('/').pop(), cmd, cpu: +m[4], memPct: +m[5], mem: +m[6] * 1024 })
  }
  rows.sort((a, b) => b.cpu - a.cpu || b.mem - a.mem)
  return rows
}

async function finishProcesses(rows, limit) {
  const top = rows.slice(0, limit)
  for (const p of top) {
    if (process.platform === 'linux') {
      const st = await stat(`/proc/${p.pid}`).catch(() => null)
      p.user = st ? await userName(st.uid) : ''
      const cmd = (await read(`/proc/${p.pid}/cmdline`)).split('\0').filter(Boolean).join(' ')
      p.cmd = cmd || `[${p.name}]`
    }
    p.cpu = Math.round(p.cpu * 10) / 10
    p.memPct = Math.round(p.memPct * 10) / 10
    if (p.cmd.length > 300) p.cmd = `${p.cmd.slice(0, 299)}…`
  }
  return top
}

/**
 * `sample({ processes })` returns one snapshot. Rates (CPU %, network, process
 * CPU) are measured since the previous call, so the first one reads zero.
 */
export function createCollector({ id, name, power = createPower(), processLimit = 80 } = {}) {
  let prevCpu = cpuTimes()
  let prevNet = null
  let prevAt = Date.now()
  let prevTicks = new Map()
  let ticksAt = 0
  let disksCache = { at: 0, rows: [] }
  let staticInfo = null

  async function info() {
    if (!staticInfo) {
      const cpus = os.cpus()
      staticInfo = {
        hostname: os.hostname().replace(/\.local$/, ''),
        platform: process.platform,
        os: await osName(),
        arch: os.arch(),
        cpuModel: (cpus[0]?.model || '').replace(/\s+/g, ' ').trim(),
        cores: cpus.length,
      }
    }
    return staticInfo
  }

  return {
    async id() { return id || (await info()).hostname },
    async sample({ processes = false } = {}) {
      const at = Date.now()
      const dt = Math.max(0.001, (at - prevAt) / 1000)
      const cpuNow = cpuTimes()
      const cores = cpuNow.map((c, i) => {
        const p = prevCpu[i] || c
        const total = c.total - p.total
        return total > 0 ? Math.round((1 - (c.idle - p.idle) / total) * 1000) / 10 : 0
      })
      prevCpu = cpuNow

      const counters = await netCounters()
      const net = prevNet
        ? { rxBps: Math.max(0, (counters.rx - prevNet.rx) / dt), txBps: Math.max(0, (counters.tx - prevNet.tx) / dt), rxTotal: counters.rx, txTotal: counters.tx }
        : { rxBps: 0, txBps: 0, rxTotal: counters.rx, txTotal: counters.tx }
      prevNet = counters

      if (at - disksCache.at > DISK_TTL_MS) disksCache = { at, rows: await disks() }

      const cpuTotal = cores.length ? Math.round((cores.reduce((a, b) => a + b, 0) / cores.length) * 10) / 10 : 0
      const pw = await power.read({ cpuPct: cpuTotal })
      let mem = await memory()
      if (pw.memory) mem = { ...mem, ...pw.memory, available: pw.memory.total - pw.memory.used }
      const temps = { ...(process.platform === 'linux' ? await linuxTemps() : {}), ...pw.temps }

      let procs
      if (processes) {
        if (process.platform === 'linux') {
          // Process CPU needs two readings; nobody was watching, so take the first now.
          if (!prevTicks.size) {
            prevTicks = (await linuxProcesses(new Map(), 0)).ticks
            ticksAt = Date.now()
            await new Promise((r) => setTimeout(r, 700))
          }
          const now = Date.now()
          const { rows, ticks } = await linuxProcesses(prevTicks, (now - ticksAt) / 1000)
          prevTicks = ticks
          ticksAt = now
          procs = await finishProcesses(rows, processLimit)
        } else {
          procs = await finishProcesses(await darwinProcesses(), processLimit)
        }
      } else {
        prevTicks = new Map()
      }
      prevAt = at

      const uptimeSec = Math.round(os.uptime())
      return {
        v: 1,
        id: id || (await info()).hostname,
        name: name || null,
        ...(await info()),
        at,
        uptimeSec,
        bootedAt: at - uptimeSec * 1000,
        cpu: { total: cpuTotal, cores, load: os.loadavg().map((l) => Math.round(l * 100) / 100) },
        memory: mem,
        disks: disksCache.rows,
        net,
        temps,
        fans: pw.fans || [],
        gpu: pw.gpu || null,
        power: pw.power,
        processes: procs,
      }
    },
    stop() { power.stop?.() },
  }
}
