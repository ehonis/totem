import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChat, ensureModels, providerById, toggleFavorite } from './store'
import { settingsForPick, visibleModels } from './models'
import { handoffNote } from './handoff'
import type { ModelRow, ModelSettings } from './types'
import { TI, ProviderLogo, useDismiss, usePopoverPlacement } from './ui'
import { IconChevronDown, IconChevronRight, IconSearch } from './icons'
import { StarIcon, StarSolidIcon, Hi } from '../icons'

// The composer's model chip and its picker, shaped like T3 Code's: a rail of
// sources down the left (favourites, then one logo per account), a search box, and rows with the source underneath,
// a ⌘-number and a star. Models the Providers tab hides are not dropped but
// folded under "Legacy models", so nothing that can run is unreachable.

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

export function chipLabel(settings: ModelSettings, provider: string, models: Record<string, ModelRow[]>) {
  const row = providerById(provider)
  const m = (models[provider] || []).find((x) => x.id === settings.modelId)
  return m?.name || row?.name || provider
}

export default function ModelPicker({ provider, settings, onChange, started = false, locked = false, align = 'start' }: {
  provider: string
  settings: ModelSettings
  onChange: (patch: { provider: string; modelSettings: ModelSettings }) => void
  /** The chat has started: picking another account hands it over (chat/handoff.ts). */
  started?: boolean
  /** A started temporary chat: the bridge holds it to the default account. */
  locked?: boolean
  /** 'end': the chip sits at the composer's right (T3 Code's), so the picker opens leftward from it. */
  align?: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('favorites')
  const [q, setQ] = useState('')
  const [legacy, setLegacy] = useState(false)
  const [sel, setSel] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const providers = useChat((s) => s.providers)
  const models = useChat((s) => s.models)
  const caps = useChat((s) => s.caps)
  const defaultProvider = useChat((s) => s.defaultProvider)
  const defaultModel = useChat((s) => s.defaultModel)
  useDismiss(open, ref, useCallback(() => setOpen(false), []))
  // Up from the chip when there is room; down (or shorter) when the composer sits
  // high on the page, as on an empty chat or a project's home. At the composer's
  // right it lines up with the end of the whole chip, where the effort menu opens.
  const placement = usePopoverPlacement(open, ref, align === 'end'
    ? { width: 560, height: 440, align, alignTo: '.vc-model-group', offsetX: 4 }
    : { width: 560, height: 440, offsetX: -46 })
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
    setOpen(false)
  }

  function isCurrent(r: Row) {
    return r.provider === provider && (!r.model || r.model.id === settings.modelId)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
      const r = shown[Number(e.key) - 1]
      if (r) { e.preventDefault(); choose(r) }
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(shown.length - 1, s + 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
    if (e.key === 'Enter' && shown[sel]) { e.preventDefault(); choose(shown[sel]) }
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
                      {r.title}
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

  const row = providerById(provider)
  const label = chipLabel(settings, provider, models)
  return (
    <div className="vc-picker" ref={ref}>
      <button type="button" className={`vc-chip vc-model-chip ${open ? 'on' : ''}`} onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open} title="Choose a model">
        <ProviderLogo driver={row?.driver} name={row?.name} size={16} />
        <span className="vc-chip-label">{label}</span>
        <TI icon={IconChevronDown} size={14} className="vc-chip-caret" />
      </button>
      {open && (
        <div className="vc-picker-pop" style={placement} role="dialog" aria-label="Choose a model" onKeyDown={onKeyDown}>
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
            <div className="vc-picker-list" role="listbox">
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
        </div>
      )}
    </div>
  )
}
