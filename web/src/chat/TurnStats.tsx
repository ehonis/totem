import React, { useLayoutEffect, useRef, useState } from 'react'
import type { ChatMessage } from './types'
import { EFFORT_LABELS, LEVEL_NAMES, POWER_NAMES, parseModelSpec } from './models'
import { formatDuration, useDismiss } from './ui'

// The line under a reply stays short (the account's logo, lane · model). Hovering it, or
// tapping it on a phone, grows the chip's own background into a card holding what the reply ran on and how it went: the
// setting and effort, speed, time to first token, tokens and cost — whatever the
// CLI reported (chat/stats.mjs); a number it did not report is left out.

const tokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const seconds = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : formatDuration(ms))

/** What the turn was set to: Auto's power, the Thinking level, Instant, or a hand-picked model. */
function setting(m: ChatMessage) {
  if (m.power) return `Auto · ${POWER_NAMES[String(m.power)] || m.power}`
  if (m.route === 'thinking') return `Thinking${m.level ? ` · ${LEVEL_NAMES[String(m.level)] || m.level}` : ''}`
  if (m.route === 'instant') return 'Instant'
  return 'Manual'
}

export function turnRows(m: ChatMessage, modelName?: string, account?: string): [string, string][] {
  const s = m.stats || {}
  // Cursor carries effort and speed inside the model id ("composer-2.5[fast=true,effort=high]").
  const spec = m.model?.includes('[') ? parseModelSpec(m.model) : null
  const effort = m.effort || (spec && spec.effort !== 'default' ? spec.effort : '')
  const rows: [string, string][] = [['Setting', setting(m)]]
  if (effort) rows.push(['Effort', EFFORT_LABELS[effort] || effort])
  if (account) rows.push(['Account', account])
  if (spec && spec.speed !== 'default') rows.push(['Mode', spec.speed === 'fast' ? 'Fast' : 'Quality'])
  if (m.model) rows.push(['Model', modelName && modelName !== m.model.split('[')[0] ? `${modelName} (${m.model.split('[')[0]})` : m.model.split('[')[0]])
  if (s.tps) rows.push(['Speed', `${s.tps >= 100 ? Math.round(s.tps) : s.tps} tok/s`])
  if (s.ttftMs) rows.push(['First token', seconds(s.ttftMs)])
  if (m.durationMs) rows.push(['Total', seconds(m.durationMs)])
  if (s.input != null) rows.push(['Input', `${tokens(s.input)}${s.cached ? ` · ${tokens(s.cached)} cached` : ''}`])
  if (s.output != null) rows.push(['Output', `${tokens(s.output)}${s.reasoning ? ` · ${tokens(s.reasoning)} thinking` : ''}`])
  if (s.tools) rows.push(['Tools', String(s.tools)])
  if (s.costUsd) rows.push(['Cost', s.costUsd < 0.01 ? `$${s.costUsd.toFixed(4)}` : `$${s.costUsd.toFixed(2)}`])
  return rows
}

export default function TurnStats({ m, modelName, account, children }: { m: ChatMessage; modelName?: string; account?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [up, setUp] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  useDismiss(open, ref, () => setOpen(false))
  // The card starts as exactly the chip's box, so it needs the chip's size (--chip-w/h).
  useLayoutEffect(() => {
    const el = chip.current
    if (!el) return
    const size = () => {
      ref.current?.style.setProperty('--chip-w', `${el.offsetWidth}px`)
      ref.current?.style.setProperty('--chip-h', `${el.offsetHeight}px`)
    }
    size()
    const ro = new ResizeObserver(size)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // The card grows down, unless the chat has no room for it below the chip (the last reply).
  const place = () => {
    const el = chip.current
    const pane = el?.closest('.vc-scroll')
    if (el && pane) setUp(pane.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom < 260)
  }
  const rows = turnRows(m, modelName, account)
  return (
    <span ref={ref} className={`vc-meta vc-turn ${open ? 'open' : ''} ${up ? 'up' : ''}`} onMouseEnter={place} onMouseLeave={() => setOpen(false)}>
      <button ref={chip} type="button" className="vc-turn-chip" onFocus={place} onClick={() => { place(); setOpen((o) => !o) }} aria-expanded={open} aria-label="Reply details">
        {children}
      </button>
      <span className="vc-turn-panel" role="tooltip">
        {rows.map(([k, v]) => (
          <span key={k} className="vc-turn-row"><span className="vc-turn-k">{k}</span><span className="vc-turn-v">{v}</span></span>
        ))}
      </span>
    </span>
  )
}
