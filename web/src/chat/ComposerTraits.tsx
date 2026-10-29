import React, { useCallback, useRef, useState } from 'react'
import { TI, useDismiss } from './ui'
import { IconLock, IconLockOpen, IconPencilCheck, IconSparkles } from './icons'
import type { Access } from './types'

// The muted half of the composer's model chip ("Opus 5.5 Medium"), after T3 Code's
// traits menu: reasoning effort on a slider (ChatGPT's "Thinking effort"), then
// the chat's access as a row of four, with what the picked one allows underneath.

export interface Stop { value: string; label: string; hint?: string }

const HINTS: Record<string, string> = {
  low: 'Quick, for simple questions',
  medium: 'Balanced speed and depth',
  high: 'Takes longer, for harder problems',
  xhigh: 'Works it through carefully',
  max: 'Deepest reasoning; can take minutes',
}
export const hintFor = (effort: string) => HINTS[effort] || ''

// The bridge runs every CLI in print mode, which cannot stop to ask, so "asks"
// here means the action is refused (providers/claude-tools.mjs › ACCESS_MODES).
// Connector tools are governed separately, by Settings → Connections.
export const ACCESS_MODES: { id: Access; label: string; hint: string; icon: any }[] = [
  { id: 'supervised', label: 'Supervised', hint: 'Read and use connectors. Commands and file changes are refused.', icon: IconLock },
  { id: 'edits', label: 'Auto-accept edits', hint: 'File edits go through; commands are refused.', icon: IconPencilCheck },
  { id: 'auto', label: 'Auto', hint: 'Providers that can judge routine actions approve them; anything else is refused.', icon: IconSparkles },
  { id: 'full', label: 'Full access', hint: 'Commands and edits without prompts.', icon: IconLockOpen },
]

export default function ComposerTraits({ effort, access, onAccess }: {
  /** The picked model's effort levels; absent when it has none. */
  effort?: { stops: Stop[]; value: string; onChange: (value: string) => void }
  access?: Access
  onAccess: (v: Access) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, ref, useCallback(() => setOpen(false), []))
  const mode = ACCESS_MODES.find((m) => m.id === access) || ACCESS_MODES[3]
  const stop = effort ? effort.stops[Math.max(0, effort.stops.findIndex((s) => s.value === effort.value))] : null
  const restricted = mode.id !== 'full'
  const title = [stop && `Thinking effort: ${stop.label}`, `Access: ${mode.label}`].filter(Boolean).join(' · ')
  return (
    <div className="vc-traits" ref={ref}>
      <button type="button" className={`vc-traits-chip ${open ? 'on' : ''}`} onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open} title={title}>
        {/* Access left the composer for this menu: a chat that is not on Full access still shows it here. */}
        {(restricted || !stop) && <TI icon={mode.icon} size={14} className={restricted ? 'vc-traits-warn' : undefined} />}
        <span className="vc-chip-label">{stop ? stop.label : mode.label}</span>
      </button>
      {open && (
        <div className="vc-traits-pop" role="dialog" aria-label="Reasoning and access">
          {effort && stop && (
            <>
              <div className="vc-traits-label">Reasoning</div>
              <EffortSlider {...effort} />
              <div className="vc-traits-current">
                <span>{stop.label}</span>
                {stop.hint && <small>{stop.hint}</small>}
              </div>
              <div className="vc-traits-sep" />
            </>
          )}
          <div className="vc-traits-label">Permissions</div>
          <div className="vc-traits-seg" role="radiogroup" aria-label="Access">
            {ACCESS_MODES.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={m.id === mode.id} aria-label={m.label} title={m.label}
                className={m.id === mode.id ? 'on' : ''} onClick={() => onAccess(m.id)}>
                <TI icon={m.icon} size={16} />
              </button>
            ))}
          </div>
          <div className="vc-traits-current">
            <span>{mode.label}</span>
            <small>{mode.hint}</small>
          </div>
        </div>
      )}
    </div>
  )
}

/** A fat track with one dot per stop and a knob you drag or tap. */
function EffortSlider({ stops, value, onChange }: { stops: Stop[]; value: string; onChange: (value: string) => void }) {
  const track = useRef<HTMLDivElement>(null)
  const index = Math.max(0, stops.findIndex((s) => s.value === value))
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

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); onChange(stops[Math.min(span, index + 1)].value) }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); onChange(stops[Math.max(0, index - 1)].value) }
  }

  return (
    <div
      ref={track}
      className="vc-effort-track"
      role="slider"
      tabIndex={0}
      aria-valuemin={1}
      aria-valuemax={stops.length}
      aria-valuenow={index + 1}
      aria-valuetext={stops[index]?.label}
      aria-label="Thinking effort"
      onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); fromPointer(e.clientX) }}
      onPointerMove={(e) => { if (e.buttons) fromPointer(e.clientX) }}
      onKeyDown={onKey}
      style={{ ['--pos' as any]: index / span }}
    >
      <span className="vc-effort-fill" />
      {stops.map((s, i) => (
        <span key={s.value} className={`vc-effort-dot ${i <= index ? 'lit' : ''}`} style={{ ['--at' as any]: i / span }} />
      ))}
      <span className="vc-effort-knob" />
    </div>
  )
}
