import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getFleet, getFleetDevice, setFleetSettings, setFleetDevice, forgetFleetDevice, getFleetAgent, rotateFleetToken,
  type FleetStatus, type FleetDevice, type FleetDeviceDetail, type FleetProcess, type Point, type Health,
} from './api'
import { bytes, rate, duration, uptimeSince, money, pct, watts, heat, MEASURED_LABEL } from './format'
import { AuthError } from '../api'
import { pushToast } from '../toast'
import { Hi, ChevronLeftIcon, ClipboardDocumentIcon, WarnIcon } from '../icons'
import './fleet.css'

// The Fleet tab: the owner's machines as a health page — up or down, how long,
// what they are doing, what they draw and what that costs. The machine Totem runs
// on reports itself; others run fleet/agent.mjs. A machine's detail (/fleet#<id>)
// is btop in a browser: cores, memory, disks, network and the process list, which
// the machine only sends while the page is open. docs/fleet.md.

const LIST_MS = 5000
const DETAIL_MS = 3000

const HEALTH_LABEL: Record<Health, string> = { ok: 'Healthy', warn: 'Needs a look', bad: 'Trouble', down: 'Offline' }

function usePoll(fn: () => Promise<void>, ms: number, key: unknown) {
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (!document.hidden) await fn().catch(() => {})
      if (!stopped) timer = setTimeout(tick, ms)
    }
    tick()
    const onShow = () => { if (!document.hidden) fn().catch(() => {}) }
    document.addEventListener('visibilitychange', onShow)
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onShow) }
  }, [ms, key]) // eslint-disable-line react-hooks/exhaustive-deps
}

function Spark({ points, field, max, className = '' }: { points: Point[]; field: 'cpu' | 'mem' | 'w' | 'rx' | 'tx'; max?: number; className?: string }) {
  const values = points.map((p) => Number(p[field]) || 0)
  if (values.length < 2) return <svg className={`fl-spark ${className}`} viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden />
  const top = max ?? Math.max(1, ...values) * 1.15
  const step = 100 / (values.length - 1)
  const line = values.map((v, i) => `${(i * step).toFixed(2)},${(24 - (v / top) * 23).toFixed(2)}`).join(' ')
  return (
    <svg className={`fl-spark ${className}`} viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden>
      <polygon points={`0,24 ${line} 100,24`} className="fl-spark-fill" />
      <polyline points={line} className="fl-spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Bar({ value, label, right, thin }: { value: number; label?: React.ReactNode; right?: React.ReactNode; thin?: boolean }) {
  const v = Math.max(0, Math.min(100, value || 0))
  return (
    <div className={`fl-bar-row${thin ? ' thin' : ''}`}>
      {label != null && <span className="fl-bar-label">{label}</span>}
      <span className="fl-bar"><span className={`fl-bar-fill ${heat(v)}`} style={{ width: `${v}%` }} /></span>
      {right != null && <span className="fl-bar-right">{right}</span>}
    </div>
  )
}

const Dot = ({ level }: { level: Health }) => <span className={`fl-dot fl-dot-${level}`} title={HEALTH_LABEL[level]} aria-label={HEALTH_LABEL[level]} />

function rateLabel(s: FleetStatus) {
  const r = s.rate
  const where = r.source === 'custom' ? 'your rate' : r.source === 'state' ? `${r.state} average` : 'US average'
  return `${r.centsPerKwh.toFixed(2)}¢/kWh, ${where}`
}

export default function FleetView({ onAuthError, deviceId, onOpen }: {
  onAuthError: () => void
  deviceId: string | null
  onOpen: (id: string | null) => void
}) {
  const [status, setStatus] = useState<FleetStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  const fail = useCallback((e: any) => {
    if (e instanceof AuthError) onAuthError()
    else setError(e.message)
  }, [onAuthError])

  const load = useCallback(async () => {
    try { setStatus(await getFleet()); setError(null) } catch (e) { fail(e) }
  }, [fail])
  usePoll(load, LIST_MS, deviceId ? 'detail' : 'list')

  if (deviceId) return <DeviceView id={deviceId} status={status} onBack={() => onOpen(null)} onAuthError={onAuthError} onChanged={load} />

  const shown = status?.devices.filter((d) => !d.hidden) || []
  const hidden = status?.devices.filter((d) => d.hidden) || []

  return (
    <div className="view fleet-view">
      <div className="view-head">
        <div>
          <h1 style={{ marginBottom: 2 }}>Fleet</h1>
          <div className="muted" style={{ fontSize: 13 }}>Your machines: health, uptime, power and what it costs</div>
        </div>
        <div className="view-head-actions">
          <button className="btn" onClick={() => setShowSettings((v) => !v)}>{showSettings ? 'Done' : 'Settings'}</button>
        </div>
      </div>

      {error && <div className="muted inline-warn"><WarnIcon /> {error}</div>}
      {!status ? (
        !error && <div className="spinner">Reading machines…</div>
      ) : (
        <>
          {(showSettings || !status.enabled) && <FleetSettings status={status} onStatus={setStatus} onError={fail} />}
          {status.enabled && (
            <>
              <section className="fl-totals">
                <div><b>{watts(status.totals.watts)}</b><span>drawing now</span></div>
                <div><b>{money(status.totals.todayCost)}</b><span>today</span></div>
                <div><b>{money(status.totals.monthCost)}</b><span>this month</span></div>
                <div><b>{money(status.totals.projectedMonthCost)}</b><span>a month, projected</span></div>
                <div><b>{money(status.totals.projectedYearCost)}</b><span>a year, projected</span></div>
                <div className="fl-totals-rate muted">{rateLabel(status)} · estimates</div>
              </section>
              {shown.length === 0 && <div className="muted dev-none">No readings yet. This machine reports within a few seconds.</div>}
              <div className="fl-grid">
                {shown.map((d) => <DeviceCard key={d.id} d={d} onOpen={() => onOpen(d.id)} />)}
              </div>
              {hidden.length > 0 && (
                <div className="muted fl-hidden">
                  Hidden: {hidden.map((d, i) => (
                    <React.Fragment key={d.id}>{i > 0 && ', '}<button className="link-btn" onClick={() => onOpen(d.id)}>{d.name}</button></React.Fragment>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

function DeviceCard({ d, onOpen }: { d: FleetDevice; onOpen: () => void }) {
  const n = d.now
  const memPct = n?.mem.total ? (n.mem.used / n.mem.total) * 100 : 0
  return (
    <button type="button" className={`card fl-card fl-${d.health.level}`} onClick={onOpen}>
      <div className="fl-card-head">
        <Dot level={d.health.level} />
        <span className="fl-name">{d.name}</span>
        <span className="muted fl-os">{d.os}</span>
      </div>
      <div className="fl-card-up">
        {d.online ? <>Up <b>{uptimeSince(d.bootedAt)}</b></> : <>Last seen <b>{d.lastSeen ? duration((Date.now() - d.lastSeen) / 1000) : '–'}</b> ago</>}
        <span className="muted"> · {pct(d.uptime.pct24h, 1)} 24h · {pct(d.uptime.pct7d, 1)} 7d · {pct(d.uptime.pct30d, 1)} 30d</span>
      </div>
      {n && (
        <div className="fl-card-meters">
          <Bar label="CPU" value={n.cpu} right={pct(n.cpu)} />
          <Bar label="Mem" value={memPct} right={pct(memPct)} />
          <Spark points={d.series} field="cpu" max={100} />
        </div>
      )}
      <div className="fl-card-power">
        <div>
          <b className="fl-watts">{watts(n?.watts)}</b>
          {n && <span className={`fl-badge fl-badge-${n.measured}`}>{MEASURED_LABEL[n.measured]}</span>}
        </div>
        <div className="fl-costs">
          <span><b>{money(d.energy.todayCost)}</b> today</span>
          <span><b>{money(d.energy.monthCost)}</b> month</span>
          <span><b>{money(d.energy.projectedMonthCost)}</b>/mo projected</span>
        </div>
      </div>
      {d.health.issues.length > 0 && (
        <ul className="fl-issues">{d.health.issues.map((i) => <li key={i.text} className={`fl-issue-${i.level}`}>{i.text}</li>)}</ul>
      )}
    </button>
  )
}

function FleetSettings({ status, onStatus, onError }: { status: FleetStatus; onStatus: (s: FleetStatus) => void; onError: (e: unknown) => void }) {
  const [zip, setZip] = useState(status.zip || '')
  const [cents, setCents] = useState(status.rate.source === 'custom' ? String(status.rate.centsPerKwh) : '')
  const [agent, setAgent] = useState<{ token: string; url: string | null } | null>(null)
  const [url, setUrl] = useState('')
  const save = async (patch: Parameters<typeof setFleetSettings>[0]) => {
    try { onStatus(await setFleetSettings(patch)) } catch (e: any) { onError(e); pushToast(e.message) }
  }
  const showAgent = async () => {
    try {
      const a = await getFleetAgent()
      setAgent(a)
      setUrl(a.url || window.location.origin)
    } catch (e) { onError(e) }
  }
  const rotate = async () => {
    if (!window.confirm('Make a new token? Machines using the old one stop reporting until reinstalled.')) return
    try { setAgent(await rotateFleetToken()) } catch (e) { onError(e) }
  }
  const command = agent ? `node fleet/agent.mjs --install --url ${url} --token ${agent.token}` : ''
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); pushToast('Copied.', 'success', { duration: 2000 }) } catch { pushToast('Could not copy; select the line instead.') }
  }

  return (
    <section className="card dev-card fl-settings">
      <div className="dev-card-head">
        <h2>Fleet</h2>
        <label className="dev-switch-label">
          {status.enabled ? 'On' : 'Off'}
          <button type="button" role="switch" aria-checked={status.enabled} className={`switch ${status.enabled ? 'on' : ''}`} onClick={() => save({ enabled: !status.enabled })}><span /></button>
        </label>
      </div>
      {!status.enabled && (
        <p className="muted">
          When on, Totem reads this machine every few seconds and keeps an hourly record of uptime and energy in
          <code> data/fleet-history.json</code>. Other machines report with a small agent.
        </p>
      )}
      <h3>Electricity price</h3>
      <div className="fl-form">
        <label>ZIP code
          <input className="input" inputMode="numeric" value={zip} placeholder="e.g. 10001" onChange={(e) => setZip(e.target.value)} onBlur={() => zip !== (status.zip || '') && save({ zip })} />
        </label>
        <label>Your rate, ¢/kWh
          <input className="input" inputMode="decimal" value={cents} placeholder="from your bill (optional)" onChange={(e) => setCents(e.target.value)} onBlur={() => save({ rateCents: cents.trim() ? Number(cents) : null })} />
        </label>
      </div>
      <p className="muted">
        Using {rateLabel(status)}{status.rate.asOf && status.rate.source !== 'custom' ? ` (EIA, ${status.rate.asOf})` : ''}.
        State averages include delivery charges on average, not your utility's tiers or time-of-use pricing.
      </p>
      <h3>Add a machine</h3>
      {!agent ? (
        <button className="btn compact" onClick={showAgent}>Show install command</button>
      ) : (
        <>
          <p className="muted">On the other machine (Linux, node 20+), from a Totem checkout. It installs a systemd user service that reports here.</p>
          <div className="fl-form">
            <label>Address it reaches Totem at
              <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
          </div>
          <div className="dev-setup-command">
            <code>{command}</code>
            <button type="button" className="btn compact" onClick={copy}><Hi icon={ClipboardDocumentIcon} size={13} /> Copy</button>
            <button type="button" className="btn compact" onClick={rotate}>New token</button>
          </div>
        </>
      )}
    </section>
  )
}

// ---- one machine ------------------------------------------------------------

type SortKey = 'cpu' | 'mem' | 'pid' | 'name'

function DeviceView({ id, status, onBack, onAuthError, onChanged }: {
  id: string
  status: FleetStatus | null
  onBack: () => void
  onAuthError: () => void
  onChanged: () => void
}) {
  const [d, setD] = useState<FleetDeviceDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const load = useCallback(async () => {
    try { setD(await getFleetDevice(id)); setMissing(false) } catch (e: any) {
      if (e instanceof AuthError) onAuthError()
      else if (e.status === 404) setMissing(true)
    }
  }, [id, onAuthError])
  usePoll(load, DETAIL_MS, id)

  return (
    <div className="view fleet-view fl-detail">
      <div className="view-head">
        <div className="fl-detail-title">
          <button className="btn compact" onClick={onBack} aria-label="All machines"><Hi icon={ChevronLeftIcon} size={14} /> Fleet</button>
          {d && <><Dot level={d.health.level} /><h1>{d.name}</h1></>}
        </div>
        {d && <span className="muted fl-sub">{d.os} · {d.cpuModel} · {d.cores} cores</span>}
      </div>
      {missing ? <div className="muted">No machine called {id}.</div> : !d ? <div className="spinner">Reading {id}…</div> : (
        <>
          {d.health.issues.length > 0 && (
            <ul className="fl-issues fl-issues-wide">{d.health.issues.map((i) => <li key={i.text} className={`fl-issue-${i.level}`}>{i.text}</li>)}</ul>
          )}
          <div className="fl-panels">
            <CpuPanel d={d} />
            <MemPanel d={d} />
            <PowerPanel d={d} status={status} onChanged={(next) => { setD((cur) => cur && { ...cur, ...next }); onChanged() }} />
            <UptimePanel d={d} />
            <DiskNetPanel d={d} />
            <EnergyPanel d={d} />
          </div>
          <ProcessPanel procs={d.detail?.processes ?? null} online={d.online} />
          <DeviceAdmin d={d} onBack={onBack} onChanged={onChanged} />
        </>
      )}
    </div>
  )
}

function Panel({ title, right, children, className = '' }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`fl-panel ${className}`}>
      <header><span className="fl-panel-title">{title}</span>{right != null && <span className="fl-panel-right">{right}</span>}</header>
      {children}
    </section>
  )
}

function CpuPanel({ d }: { d: FleetDeviceDetail }) {
  const c = d.detail?.cpu
  const t = d.detail?.temps
  return (
    <Panel title="cpu" right={<>{c ? pct(c.total) : '–'}{t?.cpu != null && <> · {Math.round(t.cpu)}°C</>}</>}>
      <Spark points={d.series} field="cpu" max={100} className="tall" />
      <div className="fl-cores">
        {c?.cores.map((v, i) => <Bar key={i} thin label={`C${i}`} value={v} right={`${Math.round(v)}%`} />)}
      </div>
      {c && <div className="fl-kv"><span>load</span><b>{c.load.map((l) => l.toFixed(2)).join('  ')}</b></div>}
    </Panel>
  )
}

function MemPanel({ d }: { d: FleetDeviceDetail }) {
  const m = d.detail?.memory
  const gpu = d.detail?.gpu
  const fans = d.detail?.fans || []
  return (
    <Panel title="mem" right={m ? `${bytes(m.used)} / ${bytes(m.total)}` : '–'}>
      <Spark points={d.series} field="mem" max={100} />
      {m && <Bar label="used" value={(m.used / m.total) * 100} right={bytes(m.used)} />}
      {m && m.swapTotal > 0 && <Bar label="swap" value={(m.swapUsed / m.swapTotal) * 100} right={`${bytes(m.swapUsed)} / ${bytes(m.swapTotal)}`} />}
      {gpu && (
        <>
          <Bar label="gpu" value={gpu.usage} right={`${Math.round(gpu.usage)}% · ${watts(gpu.watts)}`} />
          {gpu.memTotal ? <Bar label="vram" value={((gpu.memUsed || 0) / gpu.memTotal) * 100} right={`${bytes(gpu.memUsed)} / ${bytes(gpu.memTotal)}`} /> : null}
        </>
      )}
      {fans.map((f) => <div className="fl-kv" key={f.name}><span>{f.name}</span><b>{f.rpm} rpm</b></div>)}
      {d.detail?.temps.gpu != null && <div className="fl-kv"><span>gpu temp</span><b>{Math.round(d.detail.temps.gpu)}°C</b></div>}
      {d.detail?.temps.disk != null && <div className="fl-kv"><span>disk temp</span><b>{Math.round(d.detail.temps.disk)}°C</b></div>}
    </Panel>
  )
}

function DiskNetPanel({ d }: { d: FleetDeviceDetail }) {
  const n = d.detail?.net
  return (
    <Panel title="disks · net" right={n ? `↓ ${rate(n.rxBps)}  ↑ ${rate(n.txBps)}` : '–'}>
      {d.detail?.disks.map((k) => (
        <Bar key={k.mount} label={k.mount} value={(k.used / k.size) * 100} right={`${bytes(k.used)} / ${bytes(k.size)}`} />
      ))}
      <div className="fl-net">
        <div><span className="muted">down</span><Spark points={d.series} field="rx" className="rx" /></div>
        <div><span className="muted">up</span><Spark points={d.series} field="tx" className="tx" /></div>
      </div>
      {n && <div className="fl-kv"><span>since boot</span><b>↓ {bytes(n.rxTotal)}  ↑ {bytes(n.txTotal)}</b></div>}
    </Panel>
  )
}

function UptimePanel({ d }: { d: FleetDeviceDetail }) {
  return (
    <Panel title="uptime" right={d.online ? 'online' : 'offline'}>
      <div className="fl-big">{d.online ? uptimeSince(d.bootedAt) : '–'}</div>
      <div className="muted fl-small">{d.bootedAt ? `since ${new Date(d.bootedAt).toLocaleString()}` : ''}</div>
      <div className="fl-kv"><span>last 24 hours</span><b>{pct(d.uptime.pct24h, 2)}</b></div>
      <div className="fl-kv"><span>last 7 days</span><b>{pct(d.uptime.pct7d, 2)}</b></div>
      <div className="fl-kv"><span>last 30 days</span><b>{pct(d.uptime.pct30d, 2)}</b></div>
      <div className="muted fl-small">
        {d.uptime.watchedSince ? `Watched since ${new Date(d.uptime.watchedSince).toLocaleString()}` : ''}
        {d.uptime.since && d.uptime.watchedSince && d.uptime.since < d.uptime.watchedSince ? '; earlier uptime comes from its boot time' : ''}
      </div>
    </Panel>
  )
}

function PowerPanel({ d, status, onChanged }: { d: FleetDeviceDetail; status: FleetStatus | null; onChanged: (next: FleetDevice) => void }) {
  const p = d.power
  const [base, setBase] = useState(p.overrides.baseWatts != null ? String(p.overrides.baseWatts) : '')
  const [eff, setEff] = useState(p.overrides.efficiency != null ? String(Math.round(p.overrides.efficiency * 100)) : '')
  const save = async (patch: Parameters<typeof setFleetDevice>[1]) => {
    try { onChanged(await setFleetDevice(d.id, patch)) } catch (e: any) { pushToast(e.message) }
  }
  const part = (label: string, x?: { w: number; measured: boolean }) => x && (
    <div className="fl-kv"><span>{label}</span><b>{watts(x.w)} <span className="muted">{x.measured ? 'measured' : 'estimated'}</span></b></div>
  )
  return (
    <Panel title="power" right={d.now ? MEASURED_LABEL[d.now.measured] : '–'}>
      <div className="fl-big">{watts(d.now?.watts)}<span className="muted fl-small"> at the wall</span></div>
      <Spark points={d.series} field="w" />
      {p.parts?.system ? part('whole system', p.parts.system) : <>{part('cpu', p.parts?.cpu)}{part('gpu', p.parts?.gpu)}</>}
      {p.model && (
        <>
          <div className="fl-kv"><span>+ rest of the machine</span><b>{watts(p.model.baseWatts)} <span className="muted">assumed</span></b></div>
          <div className="fl-kv"><span>÷ power supply</span><b>{Math.round(p.model.efficiency * 100)}% <span className="muted">efficient</span></b></div>
        </>
      )}
      {p.note && <p className="muted fl-small fl-note">{p.note}</p>}
      <details className="fl-tune">
        <summary className="muted">Adjust the estimate</summary>
        <div className="fl-form">
          <label>Rest of the machine, W
            <input className="input" inputMode="decimal" value={base} placeholder={p.model ? String(p.model.baseWatts) : ''} onChange={(e) => setBase(e.target.value)} onBlur={() => save({ baseWatts: base.trim() ? Number(base) : null })} />
          </label>
          <label>Power supply efficiency, %
            <input className="input" inputMode="numeric" value={eff} placeholder={p.model ? String(Math.round(p.model.efficiency * 100)) : ''} onChange={(e) => setEff(e.target.value)} onBlur={() => save({ efficiency: eff.trim() ? Number(eff) / 100 : null })} />
          </label>
        </div>
        <p className="muted fl-small">A plug-in power meter's reading at idle, minus what the sensors show, is the best figure for the first box.</p>
      </details>
      {status && <div className="muted fl-small">{rateLabel(status)}</div>}
    </Panel>
  )
}

function EnergyPanel({ d }: { d: FleetDeviceDetail }) {
  const e = d.energy
  const max = Math.max(0.001, ...d.daily.map((x) => x.kwh))
  return (
    <Panel title="energy" right={e.avgWatts != null ? `avg ${watts(e.avgWatts)}` : '–'}>
      <div className="fl-energy">
        <div><b>{money(e.todayCost)}</b><span>{e.todayKwh.toFixed(2)} kWh today</span></div>
        <div><b>{money(e.monthCost)}</b><span>{e.monthKwh.toFixed(1)} kWh this month</span></div>
        <div><b>{money(e.projectedMonthCost)}</b><span>{e.projectedMonthKwh ?? '–'} kWh a month</span></div>
        <div><b>{money(e.projectedYearCost)}</b><span>a year</span></div>
      </div>
      <div className="fl-days" aria-label="Energy per day, last 30 days">
        {d.daily.map((x) => (
          <span key={x.day} className="fl-day" title={`${x.day}: ${x.kwh.toFixed(2)} kWh, up ${x.upPct}%`}>
            <span style={{ height: `${(x.kwh / max) * 100}%` }} />
          </span>
        ))}
      </div>
      <div className="muted fl-small">kWh per day, last {d.daily.length} days</div>
    </Panel>
  )
}

function ProcessPanel({ procs, online }: { procs: FleetProcess[] | null; online: boolean }) {
  const [sort, setSort] = useState<SortKey>('cpu')
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = (procs || []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.cmd.toLowerCase().includes(q) || String(p.pid) === q)
    const by: Record<SortKey, (a: FleetProcess, b: FleetProcess) => number> = {
      cpu: (a, b) => b.cpu - a.cpu,
      mem: (a, b) => b.mem - a.mem,
      pid: (a, b) => a.pid - b.pid,
      name: (a, b) => a.name.localeCompare(b.name),
    }
    return [...list].sort(by[sort])
  }, [procs, sort, filter])
  const head = (key: SortKey, label: string, cls = '') => (
    <th className={`${cls}${sort === key ? ' on' : ''}`}><button onClick={() => setSort(key)}>{label}</button></th>
  )
  return (
    <Panel title="proc" className="fl-proc" right={
      <input className="input fl-filter" placeholder="filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
    }>
      {!online ? <div className="muted fl-small">Offline.</div> : !procs ? <div className="muted fl-small">Asking for processes…</div> : (
        <div className="fl-proc-scroll">
          <table>
            <thead><tr>{head('pid', 'pid', 'num')}{head('name', 'program')}<th className="hide-narrow">user</th>{head('cpu', 'cpu%', 'num')}{head('mem', 'mem', 'num')}</tr></thead>
            <tbody>
              {rows.map((p) => (
                <React.Fragment key={p.pid}>
                  <tr onClick={() => setOpen(open === p.pid ? null : p.pid)} className={open === p.pid ? 'open' : ''}>
                    <td className="num muted">{p.pid}</td>
                    <td className="fl-pname" title={p.cmd}>{p.name}<span className="muted hide-narrow"> {p.cmd.startsWith(p.name) ? p.cmd.slice(p.name.length) : ''}</span></td>
                    <td className="muted hide-narrow">{p.user}</td>
                    <td className="num"><span className={`fl-pcpu ${heat(Math.min(100, p.cpu))}`}>{p.cpu.toFixed(1)}</span></td>
                    <td className="num">{bytes(p.mem)}</td>
                  </tr>
                  {open === p.pid && (
                    <tr className="fl-pcmd"><td colSpan={5}><code>{p.cmd}</code><div className="muted">pid {p.pid} · parent {p.ppid} · {p.user}{p.threads ? ` · ${p.threads} threads` : ''} · {p.memPct}% of memory</div></td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
          <div className="muted fl-small">Top {procs.length} by CPU. CPU% is of one core, as top shows it.</div>
        </div>
      )}
    </Panel>
  )
}

function DeviceAdmin({ d, onBack, onChanged }: { d: FleetDeviceDetail; onBack: () => void; onChanged: () => void }) {
  const [name, setName] = useState(d.name)
  const save = async (patch: Parameters<typeof setFleetDevice>[1]) => {
    try { await setFleetDevice(d.id, patch); onChanged() } catch (e: any) { pushToast(e.message) }
  }
  const forget = async () => {
    if (!window.confirm(`Forget ${d.name} and its history? If its agent is still running it will reappear.`)) return
    try { await forgetFleetDevice(d.id); onChanged(); onBack() } catch (e: any) { pushToast(e.message) }
  }
  return (
    <section className="card dev-card fl-admin">
      <div className="fl-form">
        <label>Name
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== d.name && save({ name })} />
        </label>
      </div>
      <div className="fl-admin-actions">
        <span className="muted fl-small">{d.hostname} · {d.local ? 'this machine, read by Totem' : 'reports with the agent'}</span>
        <span>
          <button className="btn compact" onClick={() => save({ hidden: !d.hidden })}>{d.hidden ? 'Show on Fleet' : 'Hide'}</button>{' '}
          {!d.local && <button className="btn compact" onClick={forget}>Forget</button>}
        </span>
      </div>
    </section>
  )
}

