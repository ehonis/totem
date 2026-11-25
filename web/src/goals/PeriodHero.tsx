/**
 * The head of a goal period, the app's PeriodHero (mobile/src/features/goals/PeriodHero.tsx):
 * a ring of goals achieved, the window with its ‹ › arrows (any week, month or year of
 * this kind, so a finished one stays readable), how long is left, and refresh and
 * + Goal. Replaces the one muted "‹ Nov 2 – 8 › · 2 of 5 done" line the page had.
 *
 * Coloured by its period (`.period-<type>` sets --period); green once everything in
 * play is achieved, when the count gives way to a trophy.
 */
import React from 'react'
import Ring from '../productivity/Ring'
import { ArrowPathIcon, ChevronLeftIcon, ChevronRightIcon, Hi, PlusIcon, TrophySolidIcon } from '../icons'
import type { GoalPeriod, GoalPeriodType } from './types'
import type { PeriodSummary } from './summary'

export default function PeriodHero({ title, unit, window, anchored, summary, daysLeft, syncing, onStep, onReset, onRefresh, onAdd, empty }: {
  /** "This week", "Next month", … */
  title: string
  unit: GoalPeriodType
  window: GoalPeriod | null
  /** Walked away from the tab's own window with the arrows. */
  anchored: boolean
  summary: PeriodSummary
  daysLeft: number | null
  syncing: boolean
  onStep: (direction: -1 | 1) => void
  onReset: () => void
  onRefresh: () => void
  onAdd: () => void
  /** Nothing set: the body says so and offers "Add a goal", so this is just the window and its arrows. */
  empty?: boolean
}) {
  const { achieved, counted, notDoing, ratio, meanPercent } = summary
  const all = counted > 0 && achieved === counted
  const facts = [
    daysLeft !== null && daysLeft >= 0 && !anchored ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : null,
    meanPercent !== null && counted > 0 && !all ? `${meanPercent}% of the way overall` : null,
    notDoing > 0 ? `${notDoing} not doing` : null,
  ].filter(Boolean)
  const eyebrow = anchored ? window?.label ?? title : `${title}${window ? ` · ${window.label}` : ''}`

  return (
    <section className={`goals-hero period-${unit}${all ? ' is-all' : ''}${empty ? ' is-empty' : ''}`} aria-label={`${title} summary`}>
      {empty ? (
        <p className="goals-hero-eyebrow">{eyebrow}</p>
      ) : (
        <div className="goals-hero-top">
          <Ring
            percent={counted ? ratio * 100 : 0}
            color={all ? 'var(--green)' : 'var(--period)'}
            track={`color-mix(in srgb, ${all ? 'var(--green)' : 'var(--period)'} 16%, transparent)`}
            size={76} stroke={7}
          >
            {all
              ? <Hi icon={TrophySolidIcon} size={28} className="goals-hero-trophy" />
              : <span className="goals-hero-count">{achieved}<small>/{counted}</small></span>}
          </Ring>
          <div className="goals-hero-text">
            <p className="goals-hero-eyebrow">{eyebrow}</p>
            <h2 className="goals-hero-title" aria-live="polite">
              {counted === 0 ? 'Nothing set yet' : all ? 'All achieved' : `${achieved} of ${counted} achieved`}
            </h2>
            {facts.length > 0 && <p className="goals-hero-facts">{facts.join(' · ')}</p>}
          </div>
        </div>
      )}
      <div className="goals-hero-foot">
        {/* The arrows walk to any period of this type — last week, the week before,
            the month before that — so a finished week stays somewhere it can be
            read, not just somewhere it once was. */}
        <button type="button" className="pk-icon-btn goals-hero-btn" onClick={() => onStep(-1)} aria-label={`Previous ${unit}`} title={`Previous ${unit}`}>
          <Hi icon={ChevronLeftIcon} size={18} />
        </button>
        <button type="button" className="pk-icon-btn goals-hero-btn" onClick={() => onStep(1)} aria-label={`Next ${unit}`} title={`Next ${unit}`}>
          <Hi icon={ChevronRightIcon} size={18} />
        </button>
        <span className="goals-hero-gap">
          {anchored && (
            <button type="button" className="goals-hero-reset" onClick={onReset}>Back to {title.toLowerCase()}</button>
          )}
        </span>
        <button
          type="button"
          className="pk-icon-btn goals-hero-btn"
          onClick={onRefresh}
          disabled={syncing}
          aria-label="Sync Strava and reload goals"
          title="Pull new activities from Strava, then reload"
        ><Hi icon={ArrowPathIcon} size={17} className={syncing ? 'spin' : ''} /></button>
        {!empty && (
          <button type="button" className="pk-btn pk-primary goals-hero-add" aria-haspopup="dialog" onClick={onAdd}>
            <Hi icon={PlusIcon} size={16} /> Goal
          </button>
        )}
      </div>
    </section>
  )
}
