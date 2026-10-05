import React, { useEffect, useRef, useState } from 'react'
import {
  ArrowRightIcon, BookmarkIcon, ChartBarIcon, ChatBubbleLeftIcon, CheckBadgeSolidIcon,
  CheckCircleIcon, ClockIcon, EllipsisHorizontalIcon, FlagIcon, Hi, NoSymbolIcon,
  PencilIcon, PencilSquareIcon, PlayIcon, PlusIcon, TrashIcon, TrophySolidIcon, XMarkIcon,
} from '../icons'
import GoalNumbers from './GoalNumbers'
import { GOAL_DONE_ICON, goalIconFor } from './goalIcon'
import { formatAmount } from './types'
import type { Goal, GoalMetric, GoalMetricChanges, GoalOptions, SubGoal } from './types'

/*
 * Bushido — an optional sibling training app — shows the goals linked to it.
 * The toggle only exists when the server has BUSHIDO_URL set (see /api/app/config);
 * without it the card has no Bushido menu item and no chip.
 *
 * The link is an ORDINARY `url` bookmark, not a new concept: `goal_links` exists
 * to say "this is related", and a goal pointing at the health app is exactly
 * that. So "show this in Bushido" costs no column, no migration and no sync — it is
 * the bookmark you could already add, with a button instead of a URL field.
 *
 * Matched on HOST rather than the whole URL, the same way Bushido matches it, so a
 * link with a path or a trailing slash still counts and a rename does not
 * silently unlink everything. The app has been renamed more than once, and links
 * saved under its earlier hostnames still count (see LEGACY_BUSHIDO_HOSTS).
 */
// `hosts` is the configured host plus any BUSHIDO_LEGACY_HOSTS, so links saved
// under an app's earlier hostname still count. Empty means Bushido is not set up.
export const bushidoLinkOf = (goal: Goal, hosts: string[] = []) =>
  hosts.length ? goal.links.find((l) => l.kind === 'url' && !!l.url && hosts.some((h) => l.url!.includes(h))) : undefined

/**
 * Bushido's own mark — the ECG trace off its favicon.
 *
 * Traced from `bushido/app/public/icon.svg` rather than approximated: the same nine
 * points, scaled from that 512 box onto the 2.5–21.5 span Heroicons glyphs use so
 * it sits level with the clock and flag chips beside it. One scale for both axes,
 * so the spike keeps its proportions.
 *
 * The tail ends ABOVE the baseline rather than returning to it. That is the whole
 * joke of the icon — a heartbeat's recovery and an elevation profile at the same
 * time — and flattening it out would leave a generic ECG that any health app
 * could have drawn.
 *
 * Stroke 1.7, between the 1.5 the other hand-drawn glyphs use and the 1.9 the
 * original's 30-unit stroke actually scales to. Full weight closes up the spike —
 * its two legs are barely two units apart — and that V is the part that says ECG.
 *
 * Sized 15 in the chip against everything else's 11, because the trace only fills
 * eleven of its twenty-four units vertically. It measures larger and reads level.
 *
 * `currentColor`, not the lime, so the chip's own states drive it the way they
 * drive every other chip glyph. The lime arrives via the CSS when it is on.
 */
export function BushidoMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"
      {...props}
    >
      <path d="M2.5 12.32 H8.15 L9.82 6.54 L12.13 17.46 L14.05 10.78 H15.85 L17.65 8.47 H21.5" />
    </svg>
  )
}

/**
 * How long ago a connector-fed number was actually read.
 *
 * Not the moment the page loaded: a `strava_distance` metric is resolved out of the local
 * activity cache, and `strava-sync` fills that every few hours. Without this the card
 * asserts a number is current when this morning's run has simply not synced yet — which
 * reads as "my trail run didn't count for my running goal" rather than "wait a bit".
 */
function freshness(readAt: string | null): string | null {
  const at = readAt ? Date.parse(readAt) : NaN
  if (!Number.isFinite(at)) return null
  const minutes = Math.round((Date.now() - at) / 60000)
  if (minutes < 2) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/**
 * The day a goal was finished, for the chip that says so.
 *
 * Short and without the year: the card already sits inside a period whose label names
 * it, and "Achieved Sep 16, 2026" beside "moved 2×" is mostly punctuation. Null when
 * the server has no timestamp — the chip still says Achieved, it just can't say when.
 */
function achievedOn(completedAt: string | null): string | null {
  const at = completedAt ? Date.parse(completedAt) : NaN
  if (!Number.isFinite(at)) return null
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/**
 * One number on a goal.
 *
 * A manual metric gets an inline field and a +1-style stepper. A sourced one gets a
 * chip naming where it comes from and no field at all — its value belongs to the
 * connector, and offering a box that the server would refuse is worse than offering
 * nothing. An unreadable source renders as "can't read" rather than an empty bar,
 * because a zero bar looks exactly like a bad week.
 */
function MetricRow({ metric, onLog, busy, percentAtEnd }: {
  metric: GoalMetric
  onLog: (patch: { value?: number; delta?: number }) => void
  busy: boolean
  /**
   * The goal's own percentage, parked at the end of this bar.
   *
   * Passed only when this row *is* the goal's progress — one metric, no steps —
   * because then the card's bar and the metric's bar are the same bar, and printing
   * the number twice is the same fact in two places.
   */
  percentAtEnd?: number | null
}) {
  const [draft, setDraft] = useState('')
  const sourced = metric.sourceKind !== 'manual'

  return (
    <div className={`goal-metric${metric.available ? '' : ' unreadable'}`}>
      <div className="goal-metric-head">
        <span className="goal-metric-label">{metric.label}</span>
        {sourced && <span className="goal-chip source" title={metric.sourceLabel}>auto</span>}
        <span className="goal-metric-amount">
          {metric.available
            ? <>{formatAmount(metric.value ?? 0, metric.unit)} <span className="muted">/ {formatAmount(metric.targetValue, metric.unit)}</span></>
            : <span className="muted">can’t read — {metric.unavailableReason}</span>}
        </span>
      </div>

      <div className="goal-bar-row">
        <div className="goal-bar" role="img" aria-label={`${metric.percent ?? 0} percent of ${metric.label}`}>
          <span className="goal-bar-fill" style={{ width: `${metric.available ? metric.percent ?? 0 : 0}%` }} />
        </div>
        {percentAtEnd !== undefined && (
          <span className="goal-percent">{percentAtEnd === null ? <span className="muted">—</span> : `${percentAtEnd}%`}</span>
        )}
      </div>

      <div className="goal-metric-foot">
        {metric.feederCount > 0 && metric.available && (
          <span className="muted">
            incl. {formatAmount(metric.rolledUpValue ?? 0, metric.unit)} from {metric.feederCount} step{metric.feederCount === 1 ? '' : 's'}
            {metric.unreadableFeederCount > 0 && ` · ${metric.unreadableFeederCount} unreadable`}
          </span>
        )}
        {sourced
          ? (
            <span className="muted">
              {metric.sourceLabel}
              {/* Says which sports a family covers and how stale the reading is — the
                  two things a goal that "isn't counting my workout" turns on. */}
              {metric.available && freshness(metric.readAt) && <> · synced {freshness(metric.readAt)}</>}
            </span>
          )
          : (
            <span className="goal-metric-log">
              <button className="btn compact" disabled={busy} onClick={() => onLog({ delta: 1 })} aria-label={`Add one ${metric.label}`}>+1</button>
              <input
                type="number" inputMode="decimal" placeholder="log" value={draft} disabled={busy}
                aria-label={`Log ${metric.label}`}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  const n = Number(draft)
                  if (!Number.isFinite(n)) return
                  onLog({ delta: n })
                  setDraft('')
                }}
              />
            </span>
          )}
      </div>
    </div>
  )
}

/**
 * One step, and the two different ways it can stop being in the way.
 *
 * Done and not-doing are separate states on purpose, the same way they are on the goal:
 * a step is often an add-on — "and if I get to it, send the deck as well" — where the
 * goal itself landed and that one piece never will. Marking it done would claim work
 * that did not happen; leaving it open would hold the goal under 100% over something
 * already decided. So it crosses out, stays on the card, and drops out of the count.
 *
 * It keeps its tick either way: changing your mind and actually doing it is one click,
 * not un-abandon-then-tick.
 */
function SubGoalRow({ subGoal, onToggle, onAbandon, onRename, onLog, onEditNumbers, busy }: {
  subGoal: SubGoal
  onToggle: () => void
  /** Save a new title for this step. Absent, the row offers no way to rename it. */
  onRename?: (title: string) => void
  /** Stop doing this step, or pick it back up. Absent, the row offers no way to. */
  onAbandon?: (abandoned: boolean) => void
  onLog: (metricId: string, patch: { value?: number; delta?: number }) => void
  /**
   * Open the numbers editor on this step. Absent, the step can still be logged against —
   * it just cannot be given a number it does not already have.
   */
  onEditNumbers?: () => void
  busy: boolean
}) {
  const name = subGoal.title || 'this step'
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState(subGoal.title)

  function startRename() {
    setTitleDraft(subGoal.title)
    setRenaming(true)
  }

  // Blur saves as well as Enter: tapping away on a phone is how you finish typing.
  // An unchanged title is not a write.
  function saveRename() {
    setRenaming(false)
    const title = titleDraft.trim()
    if (title !== subGoal.title.trim()) onRename?.(title)
  }

  return (
    <div className={`goal-step${subGoal.complete ? ' done' : ''}${subGoal.abandoned ? ' not-doing' : ''}`}>
      <button
        className="goal-check"
        disabled={busy}
        onClick={onToggle}
        aria-label={subGoal.complete ? `Reopen ${name}` : `Mark ${name} done`}
      >
        {subGoal.complete ? <Hi icon={CheckCircleIcon} size={20} /> : <span className="goal-check-empty" />}
      </button>
      <div className="goal-step-body">
        {renaming ? (
          <input
            className="goal-step-rename" autoFocus value={titleDraft}
            aria-label={`Rename ${name}`}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={saveRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveRename()
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
        <span className="goal-step-title">
          {subGoal.title || <em className="muted">unnamed step</em>}
          {/* A step with numbers on it is worth what those numbers say, not nothing
              until it is ticked — see goals/progress.mjs. So it states its own
              percentage, the way the goal above it does. */}
          {subGoal.metrics.length > 0 && subGoal.progress.percent !== null && !subGoal.complete && (
            <span className="goal-step-pct muted">{subGoal.progress.percent}%</span>
          )}
        </span>
        )}
        {subGoal.metrics.map((metric) => (
          <MetricRow key={metric.id} metric={metric} busy={busy} onLog={(patch) => onLog(metric.id, patch)} />
        ))}
      </div>
      {onRename && (
        <button
          className="goal-step-off"
          disabled={busy || renaming}
          onClick={startRename}
          title="Rename this step"
          aria-label={`Rename ${name}`}
        >
          <Hi icon={PencilIcon} size={14} />
        </button>
      )}
      {onEditNumbers && (
        <button
          className="goal-step-off"
          disabled={busy}
          onClick={onEditNumbers}
          title={subGoal.metrics.length > 0 ? 'Edit this step’s numbers' : 'Track a number on this step'}
          aria-label={subGoal.metrics.length > 0 ? `Edit the numbers on ${name}` : `Track a number on ${name}`}
        >
          <Hi icon={ChartBarIcon} size={14} />
        </button>
      )}
      {onAbandon && (
        <button
          className="goal-step-off"
          disabled={busy}
          onClick={() => onAbandon(!subGoal.abandoned)}
          title={subGoal.abandoned ? 'Put this step back' : 'Not doing this step'}
          aria-label={subGoal.abandoned ? `Start ${name} again` : `Not doing ${name}`}
        >
          <Hi icon={subGoal.abandoned ? PlayIcon : NoSymbolIcon} size={14} />
        </button>
      )}
    </div>
  )
}

export default function GoalCard({ goal, busy, options = null, onToggle, onToggleStep, onLog, onPostpone, onDelete, onEdit, onAbandon, onAbandonStep, onRenameStep, onAddStep, onSaveMetrics, onSaveStepMetrics, onToggleBushido, bushidoHosts = [] }: {
  goal: Goal
  busy: boolean
  /** The unit and sport lists the numbers editor offers. Absent, it opens with none. */
  options?: GoalOptions | null
  onToggle: () => void
  onToggleStep: (id: string, complete: boolean) => void
  onLog: (metricId: string, patch: { value?: number; delta?: number }) => void
  onPostpone: () => void
  onDelete: () => void
  /** Save an edited title and notes. Absent, the card offers no editing. */
  onEdit?: (patch: { title: string; notes: string }) => void
  /** Stop doing this, or start again. */
  onAbandon?: (abandoned: boolean) => void
  /**
   * Stop doing one step, or pick it back up — an add-on to the goal he knows he is not
   * getting to, without saying that about the goal itself. Absent, steps offer no way to.
   */
  onAbandonStep?: (id: string, abandoned: boolean) => void
  /** Rename one step. Absent, step titles are read-only. */
  onRenameStep?: (id: string, title: string) => void
  onAddStep: (title: string) => void
  /**
   * Add, retarget, re-source or drop the numbers this goal tracks.
   *
   * A diff rather than a form — see `GoalNumbers`. Absent, the card offers no way in,
   * which is the state the card was in until numbers became editable at all.
   */
  onSaveMetrics?: (changes: GoalMetricChanges) => void
  /**
   * The same round of edits, against one step's numbers.
   *
   * Its own prop rather than a second argument to `onSaveMetrics`, matching the
   * `onAbandon` / `onAbandonStep` pair above: the two act on different rows, and a
   * caller that forgot which one it was handed should not typecheck.
   */
  onSaveStepMetrics?: (stepId: string, changes: GoalMetricChanges) => void
  /**
   * Show this goal in Bushido, or stop.
   *
   * Handed the EXISTING link when there is one, so the caller unlinks by id and
   * links when it gets null — the card knows which link is the Bushido one and the
   * view does not have to work it out again. Absent, the button is not offered.
   */
  onToggleBushido?: (current: { id: string } | null) => void
  /** Hosts that count as Bushido links; empty when Bushido is not configured. */
  bushidoHosts?: string[]
}) {
  const [confirmPostpone, setConfirmPostpone] = useState(false)
  const bushidoLink = bushidoLinkOf(goal, bushidoHosts)
  // Derived, never stored — see goalIcon.ts for why a goal has no icon picker.
  const Glyph = goal.complete ? GOAL_DONE_ICON : goalIconFor(goal)
  const [stepDraft, setStepDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // 'all' is the full edit; 'note' is the same save with only the text box on show,
  // because "write down why I finished this" should not make you walk past the title.
  const [editing, setEditing] = useState<'all' | 'note' | null>(null)
  // null = closed, '' = the goal's own numbers, otherwise the id of the step being edited.
  const [numbersFor, setNumbersFor] = useState<string | null>(null)
  const [draft, setDraft] = useState({ title: goal.title, notes: goal.notes })
  const menuRef = useRef<HTMLDivElement>(null)

  /*
   * The moment it lands.
   *
   * A finished goal keeps its ring and its wash for good — that is what makes the
   * bottom of the page worth scrolling to — but the flourish belongs to the person
   * who just did it. So it hangs off the TRANSITION rather than off `complete`,
   * which is what stops a week with six finished goals setting the whole page off
   * every time it loads.
   */
  const [celebrating, setCelebrating] = useState(false)
  const wasComplete = useRef(goal.complete)
  useEffect(() => {
    const was = wasComplete.current
    wasComplete.current = goal.complete
    if (!goal.complete || was) return
    setCelebrating(true)
    const timer = setTimeout(() => setCelebrating(false), 1300)
    return () => clearTimeout(timer)
  }, [goal.complete])

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key) }
  }, [menuOpen])

  function startEditing(mode: 'all' | 'note') {
    setDraft({ title: goal.title, notes: goal.notes })
    setEditing(mode)
    setMenuOpen(false)
  }

  // One bar carries the goal's percent when the goal is one number; otherwise the
  // card gets its own bar, because "62%" next to the first of three metrics would
  // look like that metric's number.
  const singleMetric = goal.metrics.length === 1 && goal.subGoals.length === 0

  function saveEdit() {
    const title = draft.title.trim()
    if (!title) return
    onEdit?.({ title, notes: draft.notes.trim() })
    setEditing(null)
  }

  const menuButton = (
    <div className="goal-menu-anchor" ref={menuRef}>
      <button
        className="goal-menu-toggle" disabled={busy}
        aria-haspopup="menu" aria-expanded={menuOpen}
        aria-label={`More actions for ${goal.title}`}
        onClick={() => setMenuOpen((open) => !open)}
      ><Hi icon={EllipsisHorizontalIcon} size={17} /></button>
      {menuOpen && (
        <div className="goal-menu" role="menu" aria-label={`Actions for ${goal.title}`}>
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setAdding(true) }}>
            <Hi icon={PlusIcon} size={15} /><span>Add a step</span>
          </button>
          {onSaveMetrics && (
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setNumbersFor('') }}>
              <Hi icon={ChartBarIcon} size={15} />
              <span>{goal.metrics.length > 0 ? 'Edit the numbers' : 'Track a number'}</span>
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setConfirmPostpone(true) }}>
            <Hi icon={ArrowRightIcon} size={15} /><span>Move to the next {goal.period.type}</span>
          </button>
          {onToggleBushido && (
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onToggleBushido(bushidoLink ?? null) }}>
              <Hi icon={BushidoMark} size={15} /><span>{bushidoLink ? 'Remove from Bushido' : 'Show in Bushido'}</span>
            </button>
          )}
          <div className="goal-menu-separator" />
          {onEdit && (
            <button type="button" role="menuitem" onClick={() => startEditing('note')}>
              <Hi icon={ChatBubbleLeftIcon} size={15} /><span>{goal.notes ? 'Edit note' : 'Add a note'}</span>
            </button>
          )}
          {onEdit && (
            <button type="button" role="menuitem" onClick={() => startEditing('all')}>
              <Hi icon={PencilSquareIcon} size={15} /><span>Edit goal</span>
            </button>
          )}
          {onAbandon && (
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onAbandon(!goal.abandoned) }}>
              <Hi icon={goal.abandoned ? PlayIcon : NoSymbolIcon} size={15} />
              <span>{goal.abandoned ? 'Start doing this again' : 'Not doing this'}</span>
            </button>
          )}
          <div className="goal-menu-separator" />
          <button className="danger" type="button" role="menuitem" onClick={() => { setMenuOpen(false); onDelete() }}>
            <Hi icon={TrashIcon} size={15} /><span>Delete goal</span>
          </button>
        </div>
      )}
    </div>
  )

  return (
    <article className={`goal-card period-${goal.period.type}${goal.complete ? ' done' : ''}${celebrating ? ' celebrate' : ''}${goal.abandoned ? ' not-doing' : ''}${goal.periodState === 'expired' ? ' expired' : ''}`}>
      <header className="goal-card-head">
        {/* Decoration, not information: everything it hints at is written out below it. */}
        <span className="goal-icon" aria-hidden="true"><Hi icon={Glyph} size={17} /></span>

        <div className="goal-card-title">
          {editing ? (
            <div className="goal-edit">
              {editing === 'note' ? <h3>{goal.title}</h3> : (
                <input
                  autoFocus aria-label="Goal title" value={draft.title}
                  onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveEdit()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />
              )}
              <textarea
                autoFocus={editing === 'note'}
                aria-label="Goal note" rows={editing === 'note' ? 3 : 2}
                placeholder="A reminder, or why this ended the way it did…"
                value={draft.notes}
                onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditing(null)
                  // Enter is a newline in a note; the button saves it.
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit()
                }}
              />
              <span className="goal-edit-actions">
                <button className="btn compact primary" disabled={busy || !draft.title.trim()} onClick={saveEdit}>Save</button>
                <button className="btn compact" onClick={() => setEditing(null)}>Cancel</button>
                {/* Editing a goal and editing what it counts are the same intention, so
                    the numbers are one click from here as well as from the menu. */}
                {editing === 'all' && onSaveMetrics && (
                  <button className="btn compact" onClick={() => setNumbersFor('')}>
                    <Hi icon={ChartBarIcon} size={13} /> Numbers
                  </button>
                )}
              </span>
            </div>
          ) : <h3>{goal.title}</h3>}
          <div className="goal-card-chips">
            {/* First chip on a finished card, and the only one that is good news. It
                replaces the strikethrough: the card says what happened in words
                instead of scoring a line through the thing you did. */}
            {goal.complete && (
              <span className="goal-chip achieved">
                {/* Filled, not outlined: at 11px inside a filled chip an outline
                    glyph reads as a smudge, and the trophies elsewhere on the card
                    are enough trophies. */}
                <Hi icon={CheckBadgeSolidIcon} size={12} />
                {achievedOn(goal.completedAt) ? `Achieved ${achievedOn(goal.completedAt)}` : 'Achieved'}
              </span>
            )}
            {goal.abandoned && <span className="goal-chip not-doing">not doing</span>}
            {/* A goal you finished is not late, whenever its week ended. */}
            {goal.periodState === 'expired' && !goal.complete && <span className="goal-chip expired">expired</span>}
            {goal.periodState === 'active' && !goal.complete && goal.daysLeft <= 2 && (
              <span className="goal-chip urgent"><Hi icon={ClockIcon} size={11} /> {goal.daysLeft} day{goal.daysLeft === 1 ? '' : 's'} left</span>
            )}
            {/* Never reset, so this is the one thing that says "you have decided not to do this". */}
            {goal.postponedCount > 0 && (
              <span className={`goal-chip${goal.postponedCount >= 3 ? ' warn' : ''}`} title="Times this has been pushed to a later period">
                <Hi icon={FlagIcon} size={11} /> moved {goal.postponedCount}×
              </span>
            )}
            {goal.progress.subGoalsTotal > 0 && (
              <span className="goal-chip">{goal.progress.subGoalsDone}/{goal.progress.subGoalsTotal} steps</span>
            )}
            {/* Counted separately rather than folded into the total above: "2/3" and
                "2/2, and one I decided against" are different weeks, and the second
                one is the honest reading of a goal that landed anyway. */}
            {goal.progress.subGoalsAbandoned > 0 && (
              <span className="goal-chip not-doing" title="Steps decided against">
                {goal.progress.subGoalsAbandoned} step{goal.progress.subGoalsAbandoned === 1 ? '' : 's'} not doing
              </span>
            )}
            {/* "This goal is also in the health app" is a state of the goal, the same
                kind of thing as "moved 3×" — so it reads as a chip. Turning it on and
                off is in the menu with every other action. */}
            {bushidoLink && (
              <span className="goal-chip bushido on" title="Showing in Bushido">
                <Hi icon={BushidoMark} size={15} /> Bushido
              </span>
            )}
          </div>
        </div>

        <div className="goal-card-tools">
          {menuButton}
          <button
            className={`goal-check big${goal.complete ? ' won' : ''}`}
            disabled={busy}
            onClick={onToggle}
            aria-label={goal.complete ? `Reopen ${goal.title}` : `Mark ${goal.title} complete`}
          >
            {goal.complete ? <Hi icon={TrophySolidIcon} size={20} /> : <span className="goal-check-empty" />}
          </button>
        </div>
      </header>

      {goal.notes && !editing && <p className="goal-notes">{goal.notes}</p>}

      {goal.metrics.map((metric) => (
        <MetricRow
          key={metric.id} metric={metric} busy={busy}
          onLog={(patch) => onLog(metric.id, patch)}
          percentAtEnd={singleMetric ? goal.progress.percent : undefined}
        />
      ))}

      {/* No single metric to hang it off, so the goal gets a bar of its own. */}
      {!singleMetric && (
        <div className="goal-bar-row goal-total">
          <div className="goal-bar" role="img" aria-label={`${goal.progress.percent ?? 0} percent complete`}>
            <span className="goal-bar-fill" style={{ width: `${goal.progress.percent ?? 0}%` }} />
          </div>
          <span className="goal-percent">
            {goal.progress.percent === null ? <span className="muted">—</span> : `${goal.progress.percent}%`}
          </span>
        </div>
      )}

      {goal.subGoals.length > 0 && (
        <div className="goal-steps">
          {goal.subGoals.map((sub) => (
            <SubGoalRow
              key={sub.id} subGoal={sub} busy={busy}
              onToggle={() => onToggleStep(sub.id, !sub.complete)}
              onAbandon={onAbandonStep ? (abandoned) => onAbandonStep(sub.id, abandoned) : undefined}
              onRename={onRenameStep ? (title) => onRenameStep(sub.id, title) : undefined}
              onEditNumbers={onSaveStepMetrics ? () => setNumbersFor(sub.id) : undefined}
              onLog={onLog}
            />
          ))}
        </div>
      )}

      {goal.links.some((l) => l.id !== bushidoLink?.id) && (
        <div className="goal-links">
          {/* The Bushido link is already a chip in the header; listing it again as a
              bookmark would be the same fact in two shapes. */}
          {goal.links.filter((l) => l.id !== bushidoLink?.id).map((link) => (
            <span key={link.id} className={`goal-chip link${link.todo?.status === 'done' ? ' done' : ''}`}>
              <Hi icon={BookmarkIcon} size={11} />
              {link.kind === 'url' && link.url
                ? <a href={link.url} target="_blank" rel="noreferrer">{link.label}</a>
                : <span title={link.todo ? `Task · ${link.todo.status}` : 'Task'}>{link.todo?.title ?? link.label}</span>}
            </span>
          ))}
        </div>
      )}

      {/* Nothing lives here permanently any more: every action is in the menu, and
          the footer only appears while one of them is being answered. */}
      {(adding || confirmPostpone) && (
        <footer className="goal-card-foot">
          {adding && (
            <span className="goal-step-add">
              <input
                autoFocus value={stepDraft} placeholder="A step toward this…"
                aria-label="New step"
                onChange={(e) => setStepDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { setAdding(false); setStepDraft('') }
                  if (e.key !== 'Enter' || !stepDraft.trim()) return
                  onAddStep(stepDraft.trim())
                  setStepDraft(''); setAdding(false)
                }}
              />
              <button className="btn compact" onClick={() => { setAdding(false); setStepDraft('') }} aria-label="Cancel"><Hi icon={XMarkIcon} size={14} /></button>
            </span>
          )}

          {/* Postponing is always confirmed: the count behind it is a record of a
              decision, so it should never go up because of a mis-click. */}
          {confirmPostpone && (
            <span className="goal-confirm">
              <span className="muted">Move to the next {goal.period.type}?</span>
              <button className="btn compact primary" disabled={busy} onClick={() => { setConfirmPostpone(false); onPostpone() }}>
                Move <Hi icon={ArrowRightIcon} size={13} />
              </button>
              <button className="btn compact" onClick={() => setConfirmPostpone(false)}>Keep</button>
            </span>
          )}
        </footer>
      )}
      {numbersFor !== null && (() => {
        const step = numbersFor ? goal.subGoals.find((sub) => sub.id === numbersFor) ?? null : null
        // A step id that no longer resolves means the goal reloaded without it; close
        // rather than opening an editor over nothing.
        if (numbersFor && !step) return null
        if (!step && !onSaveMetrics) return null
        return (
          <GoalNumbers
            goal={goal} step={step} options={options} busy={busy}
            onCancel={() => setNumbersFor(null)}
            onSave={(changes) => {
              setNumbersFor(null)
              if (step) onSaveStepMetrics?.(step.id, changes)
              else onSaveMetrics?.(changes)
            }}
          />
        )
      })()}
    </article>
  )
}
