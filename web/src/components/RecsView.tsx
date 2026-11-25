// Productivity → Recs: the ledger of what agents advised, with the owner's decision and
// how it turned out, drawn as the iPhone app draws it (mobile/src/features/productivity/RecsView.tsx):
// the track record as three numbers and its line, what waits on the owner as full cards
// with the decision buttons, and everything already decided as compact rows that open
// in place. Agents record and measure; deciding happens only here (and in the app),
// which is why these buttons exist at all. Everything still open always loads; decided
// history comes a page at a time.
//
// Accept is one click ("Accept with a note…" is in the card's "…"); Decline asks why
// (optional, agents read it before suggesting something like it again) and Cancel there
// decides nothing; Defer picks its length from a menu ("Defer with a note…" is in "…").
// Each decision moves the card at once and its toast offers Undo, the same "Decide again".
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AuthError, decideRec, getRecLedger, setRecOutcome } from '../api'
import {
  ArrowUturnLeftIcon, ChatBubbleLeftIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, ClockIcon,
  EllipsisHorizontalIcon, ExclamationTriangleIcon, Hi, PencilSquareIcon,
} from '../icons'
import { DEFER_CHOICES, OUTCOME_LABELS, mergeLedger, outcomeLabel, recSections, recSourceLabel, recSourcePath } from '../recs/sections'
import { decisionToast, recMeta, statTiles, whenLabel } from '../recs/card'
import type { Rec, RecDecision, RecOutcome, RecStats } from '../recs/types'
import { pushToast } from '../toast'
import { followLink } from '../links'
import Menu, { type MenuEntry } from '../todos/Menu'
import IconBulb from '@tabler/icons-react/dist/esm/icons/IconBulb.mjs'
import '../recs/recs.css'

type Extra = { note?: string; deferDays?: number }
type Decide = (rec: Rec, decision: RecDecision, extra?: Extra) => void
type Outcome = (rec: Rec, outcome: RecOutcome) => void

export default function RecsView({ onAuthError }: { onAuthError: () => void }) {
  const [open, setOpen] = useState<Rec[]>([])
  const [history, setHistory] = useState<Rec[]>([])
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [stats, setStats] = useState<RecStats | null>(null)
  const [loading, setLoading] = useState(true)
  // What is saving, counted per rec id (and 'more' for an older page), so an Undo
  // clicked while its decision is still refetching keeps the card saving.
  const [busy, setBusy] = useState<ReadonlyMap<string, number>>(() => new Map())
  const startBusy = useCallback((id: string) => setBusy((m) => new Map(m).set(id, (m.get(id) ?? 0) + 1)), [])
  const endBusy = useCallback((id: string) => setBusy((m) => {
    const n = new Map(m)
    const left = (m.get(id) ?? 1) - 1
    if (left > 0) n.set(id, left); else n.delete(id)
    return n
  }), [])
  const [error, setError] = useState('')
  const ledger = useRef({ history, nextBefore })
  ledger.current = { history, nextBefore }

  const fail = useCallback((cause: unknown, fallback: string) => {
    if (cause instanceof AuthError) onAuthError()
    else setError(cause instanceof Error ? cause.message : fallback)
  }, [onAuthError])

  const load = useCallback(async () => {
    setError('')
    try {
      const page = await getRecLedger()
      setOpen(page.open); setHistory(page.history); setNextBefore(page.nextBefore); setStats(page.stats)
    } catch (cause) { fail(cause, 'Recommendations could not load.') }
    finally { setLoading(false) }
  }, [fail])

  useEffect(() => { void load() }, [load])

  async function more() {
    if (!nextBefore) return
    startBusy('more'); setError('')
    try {
      const page = await getRecLedger(nextBefore)
      setHistory((current) => [...current, ...page.history]); setNextBefore(page.nextBefore); setStats(page.stats)
    } catch (cause) { fail(cause, 'Older recommendations could not load.') }
    finally { endBusy('more') }
  }

  // A change moves the rec at once, then refetches the first page (open recs and the
  // stats line move with it) and keeps the older pages already loaded (mergeLedger).
  const run = useCallback(async (id: string, change: () => Promise<{ rec: Rec }>, after?: (rec: Rec) => void) => {
    startBusy(id); setError('')
    try {
      const { rec } = await change()
      const stillOpen = rec.decision === 'pending' || rec.decision === 'deferred'
      const others = (list: Rec[]) => list.filter((r) => r.id !== rec.id)
      setOpen((list) => (stillOpen ? [...others(list), rec] : others(list)))
      setHistory((list) => (stillOpen ? others(list) : [rec, ...others(list)]))
      after?.(rec)
      try {
        const first = await getRecLedger()
        const next = mergeLedger(ledger.current, first, rec)
        setOpen(next.open); setHistory(next.history); setNextBefore(next.nextBefore); setStats(first.stats)
      } catch (cause) { fail(cause, 'Saved, but the list could not refresh.') }
    } catch (cause) { fail(cause, 'That change could not be saved.') }
    finally { endBusy(id) }
  }, [fail, startBusy, endBusy])

  /** Decide, then say what happens next, with Undo (back to waiting) where it makes sense. */
  const decide: Decide = useCallback((rec, decision, extra = {}) => {
    void run(rec.id, () => decideRec(rec.id, { decision, ...extra }), (saved) => {
      if (decision === 'pending') { pushToast(decisionToast(saved), 'success'); return }
      pushToast(decisionToast(saved), 'success', {
        duration: 5000,
        action: { label: 'Undo', onClick: () => { void run(rec.id, () => decideRec(rec.id, { decision: 'pending' })) } },
      })
    })
  }, [run])

  const outcome: Outcome = useCallback((rec, value) => {
    void run(rec.id, () => setRecOutcome(rec.id, { outcome: value }), () => pushToast('Outcome saved.', 'success'))
  }, [run])

  const sections = useMemo(() => recSections([...open, ...history]), [open, history])

  return (
    <div className="view rv-view" aria-busy={loading || undefined}>
      <div className="pk-page rv-page">
        {stats && stats.total > 0 && <TrackRecord stats={stats} />}
        {error && (
          <div className="rv-error" role="alert">
            <Hi icon={ExclamationTriangleIcon} size={15} />
            <span>{error}</span>
            <button type="button" onClick={() => void load()}>Retry</button>
          </div>
        )}
        {!loading && !sections.length && !error && (
          <div className="rv-empty">
            <IconBulb size={34} stroke={1.5} aria-hidden="true" />
            <strong>Nothing to decide</strong>
            <p>When an agent suggests something worth deciding, it lands here with its evidence, and you choose.</p>
          </div>
        )}
        {sections.map((section) => (
          <section className="rv-section" key={section.id} aria-labelledby={`recs-${section.id}`}>
            <h3 className="pk-section" id={`recs-${section.id}`}>
              {section.title}<span className="pk-count tnum">{section.recs.length}</span>
            </h3>
            {section.recs.map((rec) => rec.decision === 'pending'
              ? <PendingCard key={rec.id} rec={rec} busy={busy.has(rec.id)} decide={decide} />
              : <DecidedRow key={rec.id} rec={rec} busy={busy.has(rec.id)} decide={decide} outcome={outcome} />)}
          </section>
        ))}
        {nextBefore && (
          <div className="rv-more">
            <button type="button" className="pk-btn" disabled={busy.has('more')} onClick={() => void more()}>
              {busy.has('more') ? 'Loading…' : 'Show older decisions'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function TrackRecord({ stats }: { stats: RecStats }) {
  const tiles = statTiles(stats)
  return (
    <div className="rv-record" role="group" aria-label={`Track record: ${stats.line}`}>
      <div className="pk-stats rv-stats">
        {tiles.map((tile) => (
          <div key={tile.label} className="pk-stat">
            <span className={`pk-stat-n${tile.label === 'Waiting' && stats.pending ? ' rv-amber' : ''}`}>{tile.value}</span>
            <span className="pk-stat-l">{tile.label}</span>
          </div>
        ))}
      </div>
      {stats.line && <p className="rv-line tnum">{stats.line}</p>}
    </div>
  )
}

function Source({ rec }: { rec: Rec }) {
  const path = recSourcePath(rec.source)
  const label = recSourceLabel(rec.source)
  if (!path) return <span>{label}</span>
  return (
    <a className="rv-source" href={path} aria-label={`From ${label}, open the chat`}>
      <Hi icon={ChatBubbleLeftIcon} size={13} />{label}
    </a>
  )
}

function Meta({ rec }: { rec: Rec }) {
  const meta = recMeta(rec)
  return (
    <div className="rv-meta">
      <Source rec={rec} />
      {meta && <span className="tnum">{meta}</span>}
    </div>
  )
}

function Evidence({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rv-evidence">
      <button type="button" className="rv-disclose" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Hi icon={ChevronRightIcon} size={13} className={open ? 'rv-turned' : ''} /> Evidence
      </button>
      {open && <p className="rv-evidence-text">{text}</p>}
    </div>
  )
}

function Spinner() {
  return <span className="rv-spinner" role="status" aria-label="Saving" />
}

/** A note before deciding: Decline always asks; Accept and Defer ask from "…". */
type NoteMode = { decision: 'accepted' | 'declined' | 'deferred' }

const NOTE_COPY = {
  declined: { title: 'Why not?', hint: 'Optional. Agents read this before suggesting it again.', ok: 'Decline' },
  accepted: { title: 'Accept', hint: 'Add a note (optional).', ok: 'Accept' },
  deferred: { title: 'Defer', hint: 'Add a note (optional), and when to ask again.', ok: 'Defer' },
} as const

function NoteForm({ rec, mode, busy, onDone, decide }: { rec: Rec; mode: NoteMode; busy: boolean; onDone: () => void; decide: Decide }) {
  const [note, setNote] = useState('')
  const [deferDays, setDeferDays] = useState(DEFER_CHOICES[0].days)
  const copy = NOTE_COPY[mode.decision]
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  return (
    <form
      className="rv-note"
      onSubmit={(event) => {
        event.preventDefault()
        const text = note.trim()
        decide(rec, mode.decision, { ...(text ? { note: text } : {}), ...(mode.decision === 'deferred' ? { deferDays } : {}) })
        onDone()
      }}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onDone() } }}
    >
      <label className="rv-note-label" htmlFor={`rv-note-${rec.id}`}>
        <strong>{copy.title}</strong> <span>{copy.hint}</span>
      </label>
      <input
        ref={input}
        id={`rv-note-${rec.id}`}
        className="rv-note-input"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Note (optional)"
        aria-label={`Note on ${rec.title}`}
      />
      <div className="rv-note-actions">
        {mode.decision === 'deferred' && (
          <label className="rv-defer-pick">Ask again
            <select value={deferDays} onChange={(event) => setDeferDays(Number(event.target.value))}>
              {DEFER_CHOICES.map((choice) => <option key={choice.days} value={choice.days}>{choice.label.toLowerCase()}</option>)}
            </select>
          </label>
        )}
        <button type="button" className="pk-btn" onClick={onDone}>Cancel</button>
        <button className={`pk-btn ${mode.decision === 'declined' ? 'pk-danger' : 'pk-primary'}`} disabled={busy}>{copy.ok}</button>
      </div>
    </form>
  )
}

function PendingCard({ rec, busy, decide }: { rec: Rec; busy: boolean; decide: Decide }) {
  const [menu, setMenu] = useState<{ which: 'defer' | 'more'; anchor: HTMLElement } | null>(null)
  const [noting, setNoting] = useState<NoteMode | null>(null)
  const chat = recSourcePath(rec.source)
  const toggleMenu = (which: 'defer' | 'more') => (event: React.MouseEvent<HTMLButtonElement>) => {
    const anchor = event.currentTarget
    setMenu((current) => (current?.which === which ? null : { which, anchor }))
  }

  const deferItems: MenuEntry[] = [
    { heading: 'Ask again' },
    ...DEFER_CHOICES.map((choice) => ({ key: String(choice.days), label: choice.label, onSelect: () => decide(rec, 'deferred', { deferDays: choice.days }) })),
  ]
  const moreItems: MenuEntry[] = [
    { key: 'note', label: 'Accept with a note…', icon: PencilSquareIcon, onSelect: () => setNoting({ decision: 'accepted' }) },
    { key: 'defer-note', label: 'Defer with a note…', icon: ClockIcon, onSelect: () => setNoting({ decision: 'deferred' }) },
    ...(chat ? [{ key: 'chat', label: 'Open the chat it came from', icon: ChatBubbleLeftIcon, onSelect: () => followLink({ kind: 'app', to: chat }) }] : []),
  ]

  return (
    <article className="pk-card rv-card">
      <div className="rv-title-row">
        <h4 className="rv-title">{rec.title}</h4>
        {busy && <Spinner />}
      </div>
      <Meta rec={rec} />
      {rec.body && <p className="rv-body">{rec.body}</p>}
      {rec.decisionNote && <p className="rv-quiet">Your note: “{rec.decisionNote}”</p>}
      {rec.changedNote && (
        <div className="rv-changed">
          <strong>What changed since you declined something like it</strong>
          <span>{rec.changedNote}</span>
        </div>
      )}
      {rec.evidence && <Evidence text={rec.evidence} />}

      {noting ? (
        <NoteForm rec={rec} mode={noting} busy={busy} decide={decide} onDone={() => setNoting(null)} />
      ) : (
        <div className="rv-decide">
          <button type="button" className="pk-btn pk-primary rv-accept" disabled={busy} onClick={() => decide(rec, 'accepted')}>
            <Hi icon={CheckIcon} size={16} /> Accept
          </button>
          <button type="button" className="pk-btn rv-decline" disabled={busy} onClick={() => setNoting({ decision: 'declined' })}>Decline</button>
          <button type="button" className="pk-btn rv-defer" disabled={busy} aria-haspopup="menu" aria-expanded={menu?.which === 'defer'} onClick={toggleMenu('defer')}>
            Defer <Hi icon={ChevronDownIcon} size={12} className="rv-caret" />
          </button>
          <button type="button" className="pk-icon-btn rv-more-btn" disabled={busy} aria-haspopup="menu" aria-expanded={menu?.which === 'more'} aria-label="More for this recommendation" onClick={toggleMenu('more')}>
            <Hi icon={EllipsisHorizontalIcon} size={18} />
          </button>
        </div>
      )}
      {menu && (
        <Menu
          anchor={menu.anchor}
          label={menu.which === 'defer' ? 'Ask again' : 'More for this recommendation'}
          items={menu.which === 'defer' ? deferItems : moreItems}
          onClose={() => setMenu(null)}
          width={menu.which === 'defer' ? 200 : 250}
        />
      )}
    </article>
  )
}

const WORD: Record<string, string> = { deferred: 'Deferred', accepted: 'Accepted', declined: 'Declined' }

/** A decided, deferred or measured rec: one line until clicked, then everything and its actions. */
function DecidedRow({ rec, busy, decide, outcome }: { rec: Rec; busy: boolean; decide: Decide; outcome: Outcome }) {
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const tone = rec.outcome ?? rec.decision
  const word = rec.outcome ? OUTCOME_LABELS[rec.outcome] : WORD[rec.decision] ?? rec.decision
  const when = rec.decision === 'deferred' && rec.reviewOn ? `back ${rec.reviewOn}` : whenLabel(rec.outcomeAt ?? rec.decidedAt)
  const needsOutcome = rec.decision === 'accepted' && (!rec.outcome || rec.outcomeBy === 'agent')
  const outcomes = Object.keys(OUTCOME_LABELS) as RecOutcome[]

  return (
    <div className={`rv-row${open ? ' rv-row-open' : ''}${rec.decision === 'declined' ? ' rv-row-declined' : ''}`}>
      <button
        type="button"
        className="rv-row-head"
        aria-expanded={open}
        aria-label={`${rec.title}. ${word}${when ? `, ${when}` : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`rv-pill rv-tone-${tone}`}>{word}</span>
        <span className="rv-row-title">{rec.title}</span>
        {busy ? <Spinner /> : when ? <span className="rv-when">{when}</span> : null}
        <Hi icon={ChevronDownIcon} size={14} className={`rv-row-chevron${open ? ' rv-flipped' : ''}`} />
      </button>

      {needsOutcome && (
        <div className="rv-outcomes">
          <span className="rv-ask">{rec.outcome ? `${outcomeLabel(rec)}. Is that right?` : 'How did it go?'}</span>
          <div className="rv-outcome-btns">
            {outcomes.map((value) => (
              <button key={value} type="button" className="pk-btn pk-compact" disabled={busy} onClick={() => outcome(rec, value)}>{OUTCOME_LABELS[value]}</button>
            ))}
          </div>
        </div>
      )}

      {open && (
        <div className="rv-row-body">
          <Meta rec={rec} />
          {rec.body && <p className="rv-body rv-small">{rec.body}</p>}
          {rec.changedNote && <p className="rv-quiet">What changed since you declined something like it: {rec.changedNote}</p>}
          {rec.evidence && <Evidence text={rec.evidence} />}
          {rec.decisionNote && <p className="rv-quiet">“{rec.decisionNote}”</p>}
          {rec.outcome && rec.outcomeBy === 'owner' && <p className="rv-quiet">Outcome: {outcomeLabel(rec)}</p>}
          {rec.outcomeNote && <p className="rv-quiet">{rec.outcomeNote}</p>}
          <div className="rv-row-actions">
            {rec.decision === 'accepted' && rec.outcome && rec.outcomeBy === 'owner' && (
              <button type="button" className="pk-btn pk-compact" disabled={busy} aria-haspopup="menu" aria-expanded={!!menu} onClick={(event) => setMenu(menu ? null : event.currentTarget)}>
                Change outcome <Hi icon={ChevronDownIcon} size={12} />
              </button>
            )}
            <button type="button" className="pk-btn pk-compact" disabled={busy} onClick={() => decide(rec, 'pending')}>
              <Hi icon={ArrowUturnLeftIcon} size={14} /> Decide again
            </button>
          </div>
          {menu && (
            <Menu
              anchor={menu}
              label="How did it go?"
              items={[{ heading: 'How did it go?' }, ...outcomes.map((value) => ({
                key: value, label: OUTCOME_LABELS[value], checked: rec.outcome === value, onSelect: () => outcome(rec, value),
              }))]}
              onClose={() => setMenu(null)}
              width={200}
            />
          )}
        </div>
      )}
    </div>
  )
}
