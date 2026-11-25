import React from 'react'

/**
 * A progress ring, the app's Ring (mobile/src/features/goals/Ring.tsx): the arc runs
 * clockwise from 12 o'clock and eases to each new value (no ease under Reduce Motion,
 * kit.css). Whatever is passed as children sits in the middle.
 */
export default function Ring({ percent, color, size = 44, stroke = 4, track = 'var(--bg-3)', children, label }: {
  /** 0–100; null draws the empty track. */
  percent: number | null
  color: string
  size?: number
  stroke?: number
  track?: string
  children?: React.ReactNode
  /** Read out in place of the drawing; without it the ring is decoration. */
  label?: string
}) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(100, percent ?? 0))
  return (
    <span className="pk-ring" style={{ width: size, height: size }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <svg width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        {p > 0 && (
          <circle
            cx={size / 2} cy={size / 2} r={r}
            stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={c * (1 - p / 100)}
          />
        )}
      </svg>
      {children != null && <span className="pk-ring-in">{children}</span>}
    </span>
  )
}
