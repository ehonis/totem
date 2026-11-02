import React, { useCallback, useEffect, useState } from 'react'
import { Hi, ArrowPathIcon, ChevronDownIcon, FlagIcon } from '../icons'
import { AuthError } from '../api'
import {
  getSourceHealth, getSourceRuns, groupSources, since, sourceSummary,
  type SourceHealth, type SourceHealthPayload, type SourceRun,
} from './health'

// Settings → Connections › Source health: is each data source actually working?
// Built from the bridge's run log (one row per connector call), grouped under the
// goals each source feeds. docs/source-health.md.

const STATE_LABEL = { ok: 'OK', degraded: 'Erroring', failing: 'Failing', unconfigured: 'Not set up', unknown: 'Not read' }

function SourceRow({ source, onAuthError }: { source: SourceHealth; onAuthError?: () => void }) {
  const [open, setOpen] = useState(false)
  const [runs, setRuns] = useState<SourceRun[] | null>(null)

  useEffect(() => {
    if (!open || runs) return
    getSourceRuns(source.source).then((r) => setRuns(r.runs)).catch((e) => {
      if (e instanceof AuthError) onAuthError?.()
      setRuns([])
    })
  }, [open, runs, source.source, onAuthError])

  return (
    <section className={`app-row source-row ${open ? 'open' : ''}`}>
      <button className="app-row-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`source-dot ${source.state}`} role="img" aria-label={STATE_LABEL[source.state]} />
        <span className="app-row-title">
          <strong>{source.label}</strong>
          <span>{sourceSummary(source)}</span>
        </span>
        <span className="app-row-status">
          <span className={`app-row-chip ${source.state === 'ok' ? 'on' : source.state === 'failing' ? 'bad' : source.state === 'degraded' ? 'warn' : ''}`}>
            {STATE_LABEL[source.state]}
          </span>
        </span>
        <Hi icon={ChevronDownIcon} size={16} className={`app-row-caret ${open ? 'up' : ''}`} />
      </button>
      {!open && (source.state === 'failing' || source.state === 'degraded') && source.error && <p className="source-error">{source.error}</p>}
      {open && (
        <div className="app-row-body">
          {source.error && <p className="source-error in-body">{source.error}</p>}
          {source.via && <p className="app-row-hint">{source.label} is {source.via}.</p>}
          {runs === null ? <p className="app-row-loading">Loading runs…</p> : runs.length === 0 ? (
            <p className="app-row-hint">No runs in the log.</p>
          ) : (
            <ol className="source-runs">
              {runs.map((r, i) => (
                <li key={`${r.finishedAt}-${i}`} className={r.ok ? 'ok' : 'bad'}>
                  <span className={`source-dot ${r.ok ? 'ok' : 'failing'}`} aria-hidden />
                  <time dateTime={r.finishedAt} title={new Date(r.finishedAt).toLocaleString()}>{since(r.finishedAt)}</time>
                  <span>{r.ok ? (r.rows != null ? `${r.rows} rows` : 'OK') : r.error}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  )
}

export default function SourceHealthPanel({ onAuthError }: { onAuthError?: () => void }) {
  const [data, setData] = useState<SourceHealthPayload | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try { setData(await getSourceHealth()) }
    catch (e) { if (e instanceof AuthError) onAuthError?.() }
    finally { setLoading(false) }
  }, [onAuthError])

  useEffect(() => { load() }, [load])

  const { goals, other } = groupSources(data)
  if (data?.disabled) {
    return (
      <div className="app-group source-health">
        <div className="settings-section-title"><span /><strong>Source health</strong></div>
        <p className="app-row-hint">Source health is off until Totem restarts: {data.disabled}</p>
      </div>
    )
  }
  if (!data || (!goals.length && !other.length)) return null
  const failing = data.sources.filter((s) => s.state === 'failing').length

  return (
    <div className="app-group source-health">
      <div className="settings-section-title"><span /><strong>Source health</strong></div>
      <div className="claude-tools-head">
        <p className="app-row-hint">
          Every read Totem makes from a connected source, and whether it worked.
          {failing ? ` ${failing} ${failing === 1 ? 'source is' : 'sources are'} failing.` : ' Nothing is failing.'}
        </p>
        <button className="icon-btn small" onClick={load} disabled={loading} title="Refresh source health">
          <Hi icon={ArrowPathIcon} size={16} />
        </button>
      </div>
      {goals.map(({ goal, sources }) => (
        <div className="source-goal" key={goal.id}>
          <div className={`source-goal-title ${goal.failing.length ? 'failing' : ''}`}>
            <Hi icon={FlagIcon} size={13} />
            <span>{goal.title}</span>
          </div>
          <div className="app-list">
            {sources.map((s) => <SourceRow key={`${goal.id}-${s.source}`} source={s} onAuthError={onAuthError} />)}
          </div>
        </div>
      ))}
      {other.length > 0 && (
        <div className="source-goal">
          {goals.length > 0 && <div className="source-goal-title"><span>Other sources</span></div>}
          <div className="app-list">
            {other.map((s) => <SourceRow key={s.source} source={s} onAuthError={onAuthError} />)}
          </div>
        </div>
      )}
    </div>
  )
}
