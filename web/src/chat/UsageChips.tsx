import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAiUsageLive } from '../useAiUsageLive'
import { ProviderLogo } from './ui'

// The chat header's quota glance: one chip per AI account — the 5-hour window if
// it has one, otherwise its tightest limit — as *headroom* (what's left), the same
// convention as Settings → Usage. Amber under 25%, red under 10%. Live: it rides
// the same stream as the Usage page.
//
// Hover (or focus, or tap on a phone) and the row of pills grows into one panel
// with a column per account. Each pill's logo flies into its column's header —
// a FLIP animation: the panel is laid out at its final size, then every logo is
// moved back to where its pill drew it and released — while the panel's clip
// opens out from the pills' outline and each limit's bar fills in turn.

function pick(meters: any[]) {
  const usable = (meters || []).filter((m) => typeof m.remainingPct === 'number')
  if (!usable.length) return null
  return usable.find((m) => m.windowMinutes === 300) || usable.reduce((a, b) => (b.remainingPct < a.remainingPct ? b : a))
}

function resetLabel(ts?: number) {
  if (!ts) return ''
  const mins = Math.max(0, Math.round((ts - Date.now()) / 60000))
  if (mins < 60) return `Resets in ${mins}m`
  const h = Math.floor(mins / 60)
  return h < 48 ? `Resets in ${h}h ${mins % 60}m` : `Resets ${new Date(ts).toLocaleDateString([], { weekday: 'short' })}`
}

function agoLabel(ts?: number) {
  if (!ts) return 'Not updated yet'
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 1) return 'Updated just now'
  if (mins < 60) return `Updated ${mins}m ago`
  return `Updated ${Math.floor(mins / 60)}h ${mins % 60}m ago`
}

const toneOf = (left: number) => (left < 10 ? 'crit' : left < 25 ? 'low' : '')
const EASE = 'cubic-bezier(.2, .8, .2, 1)'
const OPEN_MS = 420
const CHIP_LOGO = 13
const PANEL_LOGO = 18
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export default function UsageChips({ compact = false }: { compact?: boolean }) {
  const live = useAiUsageLive() as any
  const accounts: any[] = (live?.data?.accounts || []).filter((a: any) => a.status === 'ok' && a.meters?.length)
  const [phase, setPhase] = useState<'closed' | 'open' | 'closing'>('closed')
  const [, tick] = useState(0)
  const rowRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const chipLogos = useRef(new Map<string, HTMLElement>())
  const panelLogos = useRef(new Map<string, HTMLElement>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const running = useRef<Animation[]>([])
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  const shown = compact && accounts.length
    ? [accounts.reduce((a, b) => ((pick(b.meters)?.remainingPct ?? 100) < (pick(a.meters)?.remainingPct ?? 100) ? b : a))]
    : accounts

  // The panel's "Updated 3m ago" lines stay true while it is open.
  useEffect(() => {
    if (phase !== 'open') return
    const id = setInterval(() => tick((n) => n + 1), 20_000)
    return () => clearInterval(id)
  }, [phase])

  /** The panel and its logos animated between the pills' geometry and their own. */
  const morph = useCallback((direction: 'in' | 'out') => {
    const panel = panelRef.current
    const row = rowRef.current
    if (!panel || !row) return []
    running.current.forEach((a) => a.cancel())
    const P = panel.getBoundingClientRect()
    const R = row.getBoundingClientRect()
    // The pills' own corner radius: a 999px one interpolates through an oval.
    const pill = `inset(${R.top - P.top}px ${P.right - R.right}px ${P.bottom - R.bottom}px ${R.left - P.left}px round ${R.height / 2}px)`
    const full = 'inset(0px 0px 0px 0px round 14px)'
    const opts = { duration: OPEN_MS, easing: EASE, fill: 'both' as FillMode, direction: direction === 'in' ? 'normal' as const : 'reverse' as const }
    const anims: Animation[] = [panel.animate([{ clipPath: pill, opacity: 0.6 }, { clipPath: full, opacity: 1 }], opts)]
    for (const [id, el] of panelLogos.current) {
      // A pill hidden on a phone (compact shows one) flies in from the shown one.
      const from = chipLogos.current.get(id) || chipLogos.current.values().next().value
      if (!from) continue
      const a = from.getBoundingClientRect()
      const b = el.getBoundingClientRect()
      const s = CHIP_LOGO / PANEL_LOGO
      const dx = a.left + a.width / 2 - (b.left + b.width / 2)
      const dy = a.top + a.height / 2 - (b.top + b.height / 2)
      anims.push(el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${s})` }, { transform: 'none' }], opts))
    }
    running.current = anims
    return anims
  }, [])

  // Opening: the panel is already in the DOM at its final layout; play it in.
  useLayoutEffect(() => {
    if (phase === 'open' && !reduced()) morph('in')
  }, [phase, morph])

  const open = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setPhase('open'), 90)
  }, [])

  const close = useCallback((now = false) => {
    if (timer.current) clearTimeout(timer.current)
    const run = () => {
      if (phaseRef.current !== 'open') return
      const anims = reduced() ? [] : morph('out')
      if (!anims.length) return setPhase('closed')
      setPhase('closing')
      Promise.all(anims.map((a) => a.finished)).then(() => { if (phaseRef.current === 'closing') setPhase('closed') }, () => {})
    }
    if (now) run()
    else timer.current = setTimeout(run, 160)
  }, [morph])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  // A tap elsewhere or Escape closes it (phones have no "mouse left").
  useEffect(() => {
    if (phase !== 'open') return
    const onDown = (e: PointerEvent) => { if (!rowRef.current?.parentElement?.contains(e.target as Node)) close(true) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(true) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [phase, close])

  if (!accounts.length) return null
  const expanded = phase !== 'closed'

  return (
    <div
      className={`vc-usage-wrap ${expanded ? 'expanded' : ''} ${phase === 'closing' ? 'closing' : ''}`}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') open() }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') close() }}
      onFocus={open}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) close() }}
    >
      <div
        className="vc-usage"
        ref={rowRef}
        role="button"
        tabIndex={0}
        aria-label="AI usage left"
        aria-expanded={expanded}
        onClick={() => (phase === 'open' ? close(true) : setPhase('open'))}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); phase === 'open' ? close(true) : setPhase('open') } }}
      >
        {shown.map((a) => {
          const m = pick(a.meters)
          if (!m) return null
          const left = Math.round(m.remainingPct)
          return (
            <span key={a.id} className={`vc-usage-chip ${toneOf(left)}`}>
              <span className="vc-usage-logo" ref={(el) => { if (el) chipLogos.current.set(a.id, el); else chipLogos.current.delete(a.id) }}>
                <ProviderLogo driver={a.backend} name={a.displayName} size={CHIP_LOGO} />
              </span>
              <span>{left}%</span>
            </span>
          )
        })}
      </div>

      {expanded && (
        <div className="vc-usage-panel" ref={panelRef} role="dialog" aria-label="AI usage by account" style={{ ['--cols' as any]: accounts.length }}>
          {accounts.map((a, col) => (
            <section key={a.id} className="vc-usage-col">
              <header>
                <span className="vc-usage-logo" ref={(el) => { if (el) panelLogos.current.set(a.id, el); else panelLogos.current.delete(a.id) }}>
                  <ProviderLogo driver={a.backend} name={a.displayName} size={PANEL_LOGO} />
                </span>
                <span className="vc-usage-name">
                  <strong>{a.displayName || a.backend}</strong>
                  {a.plan && <small>{a.plan}</small>}
                </span>
              </header>
              {a.meters.filter((m: any) => typeof m.remainingPct === 'number').map((m: any, i: number) => {
                const left = Math.round(m.remainingPct)
                return (
                  <div key={m.key || m.label} className={`vc-usage-meter ${toneOf(left)}`} style={{ ['--d' as any]: `${120 + col * 50 + i * 60}ms` }}>
                    <div className="vc-usage-meter-top">
                      <span>{m.label}</span>
                      <span className="vc-usage-pct">{left}% left</span>
                    </div>
                    <div className="vc-usage-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={left} aria-label={`${m.label}, ${left}% left`}>
                      <i style={{ width: `${Math.max(0, Math.min(100, m.remainingPct))}%` }} />
                    </div>
                    {m.resetsAt && <div className="vc-usage-reset">{resetLabel(m.resetsAt)}</div>}
                  </div>
                )
              })}
              <footer>{agoLabel(a.fetchedAt)}</footer>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
