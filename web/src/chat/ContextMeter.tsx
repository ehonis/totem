import React, { useRef, useState } from 'react'
import { contextLabel, contextTooltip, contextValue, type ContextSnapshot } from './context'
import { useDismiss } from './ui'

// How full the chat's context window is (T3 Code's context row): a thin bar in the
// composer's footer with "45k / 1m" beside it, amber from 80% and red from 90%, and
// a tick where Claude compacts when that is set below the window. Hover, focus or
// tap it for the exact numbers. Drawn only once the provider has reported usage.
export default function ContextMeter({ s }: { s: ContextSnapshot }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useDismiss(open, ref, () => setOpen(false))
  const lines = contextTooltip(s)
  const tick = s.max && s.autoCompactAt ? (s.autoCompactAt / s.max) * 100 : null
  return (
    <span ref={ref} className={`vc-ctx ${open ? 'open' : ''} ${s.tone ? `tone-${s.tone}` : ''}`} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="vc-ctx-chip" aria-label={`Context: ${contextLabel(s)}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {s.percent != null && (
          <span className="vc-ctx-track" aria-hidden>
            <span className="vc-ctx-fill" style={{ width: `max(${s.percent}%, 3px)` }} />
            {tick != null && <span className="vc-ctx-tick" style={{ left: `${tick}%` }} />}
          </span>
        )}
        <span className="vc-ctx-value">{contextValue(s)}</span>
      </button>
      <span className="vc-ctx-tip" role="tooltip">
        {lines.map((l, i) => <span key={i} className={i ? '' : 'vc-ctx-tip-head'}>{l}</span>)}
      </span>
    </span>
  )
}
