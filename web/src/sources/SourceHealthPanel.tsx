import React, { useCallback, useEffect, useRef, useState } from 'react'
import { plainError } from './plainError'
import { Hi, ArrowPathIcon, ChevronDownIcon, FlagIcon } from '../icons'
import { AuthError } from '../api'
import {
  getSourceHealth, getSourceRuns, since, sortSources, sourceSummary, waitingLabel,
  type SourceHealth, type SourceHealthPayload, type SourceRun,
} from './health'

// Settings → Connections › Data sources: is each data source actually working?
// Built from the bridge's run log. Only what is wrong gets a full row; what works
// and what was never set up fold into a count each. docs/source-health.md.

const STATE_LABEL = { ok: 'OK', degraded: 'Erroring', failing: 'Failing', unconfigured: 'Not set up', unknown: 'Not read' }
const CHIP = { ok: 'on', degraded: 'warn', failing: 'bad', unconfigured: '', unknown: '' }

/** One source's newest runs, loaded when shown. Also used by the MCP rows (`mcp:<id>`). */
export function SourceRuns({ source, onAuthError }: { source: string; onAuthError?: () => void }) {
  const [runs, setRuns] = useState<SourceRun[] | null>(null)
  useEffect(() => {
    let alive = true
    getSourceRuns(source).then((r) => { if (alive) setRuns(r.runs) }).catch((e) => {
      if (e instanceof AuthError) onAuthError?.()
      if (alive) setRuns([])
    })
    return () => { alive = false }
  }, [source, onAuthError])
  if (runs === null) return <p className="app-row-loading">Loading recent checks…</p>
  if (!runs.length) return <p className="app-row-hint">No checks in the log yet.</p>
  return (
    <ol className="source-runs" aria-label="Recent checks">
      {runs.map((r, i) => (
        <li key={`${r.finishedAt}-${i}`} className={r.ok ? 'ok' : 'bad'}>
          <span className={`source-dot ${r.ok ? 'ok' : 'failing'}`} aria-hidden />
          <time dateTime={r.finishedAt} title={new Date(r.finishedAt).toLocaleString()}>{since(r.finishedAt)}</time>
          {/* The plain reading; the raw text is under the row's Details. */}
          <span>{r.ok ? (r.rows != null ? `${r.rows} rows` : 'OK') : plainError(r.error)}</span>
        </li>
      ))}
    </ol>
  )
}

function SourceRow({ source, compact, onAuthError }: { source: SourceHealth; compact?: boolean; onAuthError?: () => void }) {
  const [open, setOpen] = useState(false)
  const problem = source.state === 'failing' || source.state === 'degraded'
  return (
    <section className={`app-row source-row ${compact ? 'compact' : ''} ${open ? 'open' : ''}`}>
      <button className="app-row-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`source-dot ${source.state}`} role="img" aria-label={STATE_LABEL[source.state]} />
        <span className="app-row-title">
          <strong>{source.label}</strong>
          <span>{sourceSummary(source)}</span>
        </span>
        {!compact && (
          <span className="app-row-status">
            <span className={`app-row-chip ${CHIP[source.state]}`}>{STATE_LABEL[source.state]}</span>
          </span>
        )}
        <Hi icon={ChevronDownIcon} size={16} className={`app-row-caret ${open ? 'up' : ''}`} />
      </button>
      {!open && problem && (source.error || source.goals.length > 0) && (
        <div className="source-detail">
          {source.error && <p className="source-error plain">{plainError(source.error)}</p>}
          {source.goals.map((g) => (
            <span key={g.id} className="source-goal-tag"><Hi icon={FlagIcon} size={11} /> {g.title}</span>
          ))}
        </div>
      )}
      {open && (
        <div className="app-row-body">
          {source.error && (
            <>
              <p className="source-error plain in-body">{plainError(source.error)}</p>
              <details className="source-error-raw">
                <summary>Details</summary>
                <p className="source-error in-body">{source.error}</p>
              </details>
            </>
          )}
          {source.goals.length > 0 && (
            <p className="app-row-hint">Feeds {source.goals.map((g) => g.title).join(', ')}.</p>
          )}
          {source.via && <p className="app-row-hint">{source.label} is {source.via}.</p>}
          <SourceRuns source={source.source} onAuthError={onAuthError} />
        </div>
      )}
    </section>
  )
}

/** A collapsed group of sources: one row with a count, opening onto compact rows. */
function SourceFold({ tone, label, sources, onAuthError }: { tone: string; label: string; sources: SourceHealth[]; onAuthError?: () => void }) {
  const [open, setOpen] = useState(false)
  if (!sources.length) return null
  return (
    <section className={`app-row source-fold ${open ? 'open' : ''}`}>
      <button className="app-row-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`source-dot ${tone}`} aria-hidden />
        <span className="app-row-title">
          <strong>{label}</strong>
          <span className="source-fold-names">{sources.map((s) => s.label).join(', ')}</span>
        </span>
        <Hi icon={ChevronDownIcon} size={16} className={`app-row-caret ${open ? 'up' : ''}`} />
      </button>
      {open && (
        <div className="source-fold-list">
          {sources.map((s) => <SourceRow key={s.source} source={s} compact onAuthError={onAuthError} />)}
        </div>
      )}
    </section>
  )
}

interface SourceHealthPanelProps {
  onAuthError?: () => void
  /** Leave these sources out (the web's MCP section shows MCP servers itself). */
  exclude?: (s: SourceHealth) => boolean
  /** Told each time the payload loads (null when it could not be read), so the page can summarise it. */
  onLoad?: (data: SourceHealthPayload | null) => void
  /** Changing it checks again, keeping what is shown until the answer arrives. */
  reloadKey?: number
}

export default function SourceHealthPanel({ onAuthError, exclude, onLoad, reloadKey = 0 }: SourceHealthPanelProps) {
  const [data, setData] = useState<SourceHealthPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const shown = useRef(false)  // a result is on screen, so a failed refresh keeps it

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await getSourceHealth()
      setData(next)
      shown.current = true
      setFailed(false)
      onLoad?.(next)
    } catch (e) {
      if (e instanceof AuthError) onAuthError?.()
      else {
        setFailed(true)
        // The page keeps summarising the result still shown; only a first load that
        // fails tells it the log could not be read.
        if (!shown.current) onLoad?.(null)
      }
    }
    finally { setLoading(false) }
  }, [onAuthError, onLoad])

  useEffect(() => { load() }, [load, reloadKey])

  const head = (meta: React.ReactNode) => (
    <div className="conn-section-head">
      <h2>Data sources</h2>
      <span className="conn-section-meta">{meta}</span>
      <div className="conn-section-actions">
        <button className="icon-btn small" onClick={load} disabled={loading} title="Check source health again" aria-label="Refresh data sources">
          <Hi icon={ArrowPathIcon} size={14} className={loading ? 'spin' : ''} />
        </button>
      </div>
    </div>
  )

  if (data?.disabled) {
    return (
      <section className="conn-section source-health" id="conn-sources">
        {head('Off')}
        <p className="conn-section-note">Source health is off until Totem restarts: {data.disabled}</p>
      </section>
    )
  }
  if (failed && !data) {
    return (
      <section className="conn-section source-health" id="conn-sources">
        {head('Could not be checked')}
        <p className="conn-section-note">Totem could not read its source log. Try again with the refresh button.</p>
      </section>
    )
  }
  const { problems, waiting, healthy } = sortSources(data, { exclude })
  if (!data || (!problems.length && !waiting.length && !healthy.length)) return null
  const failing = problems.filter((s) => s.state === 'failing').length
  const erroring = problems.length - failing
  // The rows say how many work; the head only counts what is wrong, or that the
  // last check failed and these rows are from the one before.
  const meta = failed
    ? <span className="warn">Last check failed · showing the previous result</span>
    : [failing ? `${failing} failing` : '', erroring ? `${erroring} erroring` : ''].filter(Boolean).join(' · ')

  return (
    <section className="conn-section source-health" id="conn-sources">
      {head(meta)}
      <div className="conn-list">
        {problems.map((s) => <SourceRow key={s.source} source={s} onAuthError={onAuthError} />)}
        <SourceFold tone="ok" label={problems.length ? `${healthy.length} working` : `All ${healthy.length} working`} sources={healthy} onAuthError={onAuthError} />
        <SourceFold tone="unknown" label={waitingLabel(waiting)} sources={waiting} onAuthError={onAuthError} />
      </div>
    </section>
  )
}
