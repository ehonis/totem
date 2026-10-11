import React, { useMemo, useRef, useState } from 'react'
import { useDismiss } from './ui'
import { snoozePresets, customSnooze, HOUR_MS } from './settle'

const pad = (n: number) => String(n).padStart(2, '0')
const dateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const timeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/** "Date and time" or "Duration", as in T3's custom snooze dialog. */
function CustomForm({ onSnooze, onCancel }: { onSnooze: (until: number) => void; onCancel: () => void }) {
  const start = useMemo(() => new Date(Date.now() + HOUR_MS), [])
  const [mode, setMode] = useState<'date' | 'duration'>('date')
  const [date, setDate] = useState(dateValue(start))
  const [time, setTime] = useState(timeValue(start))
  const [amount, setAmount] = useState('2')
  const [unit, setUnit] = useState<'minutes' | 'hours' | 'days'>('hours')
  const [error, setError] = useState('')
  function submit(e: React.FormEvent) {
    e.preventDefault()
    const out = customSnooze(mode === 'date' ? { mode, date, time } : { mode, amount: Number(amount), unit }, Date.now())
    if ('error' in out) setError(out.error)
    else onSnooze(out.until)
  }
  return (
    <form className="vc-snooze-custom" onSubmit={submit}>
      <div className="vc-snooze-modes" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'date'} className={mode === 'date' ? 'on' : ''} onClick={() => { setMode('date'); setError('') }}>Date and time</button>
        <button type="button" role="tab" aria-selected={mode === 'duration'} className={mode === 'duration' ? 'on' : ''} onClick={() => { setMode('duration'); setError('') }}>Duration</button>
      </div>
      {mode === 'date' ? (
        <div className="vc-snooze-fields">
          <input type="date" value={date} min={dateValue(new Date())} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />
        </div>
      ) : (
        <div className="vc-snooze-fields">
          <input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Snooze for" autoFocus />
          <select value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)} aria-label="Unit">
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
            <option value="days">Days</option>
          </select>
        </div>
      )}
      {error && <div className="vc-snooze-error">{error}</div>}
      <div className="vc-snooze-actions">
        <button type="button" className="vc-btn sm ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="vc-btn sm primary">Snooze</button>
      </div>
    </form>
  )
}

/** The snooze popover: T3's presets with their wake times, then Custom…. */
export default function SnoozeMenu({ onSnooze, onClose }: { onSnooze: (until: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [custom, setCustom] = useState(false)
  // Worked out when the menu opens, so "In 1 hour" means an hour from now.
  const presets = useMemo(() => snoozePresets(new Date()), [])
  useDismiss(true, ref, onClose)
  const pick = (until: number) => { onClose(); onSnooze(until) }
  return (
    <div className="vc-menu vc-thread-menu vc-snooze-menu" ref={ref} role="menu" onClick={(e) => e.stopPropagation()}>
      {custom ? <CustomForm onSnooze={pick} onCancel={() => setCustom(false)} /> : (
        <>
          {presets.map((p) => (
            <button key={p.id} type="button" role="menuitem" onClick={() => pick(p.until)} title={new Date(p.until).toLocaleString()}>
              <span className="vc-snooze-label">{p.label}</span>
              <span className="vc-snooze-when">{p.when}</span>
            </button>
          ))}
          <div className="vc-menu-sep" />
          <button type="button" role="menuitem" onClick={() => setCustom(true)}><span className="vc-snooze-label">Custom…</span></button>
        </>
      )}
    </div>
  )
}
