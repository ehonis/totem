import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useChat, ensureModels, providerById, toggleFavorite } from './store'
import { settingsForPick, visibleModels } from './models'
import { handoffNote } from './handoff'
import { ACCESS_MODES, accessMode, effortFor, speedFor, speedSetting } from './traits'
import type { Access, ModelRow, ModelSettings } from './types'
import { TI, ProviderLogo, useDismiss, usePopoverPlacement } from './ui'
import { IconBolt, IconCheck, IconChevronDown, IconChevronRight, IconChevronUp, IconSearch } from './icons'
import { StarIcon, StarSolidIcon, Hi } from '../icons'

// The composer's model chip and its picker, shaped like T3 Code's: a rail of
// sources down the left (favourites, then one logo per account), a search box and
// rows with the source underneath, a ⌘-number and a star. Models the Providers tab
// hides are not dropped but folded under "Legacy models", so nothing that can run
// is unreachable. In the composer (`traits`) the same panel also carries the
// current model's reasoning levels in a column on the right and a footer with its
// speed and the chat's access, so one chip ("GPT 6.1 Sol · Low") holds all of it.
// Elsewhere (a project's or a totem's default model) it picks the model only.
//
// The panel is portalled to <body> and placed against the window
// (usePopoverPlacement): inside the chat's scroller it opened shifted and clipped.

type Tab = 'favorites' | string

interface Row {
  key: string
  provider: string
  model?: ModelRow
  title: string
  source: string
  sourceDriver?: string
  badge?: string
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

function findModel(models: Record<string, ModelRow[]>, provider: string, id: string) {
  return (models[provider] || []).find((x) => x.id === id)
}

export function chipLabel(settings: ModelSettings, provider: string, models: Record<string, ModelRow[]>) {
  const row = providerById(provider)
  return findModel(models, provider, settings.modelId)?.name || row?.name || provider
}

export default function ModelPicker({ provider, settings, onChange, started = false, locked = false, align = 'start', traits = false, compact = false }: {
  provider: string
  settings: ModelSettings
  onChange: (patch: { provider: string; modelSettings: ModelSettings }) => void
  /** The chat has started: picking another account hands it over (chat/handoff.ts). */
  started?: boolean
  /** A started temporary chat: the bridge holds it to the default account. */
  locked?: boolean
  /** 'end': the chip sits at the composer's right (T3 Code's), so the picker opens leftward from it. */
  align?: 'start' | 'end'
  /** The composer's picker: reasoning, speed and access beside the model. */
  traits?: boolean
  /** The chip names the model only (the composer is busy with answer buttons). */
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('favorites')
  const [q, setQ] = useState('')
  const [legacy, setLegacy] = useState(false)
  const [sel, setSel] = useState(0)
  const [accessOpen, setAccessOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const accessBtn = useRef<HTMLButtonElement>(null)
  const accessMenu = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const providers = useChat((s) => s.providers)
  const models = useChat((s) => s.models)
  const caps = useChat((s) => s.caps)
  const defaultProvider = useChat((s) => s.defaultProvider)
  const defaultModel = useChat((s) => s.defaultModel)
  // Focus goes back to the chip unless the owner clicked somewhere else.
  const close = useCallback((how?: 'outside' | 'escape') => {
    setOpen(false)
    setAccessOpen(false)
    if (how !== 'outside') ref.current?.querySelector<HTMLButtonElement>('.vc-model-chip')?.focus()
  }, [])
  // While the access menu is open, a click outside or Escape closes only it.
  const dismissRefs = useMemo(() => [ref, pop], [])
  const accessRefs = useMemo(() => [accessBtn, accessMenu], [])
  useDismiss(open && !accessOpen, dismissRefs, close)
  useDismiss(accessOpen, accessRefs, useCallback((how: 'outside' | 'escape') => {
    setAccessOpen(false)
    if (how === 'escape') accessBtn.current?.focus()
  }, []))

  const row = providerById(provider)
  const current = findModel(models, provider, settings.modelId)
  const effort = traits ? effortFor(current, settings) : null
  const speed = traits ? speedFor(row?.driver, settings) : null
  const access = accessMode(settings.access)
  const restricted = access.id !== 'full'

  // Up from the chip when there is room; down (or shorter) when the composer sits
  // high on the page, as on an empty chat or a project's home. At the composer's
  // right it lines up with the end of the chip. Wider when the reasoning column shows,
  // or may (the account's catalogue is still loading), so it does not widen while open.
  const loading = !!row?.supportsModelPicker && models[provider] === undefined
  const width = traits && (effort || loading) ? 740 : 560
  const height = traits ? 460 : 440
  const placement = usePopoverPlacement(open, ref, align === 'end'
    ? { width, height, align, offsetX: 4 }
    : { width, height, offsetX: -46 })
  const accessPlacement = usePopoverPlacement(accessOpen, accessBtn, { width: 300, height: 340, gap: 6, align: 'end', narrow: 0, minHeight: 120, fit: true })

  const lockedTo: null | string = locked ? provider : null
  const ordered = useMemo(() => [...providers]
    .sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0))
    .filter((p) => !lockedTo || p.id === lockedTo), [providers, lockedTo])

  // Every account's catalogue, so favourites and search span all of them.
  useEffect(() => {
    if (!open) return
    for (const p of providers) ensureModels(p.id)
    setTab(providerById(provider) ? provider : ordered[0]?.id || 'favorites')
    setQ('')
    setLegacy(false)
    setAccessOpen(false)
    requestAnimationFrame(() => search.current?.focus())
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  function modelRows(pid: string, list: ModelRow[]): Row[] {
    const pr = providerById(pid)
    if (!pr) return []
    if (!pr.supportsModelPicker) return [{ key: `${pid}:default`, provider: pid, title: `${pr.name} default`, source: pr.name, sourceDriver: pr.driver }]
    const configured = pid === defaultProvider ? (defaultModel || '').split('[')[0] : ''
    return list.map((m) => ({
      key: `${pid}:${m.id}`, provider: pid, model: m, title: m.name || m.id, source: pr.name, sourceDriver: pr.driver,
      badge: m.id === configured ? 'Default' : m.recommended ? 'Recommended' : undefined,
    }))
  }

  const term = q.trim().toLowerCase()
  let rows: Row[] = []
  let legacyRows: Row[] = []
  if (term) {
    rows = ordered.flatMap((p) => modelRows(p.id, models[p.id] || [])).filter((r) => `${r.title} ${r.source} ${r.model?.id || ''}`.toLowerCase().includes(term))
  } else if (tab === 'favorites') {
    rows = ordered.flatMap((p) => modelRows(p.id, (models[p.id] || []).filter((m) => m.favorite)))
  } else {
    const all = models[tab] || []
    rows = modelRows(tab, visibleModels(all))
    legacyRows = modelRows(tab, all.filter((m) => m.hidden))
    if (!providerById(tab)?.supportsModelPicker) { rows = modelRows(tab, []); legacyRows = [] }
  }
  const shown = legacy ? [...rows, ...legacyRows] : rows
  useEffect(() => { setSel(0) }, [tab, q, legacy])

  function choose(r: Row) {
    onChange({ provider: r.provider, modelSettings: settingsForPick(providerById(r.provider), r.model?.id, defaultProvider, defaultModel) })
    close()
  }
  const patch = (p: Partial<ModelSettings>) => onChange({ provider, modelSettings: { ...settings, ...p } })
  function chooseEffort(value: string) {
    patch({ effort: value })
    close()
  }
  function chooseAccess(id: Access) {
    patch({ access: id })
    setAccessOpen(false)
    accessBtn.current?.focus()
  }

  function isCurrent(r: Row) {
    return r.provider === provider && (!r.model || r.model.id === settings.modelId)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (accessOpen) return
    if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
      const r = shown[Number(e.key) - 1]
      if (r) { e.preventDefault(); choose(r) }
      return
    }
    // The reasoning column and the footer are reached with Tab; their own arrows move inside them.
    const inList = !(e.target as HTMLElement).closest?.('.vc-picker-effort, .vc-picker-foot')
    if (!inList) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(shown.length - 1, s + 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
    if (e.key === 'Enter' && shown[sel]) { e.preventDefault(); choose(shown[sel]) }
  }

  // Up/down (and left/right in the phone's row) step through a group's items; in
  // the speed toggle, a radio group, the arrow also picks.
  function onGroupKeys(e: React.KeyboardEvent<HTMLElement>) {
    const keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight']
    if (!keys.includes(e.key)) return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="radio"]'))
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (i < 0) return
    e.preventDefault()
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1
    const next = items[(i + step + items.length) % items.length]
    next?.focus()
    if (next?.getAttribute('role') === 'radio') next.click()
  }

  const renderRow = (r: Row, i: number) => (
    <div
      key={r.key}
      role="option"
      aria-selected={isCurrent(r)}
      className={`vc-picker-row ${i === sel ? 'active' : ''} ${isCurrent(r) ? 'current' : ''}`}
      onMouseEnter={() => setSel(i)}
      onClick={() => choose(r)}
      title={r.model?.note}
    >
      <span className="vc-picker-row-text">
        <span className="vc-picker-row-title">
          <span className="vc-picker-row-name">{r.title}</span>
          {isCurrent(r) && <TI icon={IconCheck} size={15} className="vc-picker-check" />}
          {r.badge && <span className="vc-badge">{r.badge}</span>}
        </span>
        <span className="vc-picker-row-source">
          <ProviderLogo driver={r.sourceDriver} name={r.source} size={13} />
          {r.source}
        </span>
      </span>
      {i < 9 && <kbd className="vc-kbd">{isMac ? '⌘' : 'Ctrl '}{i + 1}</kbd>}
      {r.model && (
        <button
          type="button"
          className={`vc-star ${r.model.favorite ? 'on' : ''}`}
          onClick={(e) => { e.stopPropagation(); toggleFavorite(r.provider, r.model!.id) }}
          aria-label={r.model.favorite ? `Unstar ${r.title}` : `Star ${r.title}`}
          aria-pressed={!!r.model.favorite}
        >
          <Hi icon={r.model.favorite ? StarSolidIcon : StarIcon} size={17} />
        </button>
      )}
    </div>
  )

  const label = chipLabel(settings, provider, models)
  const effortLabel = effort?.levels.find((l) => l.value === effort.value)?.label
  const showTraits = traits && !compact
  const title = [`Model: ${label}`, effortLabel && `Reasoning: ${effortLabel}`, speed && `Speed: ${speed === 'fast' ? 'Fast' : 'Standard'}`, traits && `Access: ${access.label}`].filter(Boolean).join(' · ')

  const panel = open && placement && createPortal(
    <div
      ref={pop}
      className={`vc-picker-pop ${effort ? 'has-effort' : ''} ${traits ? 'has-foot' : ''} ${placement.up ? 'up' : 'down'}`}
      style={placement.style}
      role="dialog"
      aria-label={traits ? 'Model, reasoning and access' : 'Choose a model'}
      onKeyDown={onKeyDown}
    >
      <nav className="vc-picker-rail" aria-label="Sources">
        <button type="button" className={tab === 'favorites' && !term ? 'on' : ''} onClick={() => { setTab('favorites'); setQ('') }} title="Favourites" aria-label="Favourites">
          <Hi icon={StarSolidIcon} size={20} />
        </button>
        <span className="vc-picker-rail-sep" />
        {ordered.map((p) => {
          const st = caps?.providers?.[p.id]?.state
          return (
            <button key={p.id} type="button" className={`${tab === p.id && !term ? 'on' : ''} ${st && st !== 'ready' && st !== 'unknown' ? 'dim' : ''}`} onClick={() => { setTab(p.id); setQ(''); setLegacy(false) }} title={p.name} aria-label={p.name}>
              <ProviderLogo driver={p.driver} name={p.name} size={22} />
            </button>
          )
        })}
      </nav>
      <div className="vc-picker-main">
        <label className="vc-picker-search">
          <TI icon={IconSearch} size={17} />
          <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search models…" aria-label="Search models" />
        </label>
        <div className="vc-picker-list" role="listbox" aria-label="Models">
          {!shown.length && <div className="vc-picker-empty">{tab === 'favorites' ? 'Star a model to keep it here.' : term ? `Nothing matches “${q}”.` : 'Loading models…'}</div>}
          {shown.slice(0, rows.length).map((r, i) => renderRow(r, i))}
          {!term && legacyRows.length > 0 && (
            <button type="button" className="vc-picker-legacy" onClick={() => setLegacy((l) => !l)} aria-expanded={legacy}>
              <span className="vc-picker-row-text">
                <span className="vc-picker-row-title">Legacy models</span>
                <span className="vc-picker-row-source">{legacyRows.length} model{legacyRows.length === 1 ? '' : 's'}</span>
              </span>
              <TI icon={IconChevronRight} size={16} className={`vc-chev ${legacy ? 'open' : ''}`} />
            </button>
          )}
          {shown.slice(rows.length).map((r, i) => renderRow(r, rows.length + i))}
        </div>
        {lockedTo && (
          <div className="vc-picker-lock">
            {`A temporary chat stays on ${providerById(lockedTo)?.name || lockedTo}. Start a regular chat to use another account.`}
          </div>
        )}
        {started && !lockedTo && shown[sel] && shown[sel].provider !== provider && (
          <div className="vc-picker-lock">{handoffNote(providerById(provider)?.name || provider, shown[sel].source)}</div>
        )}
      </div>
      {effort && (
        <div className="vc-picker-effort" role="menu" aria-label={`Reasoning for ${label}`} onKeyDown={onGroupKeys}>
          <div className="vc-picker-effort-head">
            <span>Reasoning</span>
            <small>{label}</small>
          </div>
          <div className="vc-picker-effort-list">
            {effort.levels.map((l) => (
              <button
                key={l.value}
                type="button"
                role="menuitemradio"
                aria-checked={l.value === effort.value}
                className={l.value === effort.value ? 'on' : ''}
                onClick={() => chooseEffort(l.value)}
                title={l.hint || undefined}
              >
                <span className="vc-picker-effort-label">{l.label}</span>
                {l.isDefault && <small>Default</small>}
                <TI icon={IconCheck} size={15} className="vc-picker-effort-check" />
              </button>
            ))}
          </div>
        </div>
      )}
      {traits && (
        <div className="vc-picker-foot">
          {speed ? (
            <div className="vc-picker-speed" role="radiogroup" aria-label="Speed" onKeyDown={onGroupKeys}>
              {(['standard', 'fast'] as const).map((s) => (
                <button key={s} type="button" role="radio" aria-checked={speed === s} tabIndex={speed === s ? 0 : -1}
                  className={speed === s ? 'on' : ''} onClick={() => patch({ speed: speedSetting(s) })}>
                  {s === 'fast' && <TI icon={IconBolt} size={14} />}
                  {s === 'fast' ? 'Fast' : 'Standard'}
                </button>
              ))}
            </div>
          ) : <span />}
          <button
            ref={accessBtn}
            type="button"
            className={`vc-picker-access ${accessOpen ? 'on' : ''} ${restricted ? 'restricted' : ''}`}
            onClick={() => setAccessOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={accessOpen}
            title={access.hint}
          >
            <TI icon={access.icon} size={15} />
            <span>{access.label}</span>
            <TI icon={accessOpen ? IconChevronDown : IconChevronUp} size={14} className="vc-chip-caret" />
          </button>
        </div>
      )}
    </div>,
    document.body,
  )

  const menu = accessOpen && accessPlacement && createPortal(
    <div ref={accessMenu} className="vc-picker-access-menu" style={accessPlacement.style} role="menu" aria-label="Access" onKeyDown={onGroupKeys}>
      {ACCESS_MODES.map((m) => (
        <button key={m.id} type="button" role="menuitemradio" aria-checked={m.id === access.id} className={m.id === access.id ? 'on' : ''} onClick={() => chooseAccess(m.id)}>
          <TI icon={m.icon} size={16} />
          <span className="vc-picker-access-text">
            <span>{m.label}</span>
            <small>{m.hint}</small>
          </span>
          <TI icon={IconCheck} size={15} className="vc-picker-effort-check" />
        </button>
      ))}
    </div>,
    document.body,
  )

  // The access menu takes focus when it opens, on its checked mode.
  useEffect(() => {
    if (accessOpen) requestAnimationFrame(() => accessMenu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
  }, [accessOpen, accessPlacement !== undefined]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="vc-picker" ref={ref}>
      <button type="button" className={`vc-chip vc-model-chip ${open ? 'on' : ''}`} onClick={() => (open ? close('outside') : setOpen(true))} aria-haspopup="dialog" aria-expanded={open} title={title}>
        <ProviderLogo driver={row?.driver} name={row?.name} size={16} />
        <span className="vc-chip-label">{label}</span>
        {showTraits && effortLabel && <>{' '}<span className="vc-chip-effort">· {effortLabel}</span></>}
        {showTraits && restricted && <TI icon={access.icon} size={14} className="vc-chip-warn" />}
        <TI icon={IconChevronDown} size={14} className="vc-chip-caret" />
      </button>
      {panel}
      {menu}
    </div>
  )
}
