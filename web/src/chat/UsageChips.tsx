import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAiUsageLive } from '../useAiUsageLive'
import {
  accountTone,
  fableMeter,
  mainMeters,
  pillText,
  poolScore,
  poolSentence,
  poolSubtitle,
  providerGroups,
  shortName,
  shortWindow,
  stateLabel,
  toneOf,
  whenLabel,
  type ProviderGroup,
  type UsageAccount,
} from '../usagePools'
import { ProviderLogo } from './ui'

// The chat header's quota glance: one pill per provider. Its number is what the
// next request can get (the best usable account's headroom, ai-usage/pools.mjs),
// or how long until one is back when none can serve. With several accounts behind
// CLIProxy, a dot per account under the number says how many are fine, low, spent
// or off, so "two accounts, one dead" reads without a pill each. Live: it rides the
// same stream as Settings › Usage.
//
// Hover (or focus, or tap on a phone) and the pills grow into one panel with a
// column per provider and a row per account, each window on its own line under
// the account's name (short, then weekly, then Claude's Fable tier). Each pill's logo flies into its column's header (FLIP:
// the panel is laid out at its final size, then every logo is moved back to where
// its pill drew it and released) while the panel's clip opens out from the pills.
//
// On desktop the same pills also stand in the rail, stacked above Settings, on
// every page but the chat (whose header has them). There the panel opens to the right.

function agoLabel(ts?: number) {
  if (!ts) return 'Not updated yet'
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 1) return 'Updated just now'
  if (mins < 60) return `Updated ${mins}m ago`
  return `Updated ${Math.floor(mins / 60)}h ${mins % 60}m ago`
}

const EASE = 'cubic-bezier(.2, .8, .2, 1)'
const OPEN_MS = 420
const CHIP_LOGO = 13
const PANEL_LOGO = 18
const MAX_DOTS = 6
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function Dots({ group }: { group: ProviderGroup }) {
  if (group.accounts.length < 2) return null
  const shown = group.accounts.slice(0, MAX_DOTS)
  return (
    <span className="vc-usage-dots" aria-hidden>
      {shown.map((a) => <i key={a.id} className={`s-${a.state || 'ok'}`} />)}
    </span>
  )
}

function AccountRow({ account, siblings, delay }: { account: UsageAccount; siblings: UsageAccount[]; delay: number }) {
  // A lone account's plan is already the column's subtitle.
  const single = siblings.length === 1
  const now = Date.now()
  const label = stateLabel(account, now)
  const tone = accountTone(account)
  const meters = account.state === 'disabled' ? [] : mainMeters(account)
  // Two windows of the same length (Cursor's monthly ones) are told apart by name.
  const keys = meters.map(shortWindow)
  const tag = (m: (typeof meters)[number], i: number) => (keys.length > 1 && keys[0] === keys[1] ? m.label.replace(/ (limit|usage)$/i, '').split(' ')[0] : keys[i])
  // Claude's Fable tier is a weekly cap of its own, on the line under the weekly window.
  const fable = account.state === 'disabled' ? undefined : fableMeter(account)
  const minis = [...meters.map((m, i) => ({ m, k: tag(m, i) })), ...(fable ? [{ m: fable, k: 'Fable' }] : [])]
  return (
    <div className={`vc-usage-acct ${tone} ${account.stale ? 'stale' : ''}`} style={{ ['--d' as any]: `${delay}ms` }}>
      <div className="vc-usage-acct-top">
        <span className="vc-usage-acct-name" title={account.email || account.displayName || account.label}>
          {account.servingRecently && account.state !== 'disabled' && <i className="vc-usage-live" aria-label="In use" />}
          {shortName(account, siblings)}
        </span>
        <span className="vc-usage-acct-state">{label || (single ? '' : account.plan || '')}</span>
      </div>
      {minis.length > 0 && (
        <div className="vc-usage-minis">
          {minis.map(({ m, k }) => {
            const left = Math.max(0, Math.min(100, Math.round(m.remainingPct as number)))
            const t = left < 2 ? 'crit' : left < 25 ? 'low' : ''
            return (
              <div key={m.key || m.label} className={`vc-usage-mini ${t}`} title={`${m.label}: ${left}% left${m.resetsAt ? `, resets ${whenLabel(m.resetsAt, now)}` : ''}`}>
                <span className="vc-usage-mini-k">{k}</span>
                <span className="vc-usage-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={left} aria-label={`${m.label}, ${left}% left`}>
                  <i style={{ width: `${left}%` }} />
                </span>
                <span className="vc-usage-mini-v">{left}%</span>
              </div>
            )
          })}
        </div>
      )}
      {account.state === 'error' && account.error && !account.authProblem && <div className="vc-usage-reset">{account.error}</div>}
    </div>
  )
}

/** The pill a narrow header keeps: the tightest provider's (the only one, when there is one). */
const leadOf = (groups: ProviderGroup[]) => (groups.length ? groups.reduce((a, b) => (poolScore(b) < poolScore(a) ? b : a)) : null)

/** What the folded pill says, for the chat header's "…" row once even that pill has gone into it. */
export function useUsageSummary(): { text: string; tone: string; label: string } | null {
  const live = useAiUsageLive() as any
  const groups = providerGroups(live?.data)
  const lead = leadOf(groups)
  const proxy = live?.data?.proxy
  if (!lead) {
    // The pill's "!" when CLIProxy is set up and not answering.
    if (proxy?.configured && proxy.reachable === false) return { text: '!', tone: 'crit', label: proxy.code === 'bad_key' ? 'CLIProxy refused the management key' : 'CLIProxy is not answering' }
    return null
  }
  const now = Date.now()
  return { text: pillText(lead, now), tone: toneOf(lead), label: groups.map((g) => poolSentence(g, now)).join('. ') }
}

export default function UsageChips({ rail = false, onManage, foldInto }: { rail?: boolean; onManage?: () => void; foldInto?: string }) {
  const live = useAiUsageLive() as any
  const groups = providerGroups(live?.data)
  const proxy = live?.data?.proxy
  const proxyDown = proxy?.configured && proxy.reachable === false
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

  // When the chat header is too narrow for a pill each (chat/headerFold.ts), only
  // the tightest provider's stays, with "+N" when there are others.
  const lead = leadOf(groups)?.backend

  // "Updated 3m ago" and "back in 20m" stay true while it is open; the pills'
  // own countdowns move once a minute.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), phase === 'open' ? 20_000 : 60_000)
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
      // A pill folded away (a narrow header shows one) flies in from the one still shown.
      const from = [chipLogos.current.get(id), ...chipLogos.current.values()].find((el) => el && el.getClientRects().length)
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
  // It hangs left from the pills' right edge, so in the chat header it may use only
  // the chat column to their left: a narrow column (a side panel beside it) gets its
  // providers stacked in one column instead of a grid running under the chats panel.
  useLayoutEffect(() => {
    if (phase !== 'open') return
    const panel = panelRef.current
    const row = rowRef.current
    if (panel && row && !rail) {
      const column = row.closest('.vc')?.getBoundingClientRect()
      const room = row.getBoundingClientRect().right + 8 - Math.max(column?.left ?? 0, 0) - 8
      panel.style.setProperty('--usage-room', `${Math.max(0, Math.floor(room))}px`)
      panel.classList.toggle('stacked', room < groups.length * 236 + 14)
    }
    if (!reduced()) morph('in')
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
    // Its Escape is its own: a side panel beside the chat stays open (chat/escape.ts).
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(true) } }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [phase, close])

  // Set up, never read, and not answering: say so rather than show nothing.
  if (!groups.length && proxyDown) {
    const why = proxy?.code === 'bad_key' ? 'CLIProxy refused the management key' : 'CLIProxy is not answering'
    return (
      <div className={`vc-usage-wrap ${rail ? 'rail' : ''}`} data-fold-into={foldInto}>
        <div className="vc-usage stale" role="button" tabIndex={0} title={why} aria-label={why} onClick={onManage}>
          <span className="vc-usage-chip crit"><span className="vc-usage-num"><span>!</span></span></span>
        </div>
      </div>
    )
  }
  if (!groups.length) return null
  const expanded = phase !== 'closed'
  const now = Date.now()
  const label = groups.map((g) => poolSentence(g, now)).join('. ') + (proxyDown ? '. CLIProxy is not answering; these are its last readings.' : '')

  return (
    <div
      className={`vc-usage-wrap ${rail ? 'rail' : ''} ${expanded ? 'expanded' : ''} ${phase === 'closing' ? 'closing' : ''}`}
      data-fold-into={foldInto}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') open() }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') close() }}
      onFocus={open}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) close() }}
    >
      <div
        className={`vc-usage ${proxyDown ? 'stale' : ''}`}
        ref={rowRef}
        role="button"
        tabIndex={0}
        aria-label={label}
        title={label}
        aria-expanded={expanded}
        onClick={() => (phase === 'open' ? close(true) : setPhase('open'))}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); phase === 'open' ? close(true) : setPhase('open') } }}
      >
        {groups.map((g) => (
          <span key={g.backend} className={`vc-usage-chip ${toneOf(g)} ${g.accounts.length > 1 ? 'pooled' : ''} ${g.backend === lead ? 'lead' : ''}`}>
            <span className="vc-usage-logo" ref={(el) => { if (el) chipLogos.current.set(g.backend, el); else chipLogos.current.delete(g.backend) }}>
              <ProviderLogo driver={g.backend} name={g.name} size={CHIP_LOGO} />
            </span>
            <span className="vc-usage-num">
              <span>{pillText(g, now)}</span>
              <Dots group={g} />
            </span>
            {g.backend === lead && groups.length > 1 && <span className="vc-usage-more" aria-hidden>+{groups.length - 1}</span>}
          </span>
        ))}
      </div>

      {expanded && (
        <div className="vc-usage-panel" ref={panelRef} role="dialog" aria-label="AI usage by provider" style={{ ['--cols' as any]: groups.length }}>
          {proxyDown && (
            <div className="vc-usage-banner">CLIProxy is not answering. These are its last readings.</div>
          )}
          {groups.map((g, col) => (
            <section key={g.backend} className="vc-usage-col">
              <header>
                <span className="vc-usage-logo" ref={(el) => { if (el) panelLogos.current.set(g.backend, el); else panelLogos.current.delete(g.backend) }}>
                  <ProviderLogo driver={g.backend} name={g.name} size={PANEL_LOGO} />
                </span>
                <span className="vc-usage-name">
                  <strong>{g.name}</strong>
                  <small>{poolSubtitle(g, now)}</small>
                </span>
              </header>
              {g.accounts.map((a, i) => (
                <AccountRow key={a.id} account={a} siblings={g.accounts} delay={120 + col * 50 + i * 60} />
              ))}
              <footer>{agoLabel(Math.max(...g.accounts.map((a) => a.fetchedAt || 0)) || undefined)}</footer>
            </section>
          ))}
          {onManage && (
            <button type="button" className="vc-usage-manage" onClick={() => { close(true); onManage() }}>
              Manage accounts
            </button>
          )}
        </div>
      )}
    </div>
  )
}
