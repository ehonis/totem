import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flashElement, prefersStill } from '../landing'
import IconSettings from '@tabler/icons-react/dist/esm/icons/IconSettings.mjs'
import IconPalette from '@tabler/icons-react/dist/esm/icons/IconPalette.mjs'
import IconMessages from '@tabler/icons-react/dist/esm/icons/IconMessages.mjs'
import IconMicrophone from '@tabler/icons-react/dist/esm/icons/IconMicrophone.mjs'
import IconBell from '@tabler/icons-react/dist/esm/icons/IconBell.mjs'
import IconKeyboard from '@tabler/icons-react/dist/esm/icons/IconKeyboard.mjs'
import IconCpu from '@tabler/icons-react/dist/esm/icons/IconCpu.mjs'
import IconChartBar from '@tabler/icons-react/dist/esm/icons/IconChartBar.mjs'
import IconSparkles from '@tabler/icons-react/dist/esm/icons/IconSparkles.mjs'
import IconPlugConnected from '@tabler/icons-react/dist/esm/icons/IconPlugConnected.mjs'
import IconCircleCheck from '@tabler/icons-react/dist/esm/icons/IconCircleCheck.mjs'
import IconShieldLock from '@tabler/icons-react/dist/esm/icons/IconShieldLock.mjs'
import IconActivity from '@tabler/icons-react/dist/esm/icons/IconActivity.mjs'
import IconSearch from '@tabler/icons-react/dist/esm/icons/IconSearch.mjs'
import IconX from '@tabler/icons-react/dist/esm/icons/IconX.mjs'
import IconChevronLeft from '@tabler/icons-react/dist/esm/icons/IconChevronLeft.mjs'
import IconChevronRight from '@tabler/icons-react/dist/esm/icons/IconChevronRight.mjs'
import { TI } from '../chat/ui'
import IconRotate from '@tabler/icons-react/dist/esm/icons/IconRotate.mjs'
import { DEFAULTS, setSetting, useSettings, type Settings } from '../settings'
import { pushSuccess } from '../toast'
import { SETTINGS_GROUPS, SETTINGS_LABELS, SETTINGS_SECTIONS, type SettingsSection } from './settings/sections'
import { searchSettings, type SettingsSearchItem } from './settings/searchIndex'
import GeneralPane from './settings/GeneralPane'
import AppearancePane from './settings/AppearancePane'
import SecurityPane from './settings/SecurityPane'
import ChatSettings from './ChatSettings'
import VoiceSettings from './VoiceSettings'
import NotificationsSettings from './NotificationsSettings'
import ShortcutsSettings from './ShortcutsSettings'
import ProvidersView from './ProvidersView'
import UsageView from './UsageView'
import SkillsView from './SkillsView'
import McpSettingsView from './McpSettingsView'
import TaskSettings from './TaskSettings'
import LogsView from './LogsView'
import ChatAbout from '../chat/about/ChatAbout'
import { SETTINGS_ABOUT, settingsContext } from '../chat/about/context'
import { settingsOutline } from '../chat/about/settingsOutline'
import { SettingsPage } from './settings/ui'
import './settings/settings.css'

/*
 * Settings, as T3 Code draws it: a large dialog over whatever page opened it,
 * sections down the left (grouped, with a search on top) and the pane on the
 * right under a breadcrumb. Esc, the close button or a press on the dim backdrop
 * goes back to that page. On a phone the dialog fills the screen and works as a
 * list that opens a pane, with a back arrow, as the iPhone's Settings does.
 *
 * The URL still names the pane (/settings/<section>#<row>), so a link from a
 * notification, a toast or another page lands on the exact setting.
 */

const ICONS: Record<SettingsSection, Parameters<typeof TI>[0]['icon']> = {
  general: IconSettings,
  appearance: IconPalette,
  chat: IconMessages,
  voice: IconMicrophone,
  notifications: IconBell,
  shortcuts: IconKeyboard,
  providers: IconCpu,
  usage: IconChartBar,
  skills: IconSparkles,
  connections: IconPlugConnected,
  tasks: IconCircleCheck,
  security: IconShieldLock,
  logs: IconActivity,
}

// This device's own preferences (settings.ts) on each pane that shows them, for
// T3's "Restore device defaults": each pane's button resets only its own.
const DEVICE_PREFS: Partial<Record<SettingsSection, [keyof Settings, string][]>> = {
  general: [['landingTab', 'Open on'], ['autoRefresh', 'Keep pages live']],
  appearance: [['background', 'Background'], ['chatGlow', 'Colour glow in chats'], ['compact', 'Compact density'], ['reduceMotion', 'Reduce motion']],
}

function RestoreDeviceDefaults({ prefs }: { prefs: [keyof Settings, string][] }) {
  const s = useSettings()
  const changed = prefs.filter(([k]) => JSON.stringify(s[k]) !== JSON.stringify(DEFAULTS[k]))
  return (
    <button
      type="button"
      className="btn compact ghost stg-restore"
      aria-label="Restore device defaults"
      disabled={!changed.length}
      title={changed.length ? `Changed here: ${changed.map(([, label]) => label).join(', ')}` : 'Nothing on this device differs from the defaults'}
      onClick={() => {
        if (!window.confirm(`Put these back to their defaults on this device?\n\n${changed.map(([, label]) => `• ${label}`).join('\n')}`)) return
        for (const [k] of changed) setSetting(k, DEFAULTS[k] as never)
        pushSuccess('Device defaults restored')
      }}
    >
      <TI icon={IconRotate} size={14} /><span className="stg-restore-long">Restore device defaults</span><span className="stg-restore-short">Reset page</span>
    </button>
  )
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface SettingsViewProps {
  onAuthError: () => void
  subTab?: string
  /** Open another pane, optionally at one of its rows. */
  onSubTab: (id: string, hash?: string | null) => void
  /** The row or section to bring into view (the URL hash). */
  scrollTo?: string
  onClose: () => void
  /** Phone layout: a list of sections that opens one pane at a time. */
  narrow: boolean
  /** On a phone, open on the list rather than the pane (Settings was opened bare). */
  startOnList?: boolean
}

/** Bring a pane's row into view once it exists; panes load their data first. */
function useRevealTarget(target: string | undefined, section: string, body: React.RefObject<HTMLDivElement>, tick: number) {
  useEffect(() => {
    if (!target) return
    let frame = 0
    const until = Date.now() + 4000
    const find = () => {
      const el = body.current?.querySelector<HTMLElement>(`[id="${CSS.escape(target)}"]`)
      if (!el) {
        if (Date.now() < until) frame = requestAnimationFrame(find)
        return
      }
      const still = prefersStill()
      el.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' })
      el.focus({ preventScroll: true })
      // The same flash as a search hit anywhere else (landing.ts); a still outline with less motion.
      flashElement(el, still)
    }
    frame = requestAnimationFrame(find)
    return () => cancelAnimationFrame(frame)
  }, [target, section, body, tick])
}

function Pane({ id, onAuthError, onDisconnect, onNavigate }: {
  id: SettingsSection
  onAuthError: () => void
  onDisconnect: () => void
  onNavigate: (id: string, hash?: string | null) => void
}) {
  switch (id) {
    case 'general': return <GeneralPane onAuthError={onAuthError} />
    case 'appearance': return <AppearancePane />
    case 'chat': return <ChatSettings onNavigate={onNavigate} />
    case 'voice': return <VoiceSettings onNavigate={onNavigate} />
    case 'notifications': return <NotificationsSettings />
    case 'shortcuts': return <ShortcutsSettings />
    case 'providers': return <ProvidersView onAuthError={onAuthError} onNavigate={onNavigate} />
    case 'usage': return <UsageView onAuthError={onAuthError} />
    case 'skills': return <SettingsPage><SkillsView onAuthError={onAuthError} /></SettingsPage>
    case 'connections': return <SettingsPage><McpSettingsView onAuthError={onAuthError} /></SettingsPage>
    case 'tasks': return <TaskSettings onAuthError={onAuthError} />
    case 'security': return <SecurityPane onSignedOut={onDisconnect} />
    case 'logs': return <SettingsPage><LogsView onAuthError={onAuthError} /></SettingsPage>
  }
  return null
}

export default function SettingsView({ onAuthError, subTab, onSubTab, scrollTo, onClose, narrow, startOnList }: SettingsViewProps) {
  const section: SettingsSection = (SETTINGS_SECTIONS as readonly string[]).includes(subTab || '') ? subTab as SettingsSection : 'general'
  const popup = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  // Bumped on every jump, so picking the hit you are already on scrolls to it again.
  const [revealTick, setRevealTick] = useState(0)
  // Phone only: the section list is showing instead of a pane.
  const [listing, setListing] = useState(() => narrow && !!startOnList && !scrollTo)
  const results = useMemo(() => searchSettings(query), [query])
  const searching = query.trim().length > 0
  const showList = narrow && (listing || searching)
  const showPane = !narrow || !showList

  useRevealTarget(showPane ? scrollTo : undefined, section, body, revealTick)

  // Focus the dialog itself, not its first control: no stray focus ring and no
  // phone keyboard sliding up. Whatever had focus gets it back on close.
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null
    popup.current?.focus({ preventScroll: true })
    // A frame later, once App has lifted `inert` off the page behind (focus() on
    // an inert element does nothing), and never into something hidden: the
    // phone drawer that opened it has closed.
    return () => {
      requestAnimationFrame(() => {
        if (before && document.contains(before) && before.getClientRects().length && !before.closest('[aria-hidden="true"], [inert]')) before.focus({ preventScroll: true })
      })
    }
  }, [])

  // Closing unmounts a focused field without a blur, so a field that saves on
  // blur (Providers' display name) would drop what was typed. Blur it first.
  const close = useCallback(() => {
    const focused = document.activeElement
    if (focused instanceof HTMLElement && popup.current?.contains(focused)) focused.blur()
    onClose()
  }, [onClose])

  // A new pane starts at its top.
  useLayoutEffect(() => { if (!scrollTo) body.current?.scrollTo({ top: 0 }) }, [section]) // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback((id: string, hash?: string | null) => {
    setQuery('')
    setActive(0)
    setListing(false)
    setRevealTick((t) => t + 1)
    onSubTab(id, hash ?? null)
  }, [onSubTab])

  const choose = (item: SettingsSearchItem) => open(item.section, item.id === item.section ? null : item.id)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      const target = e.target as HTMLElement | null
      // A dialog a pane opened (Connections' sign-in, a confirm) owns its keys,
      // wherever focus is; so does a field recording a shortcut (Keyboard).
      if (popup.current?.querySelector('.modal-backdrop, [role="dialog"], [aria-modal="true"]')) return
      const inner = target?.closest('[role="dialog"], [aria-modal="true"], .modal-backdrop')
      if (inner && inner !== popup.current) return
      // Only while it is recording: once Esc disarms it, Esc goes back to closing.
      if (target?.closest('.seq-input.recording, .seq-leader-btn.recording')) return
      if (e.key === 'Escape') {
        // Captured, so the page under the dialog (a chat's Files or Browser
        // panel, which close on Esc) never sees it.
        e.preventDefault()
        e.stopImmediatePropagation()
        if (searching) { setQuery(''); return }
        if (narrow && !listing) { setListing(true); return }
        close()
        return
      }
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      const find = (e.key === 'f' || e.key === 'F') && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
      if (find || (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (narrow) setListing(true)
        requestAnimationFrame(() => { searchRef.current?.focus(); searchRef.current?.select() })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [searching, narrow, listing, close])

  // Keep Tab inside the dialog.
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !popup.current) return
    const items = [...popup.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === popup.current)) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || !results.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % results.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + results.length) % results.length) }
    else if (e.key === 'Enter') { e.preventDefault(); const r = results[Math.min(active, results.length - 1)]; if (r) choose(r) }
  }

  // A press that starts and ends on the backdrop closes; a text selection that
  // ends there does not.
  const pressedBackdrop = useRef(false)

  const nav = (
    <nav className="stg-nav" aria-label="Settings sections">
      <label className="stg-search">
        <TI icon={IconSearch} size={15} />
        <input
          ref={searchRef}
          type="text"
          value={query}
          placeholder="Search settings"
          aria-label="Search settings"
          role="combobox"
          aria-expanded={searching && results.length > 0}
          aria-controls={searching && results.length ? 'stg-results' : undefined}
          aria-activedescendant={searching && results[active] ? `stg-r-${results[active].key}` : undefined}
          onChange={(e) => { setQuery(e.target.value); setActive(0) }}
          onKeyDown={onSearchKey}
        />
        {searching
          ? <button type="button" className="stg-search-clear" aria-label="Clear search" onClick={() => { setQuery(''); searchRef.current?.focus() }}><TI icon={IconX} size={13} /></button>
          : !narrow && <kbd>/</kbd>}
      </label>
      {searching ? (
        results.length ? (
          <ul id="stg-results" className="stg-results" role="listbox" aria-label="Matching settings">
            {results.map((r, i) => (
              <li key={r.key} role="presentation">
                <button
                  type="button"
                  id={`stg-r-${r.key}`}
                  role="option"
                  aria-selected={i === active}
                  tabIndex={-1}
                  className={`stg-result${i === active ? ' on' : ''}`}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(r)}
                  ref={i === active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                >
                  <TI icon={ICONS[r.section]} size={16} />
                  <span>
                    <strong>{r.title}</strong>
                    <small>{SETTINGS_LABELS[r.section]}{r.where ? ` › ${r.where}` : ''}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="stg-none" role="status">No settings match “{query.trim()}”.</p>
      ) : (
        SETTINGS_GROUPS.map((g, gi) => (
          <div key={g.heading || gi} className="stg-group" role="group" aria-label={g.heading || undefined}>
            {g.heading && <h3 aria-hidden>{g.heading}</h3>}
            <div className="stg-group-items">
            {g.items.map((id) => {
              const on = !narrow && id === section
              return (
                <button
                  key={id}
                  type="button"
                  className={`stg-item${on ? ' on' : ''}`}
                  aria-current={on ? 'page' : undefined}
                  onClick={() => open(id)}
                >
                  <TI icon={ICONS[id]} size={17} />
                  <span>{SETTINGS_LABELS[id]}</span>
                  {narrow && <TI icon={IconChevronRight} size={16} className="stg-item-go" />}
                </button>
              )
            })}
            </div>
          </div>
        ))
      )}
    </nav>
  )

  return (
    <div
      className="stg-root"
      onPointerDown={(e) => { pressedBackdrop.current = e.target === e.currentTarget }}
      onClick={(e) => { if (pressedBackdrop.current && e.target === e.currentTarget) close(); pressedBackdrop.current = false }}
    >
      <div
        ref={popup}
        className={`stg${narrow ? ' stg-narrow' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        onKeyDown={trapTab}
      >
        {(!narrow || showList) && (
          <div className="stg-side">
            {narrow && (
              <header className="stg-head">
                <h2 className="stg-title">Settings</h2>
                <button type="button" className="stg-icon-btn stg-close" aria-label="Close settings" onClick={close}>
                  <TI icon={IconX} size={17} />
                </button>
              </header>
            )}
            {nav}
          </div>
        )}
        {showPane && (
          <div className="stg-main">
            <header className="stg-head">
              {narrow && (
                <button type="button" className="stg-icon-btn" aria-label="All settings" onClick={() => setListing(true)}>
                  <TI icon={IconChevronLeft} size={18} />
                </button>
              )}
              <nav className="stg-crumbs" aria-label="Breadcrumb">
                {!narrow && <><span>Settings</span><TI icon={IconChevronRight} size={13} /></>}
                <strong aria-current="page">{SETTINGS_LABELS[section]}</strong>
              </nav>
              {DEVICE_PREFS[section] && <RestoreDeviceDefaults key={section} prefs={DEVICE_PREFS[section]!} />}
              <button type="button" className="stg-icon-btn stg-close" aria-label="Close settings" title="Close (Esc)" onClick={close}>
                <TI icon={IconX} size={17} />
              </button>
            </header>
            <div ref={body} className="stg-body" key={section}>
              {/* Right-click or long-press a pane to chat about its settings (not the panes that list data). */}
              {(SETTINGS_ABOUT as readonly string[]).includes(section) && <ChatAbout key={section} of={(pane) => settingsContext(section, settingsOutline(pane))} />}
              <Pane id={section} onAuthError={onAuthError} onDisconnect={onAuthError} onNavigate={open} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
