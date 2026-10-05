import React, { useCallback, useRef, useState } from 'react'
import { TI, useDismiss } from './ui'
import { IconChevronDown, IconChevronRight, IconCheck } from './icons'

// ChatGPT's "Thinking effort" control: a pill beside the mic that opens a small
// panel — the level's name, and a fat track with one dot per stop and a knob you
// drag or tap. The name is a button too: it flips to a list with a line about
// what each level costs, for when the dots alone don't say enough.

export interface Stop { value: string; label: string; hint?: string }

const HINTS: Record<string, string> = {
  low: 'Quick, for simple questions',
  medium: 'Balanced speed and depth',
  high: 'Takes longer, for harder problems',
  xhigh: 'Works it through carefully',
  max: 'Deepest reasoning; can take minutes',
}
export const hintFor = (effort: string) => HINTS[effort] || ''

export default function ThinkingControl({ stops, value, onChange, label = 'Thinking effort' }: {
  stops: Stop[]
  value: string
  onChange: (value: string) => void
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  useDismiss(open, ref, useCallback(() => { setOpen(false); setList(false) }, []))
  const index = Math.max(0, stops.findIndex((s) => s.value === value))
  const current = stops[index]
  const span = Math.max(1, stops.length - 1)

  function fromPointer(clientX: number) {
    const el = track.current
    if (!el) return
    const r = el.getBoundingClientRect()
    // The knob's centre travels between half a knob in from each end.
    const knob = r.height
    const x = Math.min(Math.max(clientX - r.left - knob / 2, 0), r.width - knob)
    const i = Math.round((x / Math.max(1, r.width - knob)) * span)
    if (stops[i] && stops[i].value !== value) onChange(stops[i].value)
  }

  function onPointerDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    fromPointer(e.clientX)
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); onChange(stops[Math.min(span, index + 1)].value) }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); onChange(stops[Math.max(0, index - 1)].value) }
  }

  const pct = (index / span) * 100
  return (
    <div className="vc-effort" ref={ref}>
      <button type="button" className={`vc-chip ${open ? 'on' : ''}`} onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open} title={`${label}: ${current?.label}`}>
        <span className="vc-chip-label">{label}</span>
        <TI icon={IconChevronDown} size={14} className="vc-chip-caret" />
      </button>
      {open && (
        <div className="vc-effort-pop" role="dialog" aria-label={label}>
          <button type="button" className="vc-effort-name" onClick={() => setList((l) => !l)} aria-expanded={list}>
            {current?.label}
            <TI icon={IconChevronRight} size={15} className={`vc-chev ${list ? 'open' : ''}`} />
          </button>
          {list ? (
            <div className="vc-effort-list">
              {stops.map((s) => (
                <button key={s.value} type="button" onClick={() => { onChange(s.value); setList(false) }} aria-pressed={s.value === value}>
                  <span className="vc-menu-text"><span>{s.label}</span>{s.hint && <small>{s.hint}</small>}</span>
                  {s.value === value && <TI icon={IconCheck} size={16} className="vc-menu-check" />}
                </button>
              ))}
            </div>
          ) : (
            <div
              ref={track}
              className="vc-effort-track"
              role="slider"
              tabIndex={0}
              aria-valuemin={1}
              aria-valuemax={stops.length}
              aria-valuenow={index + 1}
              aria-valuetext={current?.label}
              aria-label={label}
              onPointerDown={onPointerDown}
              onPointerMove={(e) => { if (e.buttons) fromPointer(e.clientX) }}
              onKeyDown={onKey}
              style={{ ['--pos' as any]: pct / 100 }}
            >
              <span className="vc-effort-fill" />
              {stops.map((s, i) => (
                <span key={s.value} className={`vc-effort-dot ${i <= index ? 'lit' : ''}`} style={{ ['--at' as any]: i / span }} />
              ))}
              <span className="vc-effort-knob" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
