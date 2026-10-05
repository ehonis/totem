import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Hi, ShieldCheckIcon, ShieldExclamationIcon, CommandLineIcon, ArrowPathIcon,
  CheckCircleIcon, XMarkIcon, ExclamationTriangleIcon, ChevronRightIcon, ChevronDownIcon,
  ClockIcon, DocumentTextIcon, BoltIcon, StopSolidIcon, SparklesIcon,
} from '../icons'
import {
  getActionLogs, getActionLogSummary, getOutputs, getOutput,
  getApprovals, approveApprovalSession, denyApprovalSession, revokeApprovalSession,
  getRuns, getRun, stopRun, AuthError,
} from '../api'
import { pushSuccess, pushError } from '../toast'
import { partitionApprovalLeases } from './approvalLeases'

// Logs — what Totem is doing, what it did, and who asked it to.
//
// Four panels, ordered by how urgently you need them:
//
//   1. APPROVALS. When ChatGPT wants to accept an inbox item it cannot just do
//      it: it has to request permission, and the request lands here with the
//      explanation it wrote. This panel is the only place that decision gets
//      made, so it sits at the top and shouts when something is waiting.
//   2. NOW RUNNING. Live commands and agent runs, tailed as they go — an agent's
//      tool calls and the prose it is generating, a command's stdout line by
//      line — with a stop button. Recently finished runs stay here for half an
//      hour, because "what did that just print" is the most common question.
//   3. ACTIVITY. Every mutation Totem performs, with actor, outcome and reason.
//      This is the file you read when a command ran at 2am.
//   4. OUTPUTS. The durable transcript of finished runs, after they age out of
//      the live registry.
//
// Panel 2 polls on a `since` cursor rather than using SSE: a tail that survives a
// page refresh, a dropped connection and a proxy timeout with no reconnect logic.
// The Usage tab counts activity; this explains it.

const REFRESH_MS = 15_000

const ACTION_FILTERS = [
  { id: '', label: 'Everything' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'command', label: 'Commands' },
  { id: 'approval', label: 'Approvals' },
  { id: 'task', label: 'Tasks' },
  { id: 'event', label: 'Calendar' },
  { id: 'note', label: 'Notes' },
  { id: 'habit', label: 'Habits' },
  { id: 'connection', label: 'Connections' },
]

const STATUS_FILTERS = [
  { id: '', label: 'Any result' },
  { id: 'ok', label: 'Worked' },
  { id: 'error', label: 'Failed' },
  { id: 'denied', label: 'Blocked' },
]

const WINDOWS = [
  { hours: 1, label: '1h' },
  { hours: 24, label: '24h' },
  { hours: 168, label: '7d' },
  { hours: 720, label: '30d' },
]

interface LogEntry {
  id: string
  ts: number
  iso: string
  action: string
  actor: string
  status: string
  channel?: string
  target?: string
  summary?: string
  why?: string
  detail?: string
  error?: string
  ms?: number
  correlationId?: string
}

interface Grant {
  approvalSessionId: string
  kind: string
  status: string
  explanation: string
  why: string
  requestedBy: string
  requestedAt: string
  expiresAt: string
  code: string | null
  useCount: number
  lastUsedAt?: string
  denyReason?: string
  revokeReason?: string
  legacy?: boolean
}

// ---- formatting ------------------------------------------------------------

// Entry times render in the bridge's own timezone, not the viewer's. The log and
// the Jobs tab show the same job runs, so a device on another zone used to place
// one run at two different clock times depending on which tab you were reading.
function clockTime(iso: string, tz?: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: tz })
}

function agoText(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Minutes until a grant expires; negative once it has. */
function minutesLeft(iso: string): number {
  return Math.round((new Date(iso).getTime() - Date.now()) / 60000)
}

const STATUS_TONE: Record<string, string> = {
  ok: 'log-ok', error: 'log-error', denied: 'log-denied', skipped: 'log-skipped',
}

// An actor is either the owner or something acting on his behalf. Worth a visual
// difference: "chatgpt wrote a note" deserves more attention than "ethan did".
const ACTOR_TONE: Record<string, string> = {
  ethan: 'actor-human', chatgpt: 'actor-ai', claude: 'actor-ai', cursor: 'actor-ai',
  agent: 'actor-ai', job: 'actor-system', system: 'actor-system', unknown: 'actor-system',
}

function prettyDetail(detail?: string): string | null {
  if (!detail) return null
  try { return JSON.stringify(JSON.parse(detail), null, 2) } catch { return detail }
}

// ---- approvals -------------------------------------------------------------

function ApprovalCard({ grant, onDecide }: { grant: Grant; onDecide: () => void }) {
  const active = grant.status === 'approved'
  const [busy, setBusy] = useState<'' | 'approve' | 'deny' | 'revoke'>('')
  const left = minutesLeft(grant.expiresAt)

  const decide = async (kind: 'approve' | 'deny' | 'revoke') => {
    setBusy(kind)
    try {
      if (kind === 'approve') await approveApprovalSession(grant.approvalSessionId)
      else if (kind === 'deny') await denyApprovalSession(grant.approvalSessionId, 'denied from the dashboard')
      else await revokeApprovalSession(grant.approvalSessionId, 'revoked from the dashboard')
      pushSuccess(kind === 'approve'
        ? `Approved ${grant.requestedBy}'s working session`
        : kind === 'revoke' ? 'Approval session revoked' : 'Approval session denied')
      onDecide()
    } catch (e: any) {
      pushError(e?.message || 'could not record that decision')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className={`approval-card${active ? ' active' : ''}`}>
      <div className="approval-head">
        <Hi icon={active ? ShieldCheckIcon : ShieldExclamationIcon} size={16} className="approval-icon" />
        <div className="approval-who">
          <strong>{grant.requestedBy}</strong> {active ? 'has an active working session' : 'requests a working session'}
          <span className="approval-kind">session</span>
        </div>
        <span className={`approval-ttl${left <= 3 ? ' urgent' : ''}`}>
          <Hi icon={ClockIcon} size={12} /> {left > 0 ? `${left}m left` : 'expired'}
        </span>
      </div>

      {/* The explanation IS the decision. Nothing here is approvable without it,
          so it is rendered as the primary content rather than as metadata. */}
      <div className="approval-body">
        <div className="approval-field">
          <span className="approval-label">What it does</span>
          <p>{grant.explanation}</p>
        </div>
        <div className="approval-field">
          <span className="approval-label">Why</span>
          <p>{grant.why}</p>
        </div>
      </div>

      <div className="approval-actions">
        {active ? (
          <>
            <span className="approval-usage">
              {grant.useCount.toLocaleString()} {grant.useCount === 1 ? 'action' : 'actions'}
              {grant.lastUsedAt ? `, last used ${agoText(grant.lastUsedAt)}` : ', not used yet'}
            </span>
            <button className="btn compact" disabled={!!busy} onClick={() => decide('revoke')}>
              <Hi icon={XMarkIcon} size={14} /> {busy === 'revoke' ? 'Revoking…' : 'Revoke'}
            </button>
          </>
        ) : (
          <>
            <button className="btn compact primary" disabled={!!busy || left <= 0} onClick={() => decide('approve')}>
              <Hi icon={CheckCircleIcon} size={14} /> {busy === 'approve' ? 'Approving…' : 'Approve'}
            </button>
            <button className="btn compact" disabled={!!busy} onClick={() => decide('deny')}>
              <Hi icon={XMarkIcon} size={14} /> {busy === 'deny' ? 'Denying…' : 'Deny'}
            </button>
          </>
        )}
        {/* The code exists so approval works when he is nowhere near a browser:
            he reads it to the model and the model passes it back. */}
        {!active && grant.code && (
          <span className="approval-code" title="Read this to the assistant if you are not at a dashboard">
            code <strong>{grant.code}</strong>
          </span>
        )}
      </div>
    </div>
  )
}

// ---- outputs ---------------------------------------------------------------

function OutputRow({ row, onOpen, open, body }: any) {
  return (
    <div className={`output-row${open ? ' open' : ''}`}>
      <button className="output-head" onClick={onOpen}>
        <Hi icon={open ? ChevronDownIcon : ChevronRightIcon} size={14} />
        <code className="output-cmd">{row.label || row.id}</code>
        <span className={`output-exit ${row.ok ? 'log-ok' : 'log-error'}`}>
          exit {row.exitCode ?? '—'}
        </span>
        <span className="output-meta">{row.ms != null ? `${row.ms}ms` : ''}</span>
        <span className="output-meta">{row.finishedAt ? agoText(row.finishedAt) : ''}</span>
      </button>
      {open && (
        <div className="output-body">
          {!body ? <p className="muted">Loading…</p> : (
            <>
              <div className="output-facts">
                <span><strong>id</strong> {body.id}</span>
                <span><strong>cwd</strong> {body.cwd}</span>
                {body.timedOut && <span className="log-error"><strong>timed out</strong></span>}
              </div>
              {body.stdout ? <><span className="approval-label">stdout</span><pre className="output-pre">{body.stdout}</pre></> : null}
              {body.stderr ? <><span className="approval-label">stderr</span><pre className="output-pre stderr">{body.stderr}</pre></> : null}
              {!body.stdout && !body.stderr && <p className="muted">No output.</p>}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ---- live runs -------------------------------------------------------------

// Agent output arrives as three interleaved kinds and they mean different things,
// so they are not rendered as one flat blob: `activity`/`tool` is what it DID,
// `text` is what it is SAYING. Commands only ever emit stdout/stderr.
const STREAM_CLASS: Record<string, string> = {
  stdout: 'chunk-stdout',
  stderr: 'chunk-stderr',
  activity: 'chunk-activity',
  tool: 'chunk-tool',
  text: 'chunk-text',
  system: 'chunk-system',
}

function elapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function RunPanel({ run, onChanged }: { run: any; onChanged: () => void }) {
  const [open, setOpen] = useState(run.status === 'running')
  const [chunks, setChunks] = useState<any[]>([])
  const [stopping, setStopping] = useState(false)
  const [live, setLive] = useState(run)
  const tailRef = React.useRef<HTMLPreElement | null>(null)
  // The cursor is a ref, NOT state. As state it belongs in the effect's dep array,
  // and then every poll that returned output would tear the effect down and
  // immediately re-run it — a tight request loop precisely while output is
  // streaming. Same reasoning for onChanged, which is a fresh closure per render.
  const sinceRef = React.useRef(0)
  const onChangedRef = React.useRef(onChanged)
  onChangedRef.current = onChanged

  // Poll only while this panel is open, and only while the run is live. A closed
  // panel costs nothing; a finished run is already complete.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    let timer: any

    const tick = async () => {
      try {
        const d = await getRun(run.id, sinceRef.current)
        if (cancelled) return
        if (d.chunks?.length) {
          sinceRef.current = d.lastSeq
          setChunks((prev) => [...prev, ...d.chunks])
        }
        setLive(d)
        if (d.status === 'running') timer = setTimeout(tick, 1500)
        else onChangedRef.current()   // finished: refresh the list so the status settles
      } catch {
        // A run that aged out of the registry stops polling rather than hammering
        // a 404 — its durable copy is in the Outputs panel below.
        if (!cancelled) setLive((p: any) => ({ ...p, status: p.status === 'running' ? 'gone' : p.status }))
      }
    }
    tick()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [open, run.id])

  // Follow the tail, the way `tail -f` does.
  useEffect(() => {
    if (open && tailRef.current) tailRef.current.scrollTop = tailRef.current.scrollHeight
  }, [chunks, open])

  const doStop = async () => {
    setStopping(true)
    try {
      await stopRun(run.id)
      pushSuccess(`Stopping ${run.id}`)
    } catch (e: any) {
      pushError(e?.message || 'could not stop that run')
    } finally {
      setStopping(false)
      onChanged()
    }
  }

  const running = live.status === 'running'
  return (
    <div className={`run-row${running ? ' running' : ''}`}>
      <div className="run-head">
        <button className="run-toggle" onClick={() => setOpen((o) => !o)}>
          <Hi icon={open ? ChevronDownIcon : ChevronRightIcon} size={14} />
          <Hi icon={run.kind === 'agent' ? SparklesIcon : CommandLineIcon} size={13} className="run-kind" />
          <code className="run-label">{run.label || run.id}</code>
        </button>
        <span className="run-meta">{run.id}</span>
        {run.provider && <span className="run-meta">{run.provider}{run.model ? `/${run.model}` : ''}</span>}
        <span className="run-meta">{run.actor}</span>
        {running
          ? <span className="run-live"><span className="run-dot" /> {elapsed(live.ms)}</span>
          : <span className={`run-exit ${live.status === 'ok' ? 'log-ok' : 'log-error'}`}>
              {live.status === 'ok' ? 'done' : live.error || live.status}
              {live.exitCode != null ? ` · exit ${live.exitCode}` : ''} · {elapsed(live.ms)}
            </span>}
        {running && live.canStop && (
          <button className="btn compact danger run-stop" disabled={stopping} onClick={doStop} title="Send SIGTERM, then SIGKILL">
            <Hi icon={StopSolidIcon} size={12} /> {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>
      {open && (
        <div className="run-body">
          {live.truncated && <p className="muted run-trunc">Earlier output dropped — showing the most recent {Math.round(256)}KB.</p>}
          {chunks.length === 0 ? (
            <p className="muted">{running ? 'Waiting for output…' : 'No output.'}</p>
          ) : (
            <pre className="run-tail" ref={tailRef}>
              {chunks.map((c) => (
                <span key={c.seq} className={STREAM_CLASS[c.stream] || ''}>
                  {c.stream === 'activity' || c.stream === 'tool' ? `▸ ${c.text}` : c.text}
                </span>
              ))}
              {running && <span className="run-cursor">▋</span>}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

// ---- the view --------------------------------------------------------------

export default function LogsView({ onAuthError }: { onAuthError?: () => void }) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [summary, setSummary] = useState<any>(null)
  const [grants, setGrants] = useState<Grant[]>([])
  const [outputs, setOutputs] = useState<any[]>([])
  const [runs, setRuns] = useState<any[]>([])
  const [openOutput, setOpenOutput] = useState<string>('')
  const [outputBody, setOutputBody] = useState<any>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [action, setAction] = useState('')
  const [status, setStatus] = useState('')
  const [hours, setHours] = useState(24)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [timezone, setTimezone] = useState<string | undefined>(undefined)

  const load = useCallback(async () => {
    try {
      const [logs, sum, appr, outs, live] = await Promise.all([
        getActionLogs({ action, status, hours, limit: 200 }),
        getActionLogSummary(hours),
        getApprovals(),
        getOutputs(50),
        getRuns(),
      ])
      setEntries(logs.entries || [])
      setTimezone(logs.timezone || undefined)
      setSummary(sum)
      setGrants(appr.grants || [])
      setOutputs(outs.outputs || [])
      setRuns(live.runs || [])
      setError('')
    } catch (e: any) {
      if (e instanceof AuthError) { onAuthError?.(); return }
      setError(e?.message || 'could not load the logs')
    } finally {
      setLoading(false)
    }
  }, [action, status, hours, onAuthError])

  useEffect(() => { load() }, [load])
  // Approvals expire on a clock, so a stale page is actively misleading here.
  // While something is running, refresh faster so a new run appears promptly and
  // a finished one stops claiming it is live — the per-run tail polls separately.
  const anyRunning = useMemo(() => runs.some((r) => r.status === 'running'), [runs])
  useEffect(() => {
    const t = setInterval(load, anyRunning ? 3000 : REFRESH_MS)
    return () => clearInterval(t)
  }, [load, anyRunning])

  const openOutputRow = async (id: string) => {
    if (openOutput === id) { setOpenOutput(''); setOutputBody(null); return }
    setOpenOutput(id); setOutputBody(null)
    try { setOutputBody(await getOutput(id)) } catch (e: any) { pushError(e?.message || 'could not read that output') }
  }

  const { pending, active, decided } = useMemo(() => {
    const groups = partitionApprovalLeases(grants)
    return { ...groups, decided: groups.decided.slice(0, 8) }
  }, [grants])
  const failures = summary?.byStatus?.error || 0

  return (
    <div className="view logs-view">
      <header className="view-head">
        <div>
          <h1>Logs</h1>
          <p className="muted">
            Every action Totem takes, who asked for it, and whether it worked.
            {summary ? ` ${summary.count} in the last ${hours}h${failures ? `, ${failures} failed` : ''}.` : ''}
          </p>
        </div>
        <button className="btn compact" onClick={load} title="Refresh">
          <Hi icon={ArrowPathIcon} size={14} /> Refresh
        </button>
      </header>

      {error && <p className="error inline-warn">{error}</p>}

      {/* 1. Approvals first — something is blocked waiting on this. */}
      <section className="card">
        <div className="card-head">
          <h2><Hi icon={ShieldCheckIcon} size={15} /> Approvals</h2>
          {pending.length > 0 && <span className="pill pill-warn">{pending.length} waiting</span>}
          {active.length > 0 && <span className="pill pill-ok">{active.length} active</span>}
        </div>
        {pending.length === 0 && active.length === 0 ? (
          <p className="muted">
            No approval sessions are waiting or active. An assistant cannot activate one itself. Once
            approved, a session stays active until one hour passes without an authorized action.
          </p>
        ) : (
          <div className="approval-list">
            {pending.map((g) => <ApprovalCard key={g.approvalSessionId} grant={g} onDecide={load} />)}
            {active.map((g) => <ApprovalCard key={g.approvalSessionId} grant={g} onDecide={load} />)}
          </div>
        )}
        {decided.length > 0 && (
          <details className="decided-log">
            <summary>Recently decided ({decided.length})</summary>
            <ul>
              {decided.map((g) => (
                <li key={g.approvalSessionId}>
                  <span className="pill pill-muted">{g.status}</span>
                  <code>{g.approvalSessionId.slice(0, 8)}</code> {g.explanation}
                  {g.denyReason ? <em> - {g.denyReason}</em> : null}
                  {g.revokeReason ? <em> - {g.revokeReason}</em> : null}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* 2. What is happening right now. */}
      <section className="card">
        <div className="card-head">
          <h2><Hi icon={BoltIcon} size={15} /> Now running</h2>
          {anyRunning
            ? <span className="pill pill-warn">{runs.filter((r) => r.status === 'running').length} live</span>
            : <span className="muted">idle</span>}
        </div>
        {runs.length === 0 ? (
          <p className="muted">
            Nothing running. Commands and agent runs accepted from the inbox appear here while they
            work — an agent's tool calls and prose as it goes, a command's output line by line — and
            stay for half an hour after they finish.
          </p>
        ) : (
          <div className="run-list">
            {runs.map((r) => <RunPanel key={`${r.id}-${r.startedAt}`} run={r} onChanged={load} />)}
          </div>
        )}
      </section>

      {/* 3. Activity. */}
      <section className="card">
        <div className="card-head">
          <h2><Hi icon={DocumentTextIcon} size={15} /> Activity</h2>
          <div className="log-filters">
            {WINDOWS.map((w) => (
              <button key={w.hours} className={`chip${hours === w.hours ? ' active' : ''}`} onClick={() => setHours(w.hours)}>{w.label}</button>
            ))}
          </div>
        </div>
        <div className="log-filters">
          {ACTION_FILTERS.map((f) => (
            <button key={f.id} className={`chip${action === f.id ? ' active' : ''}`} onClick={() => setAction(f.id)}>{f.label}</button>
          ))}
        </div>
        <div className="log-filters">
          {STATUS_FILTERS.map((f) => (
            <button key={f.id} className={`chip${status === f.id ? ' active' : ''}`} onClick={() => setStatus(f.id)}>{f.label}</button>
          ))}
        </div>

        {loading ? <p className="muted">Loading…</p> : entries.length === 0 ? (
          <p className="muted">Nothing matches those filters in the last {hours}h.</p>
        ) : (
          <div className="log-list">
            {entries.map((e) => {
              const open = !!expanded[e.id]
              const detail = prettyDetail(e.detail)
              const expandable = Boolean(detail || e.error || e.why)
              return (
                <div key={e.id} className={`log-entry ${STATUS_TONE[e.status] || ''}`}>
                  <button
                    className="log-line"
                    onClick={() => expandable && setExpanded((p) => ({ ...p, [e.id]: !open }))}
                    style={expandable ? undefined : { cursor: 'default' }}
                  >
                    {expandable ? <Hi icon={open ? ChevronDownIcon : ChevronRightIcon} size={12} /> : <span className="log-gutter" />}
                    <span className="log-time">{clockTime(e.iso, timezone)}</span>
                    <span className={`log-actor ${ACTOR_TONE[e.actor] || ''}`}>{e.actor}</span>
                    <code className="log-action">{e.action}</code>
                    <span className="log-summary">{e.summary || e.target || ''}</span>
                    {e.ms != null && <span className="log-ms">{e.ms}ms</span>}
                    <span className={`pill ${e.status === 'ok' ? 'pill-ok' : e.status === 'error' ? 'pill-error' : 'pill-muted'}`}>{e.status}</span>
                  </button>
                  {open && (
                    <div className="log-detail">
                      {e.why && <p><span className="approval-label">Why</span> {e.why}</p>}
                      {e.error && <p className="log-error"><Hi icon={ExclamationTriangleIcon} size={12} /> {e.error}</p>}
                      {e.correlationId && (
                        <p className="muted">
                          chain <code>{e.correlationId}</code>
                          {' — '}
                          <button className="link" onClick={() => { setAction(''); setStatus('') }}>show all</button>
                        </p>
                      )}
                      {detail && <pre className="output-pre">{detail}</pre>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* 4. Durable outputs, after they age out of the live panel. */}
      <section className="card">
        <div className="card-head">
          <h2><Hi icon={CommandLineIcon} size={15} /> Command outputs</h2>
          <span className="muted">{outputs.length}</span>
        </div>
        {outputs.length === 0 ? (
          <p className="muted">No commands have run from the inbox yet.</p>
        ) : (
          <div className="output-list">
            {outputs.map((row) => (
              <OutputRow
                key={row.id}
                row={row}
                open={openOutput === row.id}
                body={openOutput === row.id ? outputBody : null}
                onOpen={() => openOutputRow(row.id)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
