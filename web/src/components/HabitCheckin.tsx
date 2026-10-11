// The morning check-in (habitCheckin.ts decides what it asks and when). It pops
// up on the first open of the day, on any device, and the Habits tab's "Check in"
// opens it on demand. Yes ticks a habit for that day; No records the answer
// without ticking it, so the habit is not asked about again.
import React, { useCallback, useEffect, useState } from 'react'
import { AuthError, getHabits, logHabit, markHabitCheckin } from '../api'
import { checkinItems, shouldOpenCheckin, type CheckinItem } from '../habitCheckin'
import { Hi, XMarkIcon } from '../icons'
import { pushError } from '../toast'

/** window event: open the check-in now, whatever is pending. */
export const OPEN_HABIT_CHECKIN = 'totem:habit-checkin'

const dayName = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })

function Row({ item, entry, busy, onAnswer }: {
  item: CheckinItem
  entry: any
  busy: boolean
  onAnswer: (item: CheckinItem, yes: boolean) => void
}) {
  const yes = (entry?.count || 0) > 0
  const no = !yes && entry?.skipped === true
  const h = item.habit
  return (
    <div className={`habit-ci-row${yes || no ? ' answered' : ''}`}>
      <span className="habit-dot" style={{ background: h.color }} />
      <div className="habit-ci-name">
        {h.name}
        {item.part === 'yesterday' && h.when === 'night' && <small>last night</small>}
      </div>
      <div className="habit-ci-answer" role="group" aria-label={`${h.name}, ${item.part === 'today' ? 'this morning' : 'yesterday'}`}>
        <button type="button" className={`habit-ci-btn${no ? ' on no' : ''}`} disabled={busy} onClick={() => onAnswer(item, false)}>No</button>
        <button type="button" className={`habit-ci-btn${yes ? ' on yes' : ''}`} style={yes ? { background: h.color, borderColor: h.color } : undefined} disabled={busy} onClick={() => onAnswer(item, true)}>Yes</button>
      </div>
    </div>
  )
}

export default function HabitCheckin({ onAuthError }: { onAuthError: () => void }) {
  const [data, setData] = useState<any>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<Set<string>>(() => new Set())

  // First open of the day: once the app is in front, check whether to pop up.
  const check = useCallback(async () => {
    if (document.visibilityState !== 'visible') return
    try {
      const payload = await getHabits(7)
      if (!shouldOpenCheckin(payload)) return
      setData(payload)
      setOpen(true)
      setData(await markHabitCheckin(payload.today))
    } catch (e) {
      if (e instanceof AuthError) onAuthError()
    }
  }, [onAuthError])
  useEffect(() => {
    check()
    document.addEventListener('visibilitychange', check)
    return () => document.removeEventListener('visibilitychange', check)
  }, [check])

  useEffect(() => {
    const show = async () => {
      try { setData(await getHabits(7)); setOpen(true) } catch (e: any) {
        if (e instanceof AuthError) onAuthError(); else pushError(e?.message || 'Could not load habits')
      }
    }
    window.addEventListener(OPEN_HABIT_CHECKIN, show)
    return () => window.removeEventListener(OPEN_HABIT_CHECKIN, show)
  }, [onAuthError])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const answer = async (item: CheckinItem, yes: boolean) => {
    const key = `${item.habit.id}:${item.date}`
    const current = data?.entries?.[item.date]?.[item.habit.id]
    setBusy((s) => new Set(s).add(key))
    try {
      const fields = yes
        ? { id: item.habit.id, date: item.date, count: Math.max(1, current?.count || 0) }
        : { id: item.habit.id, date: item.date, skipped: true }
      setData(await logHabit(fields))
      window.dispatchEvent(new Event('totem:habits-changed'))
    } catch (e: any) {
      if (e instanceof AuthError) onAuthError(); else pushError(e?.message || 'Could not log that habit')
    } finally {
      setBusy((s) => { const n = new Set(s); n.delete(key); return n })
    }
  }

  if (!open || !data) return null
  // Answered rows stay, ticked, rather than vanishing under the pointer.
  const { yesterday, items } = checkinItems(data, true)
  const parts: { key: CheckinItem['part']; title: string; rows: CheckinItem[] }[] = [
    { key: 'yesterday', title: `Yesterday · ${dayName(yesterday)}`, rows: items.filter((i) => i.part === 'yesterday') },
    { key: 'today', title: 'This morning', rows: items.filter((i) => i.part === 'today') },
  ]
  const left = items.filter((i) => {
    const e = data.entries?.[i.date]?.[i.habit.id]
    return !(e && (e.count > 0 || e.skipped))
  }).length

  return (
    <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="event-modal habit-ci-modal" role="dialog" aria-label="Morning check-in" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-kicker">Habits</div>
            <h2>Morning check-in</h2>
          </div>
          <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close"><Hi icon={XMarkIcon} size={20} /></button>
        </div>
        {!items.length ? (
          <div className="habit-ci-empty">Nothing to answer: yesterday is logged and there are no morning habits.</div>
        ) : parts.filter((p) => p.rows.length).map((p) => (
          <section key={p.key} className="habit-ci-part">
            <div className="habit-ci-title">{p.title}</div>
            {p.rows.map((item) => (
              <Row
                key={`${item.habit.id}:${item.date}`}
                item={item}
                entry={data.entries?.[item.date]?.[item.habit.id]}
                busy={busy.has(`${item.habit.id}:${item.date}`)}
                onAnswer={answer}
              />
            ))}
          </section>
        ))}
        <div className="modal-actions">
          <span className="habit-ci-left">{left ? `${left} to go` : 'All answered'}</span>
          <button type="button" className="btn primary" onClick={() => setOpen(false)}>Done</button>
        </div>
      </div>
    </div>
  )
}
