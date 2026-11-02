import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { AuthError, decideRec, getRecLedger, setRecOutcome } from '../api'
import { ArrowUturnLeftIcon, CheckIcon, ClockIcon, Hi, XMarkIcon } from '../icons'
import { DEFER_CHOICES, OUTCOME_LABELS, formatUsd, mergeLedger, outcomeLabel, recSections, recSourceLabel, recSourcePath } from '../recs/sections'
import type { Rec, RecDecision, RecOutcome, RecStats } from '../recs/types'

// Productivity → Recommendations: the ledger of what agents advised, with the
// owner's decision and how it turned out. Agents record and measure; deciding
// happens only here (and in the app), which is why these buttons exist at all.
// Everything still open always loads; decided history comes a page at a time.
export default function RecsView({ onAuthError }: { onAuthError: () => void }) {
  const [open, setOpen] = useState<Rec[]>([])
  const [history, setHistory] = useState<Rec[]>([])
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [stats, setStats] = useState<RecStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const fail = useCallback((cause: unknown, fallback: string) => {
    if (cause instanceof AuthError) onAuthError()
    else setError(cause instanceof Error ? cause.message : fallback)
  }, [onAuthError])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const ledger = await getRecLedger()
      setOpen(ledger.open); setHistory(ledger.history); setNextBefore(ledger.nextBefore); setStats(ledger.stats)
    } catch (cause) { fail(cause, 'Recommendations could not load.') }
    finally { setLoading(false) }
  }, [fail])

  useEffect(() => { void load() }, [load])

  async function more() {
    if (!nextBefore) return
    setBusy('more'); setError('')
    try {
      const ledger = await getRecLedger(nextBefore)
      setHistory((current) => [...current, ...ledger.history]); setNextBefore(ledger.nextBefore); setStats(ledger.stats)
    } catch (cause) { fail(cause, 'Older recommendations could not load.') }
    finally { setBusy('') }
  }

  // A change refetches the first page (open recs and the stats line move with it) and
  // keeps the older pages already loaded (mergeLedger).
  const run = useCallback(async (id: string, change: () => Promise<{ rec: Rec }>) => {
    setBusy(id); setError('')
    try {
      const { rec } = await change()
      const first = await getRecLedger()
      const next = mergeLedger({ history, nextBefore }, first, rec)
      setOpen(next.open); setHistory(next.history); setNextBefore(next.nextBefore); setStats(first.stats)
    }
    catch (cause) { fail(cause, 'That change could not be saved.') }
    finally { setBusy('') }
  }, [fail, history, nextBefore])

  const sections = useMemo(() => recSections([...open, ...history]), [open, history])

  return (
    <div className="recs-view">
      <header className="recs-head">
        <h2>Recommendations</h2>
        {stats && <p className="recs-line tnum">{stats.line}</p>}
      </header>
      {error && <div className="lists-error recs-error" role="alert"><span>{error}</span><button className="link-btn" onClick={() => void load()}>Retry</button></div>}
      {!loading && !sections.length && (
        <div className="lists-empty recs-empty">
          <Hi icon={CheckIcon} size={26} />
          <h2>Nothing recommended yet</h2>
          <p>When an agent suggests something worth deciding, it lands here with its evidence.</p>
        </div>
      )}
      {sections.map((section) => (
        <section className="recs-section" key={section.id} aria-labelledby={`recs-${section.id}`}>
          <div className="lists-todos-head"><h3 id={`recs-${section.id}`}>{section.title}</h3><span>{section.recs.length}</span></div>
          {section.recs.map((rec) => (
            <RecCard
              key={rec.id}
              rec={rec}
              busy={busy === rec.id}
              onDecide={(decision, extra) => run(rec.id, () => decideRec(rec.id, { decision, ...extra }))}
              onOutcome={(outcome) => run(rec.id, () => setRecOutcome(rec.id, { outcome }))}
            />
          ))}
        </section>
      ))}
      {nextBefore && (
        <div className="recs-more">
          <button className="btn compact" disabled={busy === 'more'} onClick={() => void more()}>Show older decisions</button>
        </div>
      )}
    </div>
  )
}

interface CardProps {
  rec: Rec
  busy: boolean
  onDecide: (decision: RecDecision, extra?: { note?: string; deferDays?: number }) => void
  onOutcome: (outcome: RecOutcome) => void
}

function RecCard({ rec, busy, onDecide, onOutcome }: CardProps) {
  const [deferring, setDeferring] = useState(false)
  const [deferDays, setDeferDays] = useState(DEFER_CHOICES[0].days)
  const [note, setNote] = useState('')
  const sourcePath = recSourcePath(rec.source)
  const meta = [
    sourcePath ? <a key="s" href={sourcePath}>{recSourceLabel(rec.source)}</a> : <span key="s">{recSourceLabel(rec.source)}</span>,
    rec.costUsd ? <span key="c">{formatUsd(rec.costUsd)}</span> : null,
    rec.actBy ? <span key="a">act by {rec.actBy}</span> : null,
    rec.decision === 'deferred' && rec.reviewOn ? <span key="r">back {rec.reviewOn}</span> : null,
    rec.decision === 'pending' && rec.resurfacedAt ? <span key="b">back from deferral</span> : null,
  ].filter(Boolean)

  return (
    <article className={`recs-card ${rec.decision}`}>
      <div className="recs-card-top">
        <h4>{rec.title}</h4>
        {rec.decision !== 'pending' && <span className={`recs-badge ${rec.outcome ?? rec.decision}`}>{rec.outcome ? OUTCOME_LABELS[rec.outcome] : rec.decision}</span>}
      </div>
      <div className="recs-meta">{meta}</div>
      {rec.body && <p className="recs-body">{rec.body}</p>}
      {rec.changedNote && <p className="recs-note">What changed since you declined something like it: {rec.changedNote}</p>}
      {rec.evidence && <details className="recs-evidence"><summary>Evidence</summary><p>{rec.evidence}</p></details>}
      {rec.decisionNote && <p className="recs-note">“{rec.decisionNote}”</p>}
      {rec.outcome && rec.outcomeBy === 'agent' && <p className="recs-note">{outcomeLabel(rec)}</p>}
      {rec.outcomeNote && <p className="recs-note">{rec.outcomeNote}</p>}

      {rec.decision === 'pending' && !deferring && (
        <div className="recs-actions">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label={`Note on ${rec.title}`} />
          <button className="btn compact primary" disabled={busy} onClick={() => onDecide('accepted', { note })}><Hi icon={CheckIcon} size={14} /> Accept</button>
          <button className="btn compact" disabled={busy} onClick={() => onDecide('declined', { note })}><Hi icon={XMarkIcon} size={14} /> Decline</button>
          <button className="btn compact" disabled={busy} onClick={() => setDeferring(true)}><Hi icon={ClockIcon} size={14} /> Defer</button>
        </div>
      )}
      {rec.decision === 'pending' && deferring && (
        <form className="recs-actions" onSubmit={(e) => { e.preventDefault(); onDecide('deferred', { note, deferDays }) }}>
          <label>Ask again
            <select value={deferDays} onChange={(e) => setDeferDays(Number(e.target.value))}>
              {DEFER_CHOICES.map((choice) => <option key={choice.days} value={choice.days}>{choice.label.toLowerCase()}</option>)}
            </select>
          </label>
          <button className="btn compact primary" disabled={busy}>Defer</button>
          <button type="button" className="btn compact" onClick={() => setDeferring(false)}>Cancel</button>
        </form>
      )}
      {rec.decision === 'accepted' && (
        <div className="recs-actions">
          <span className="recs-ask">{rec.outcome ? 'Outcome' : 'How did it go?'}</span>
          {(Object.keys(OUTCOME_LABELS) as RecOutcome[]).map((outcome) => (
            <button key={outcome} className={`btn compact${rec.outcome === outcome && rec.outcomeBy === 'owner' ? ' primary' : ''}`} disabled={busy} onClick={() => onOutcome(outcome)}>
              {OUTCOME_LABELS[outcome]}
            </button>
          ))}
        </div>
      )}
      {rec.decision !== 'pending' && (
        <button className="link-btn recs-reopen" disabled={busy} onClick={() => onDecide('pending')}>
          <Hi icon={ArrowUturnLeftIcon} size={13} /> Decide again
        </button>
      )}
    </article>
  )
}
