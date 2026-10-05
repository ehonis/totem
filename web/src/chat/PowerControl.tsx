import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { TI, ProviderLogo, useDismiss } from './ui'
import { IconChevronDown } from './icons'
import { POWER_NAMES, POWER_HINTS } from './models'

// Auto's power dial. In Auto the thing to choose is not a model but how much to
// throw at the message — one score covering which model and how hard it thinks
// (chat/route.mjs › LADDER). The pill always says what it will use, live as you
// type ("Sonnet 5.5 · Balanced"), so there's no waiting for the reply to find
// out; tap it for a five-stop slider. Unset, Auto reads the message and the
// first reply fixes the chat's power; after that it's the chat's until moved.

export interface RoutePreview {
  provider: string
  driver: string
  providerName: string
  modelName: string
  effort: string | null
  power: number
  powerAuto: boolean
  reason: string
}

const STOPS = ['1', '2', '3', '4', '5']

/** Ask the bridge what Auto would do — debounced, latest wins. */
export function useRoutePreview({ enabled, threadId, text, attachments, mode, power }: {
  enabled: boolean; threadId: string | null; text: string; attachments: number; mode: string; power?: string
}) {
  const [preview, setPreview] = useState<RoutePreview | null>(null)
  const seq = useRef(0)
  useEffect(() => {
    if (!enabled) { setPreview(null); return }
    const id = ++seq.current
    const t = setTimeout(() => {
      api<{ route: RoutePreview | null }>('/api/chat/route', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId, text, attachments, mode, preset: 'auto', ...(power ? { power: Number(power) } : {}) }),
      }).then((r) => { if (id === seq.current) setPreview(r.route) }).catch(() => {})
    }, text ? 350 : 0)
    return () => clearTimeout(t)
  }, [enabled, threadId, text, attachments, mode, power])
  return preview
}

/** "Claude Sonnet 5.5" → "Sonnet 5.5": the pill has room for the model, not the brand. */
const shortModel = (name: string) => name.replace(/^(Claude|GPT)\s+/i, (m) => (/gpt/i.test(m) ? 'GPT ' : '')).trim()

export default function PowerControl({ power, preview, onChange }: {
  /** The chosen power, '' when Auto is still reading the message. */
  power: string
  preview: RoutePreview | null
  onChange: (power: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  useDismiss(open, ref, useCallback(() => setOpen(false), []))
  const shown = power || String(preview?.power || 2)
  const index = STOPS.indexOf(shown)
  const span = STOPS.length - 1

  function fromPointer(clientX: number) {
    const el = track.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const knob = r.height
    const x = Math.min(Math.max(clientX - r.left - knob / 2, 0), r.width - knob)
    const v = STOPS[Math.round((x / Math.max(1, r.width - knob)) * span)]
    if (v && v !== power) onChange(v)
  }
  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); onChange(STOPS[Math.min(span, index + 1)]) }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); onChange(STOPS[Math.max(0, index - 1)]) }
  }

  const name = POWER_NAMES[shown]
  const title = preview ? `${preview.providerName} · ${preview.modelName}${preview.effort ? ` · ${preview.effort} effort` : ''}` : 'Auto'
  return (
    <div className="vc-effort vc-power" ref={ref}>
      <button type="button" className={`vc-chip vc-power-chip ${open ? 'on' : ''} ${preview ? '' : 'pending'}`} onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open} title={`Power: ${name}. ${title}`}>
        {preview && <ProviderLogo driver={preview.driver} name={preview.providerName} size={14} />}
        <span className="vc-chip-label">
          {preview ? <span className="vc-power-model">{shortModel(preview.modelName)}</span> : null}
          <span className="vc-power-name">{name}{!power && preview?.powerAuto ? <small> · auto</small> : null}</span>
        </span>
        <TI icon={IconChevronDown} size={14} className="vc-chip-caret" />
      </button>
      {open && (
        <div className="vc-effort-pop vc-power-pop" role="dialog" aria-label="Power">
          <div className="vc-power-head">
            <span className="vc-effort-name as-text">{name}</span>
            <span className="vc-power-hint">{POWER_HINTS[shown]}</span>
          </div>
          <div
            ref={track}
            className="vc-effort-track"
            role="slider"
            tabIndex={0}
            aria-valuemin={1}
            aria-valuemax={5}
            aria-valuenow={index + 1}
            aria-valuetext={name}
            aria-label="Power"
            onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); fromPointer(e.clientX) }}
            onPointerMove={(e) => { if (e.buttons) fromPointer(e.clientX) }}
            onKeyDown={onKey}
            style={{ ['--pos' as any]: index / span }}
          >
            <span className="vc-effort-fill" />
            {STOPS.map((s, i) => <span key={s} className={`vc-effort-dot ${i <= index ? 'lit' : ''}`} style={{ ['--at' as any]: i / span }} />)}
            <span className="vc-effort-knob" />
          </div>
          <div className="vc-power-ends"><span>Quick</span><span>Max</span></div>
          {preview && (
            <div className="vc-power-uses">
              <ProviderLogo driver={preview.driver} name={preview.providerName} size={15} />
              <span><strong>{preview.modelName}</strong>{preview.effort ? ` at ${preview.effort} effort` : ''}</span>
            </div>
          )}
          {power ? (
            <button type="button" className="vc-power-reset" onClick={() => { onChange(''); setOpen(false) }}>Let Auto decide</button>
          ) : (
            <p className="vc-power-note">Auto picked this from your message{preview?.reason ? ` (${preview.reason})` : ''}. Move the dial to change it; the chat keeps your choice.</p>
          )}
        </div>
      )}
    </div>
  )
}
