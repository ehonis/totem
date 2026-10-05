import React, { useState, useCallback, useEffect, useRef } from 'react'
import { clearSecret, getTerminalStatus } from './api'
import { getSettings, useSettings } from './settings'
import { parseLocation, buildPath, toRoute, resolveTarget, type NavTarget, type Route } from './router'
import { COMMANDS } from './shortcuts'
import { useShortcuts, useCommand } from './useShortcuts'
import { useInboxCount, describeInboxCount } from './useInboxCount'
import totemLogo from './assets/totem-logo.png'
import AuthGate from './components/AuthGate'
import OverviewView from './components/OverviewView'
import InboxView from './components/InboxView'
import LogsView from './components/LogsView'
import ProductivityView from './components/ProductivityView'
import BrainView from './components/BrainView'
import GithubView from './components/GithubView'
import ChatView from './components/ChatView'
import StudioView from './components/StudioView'
import SettingsView from './components/SettingsView'
import TerminalPanel from './components/TerminalPanel'
import UsageQuickPanels from './components/UsageQuickPanels'
import ShortcutOverlay from './components/ShortcutOverlay'
import NotificationCenter from './components/NotificationCenter'
import { getNotificationHistory } from './push'
import ToastHost from './components/ToastHost'
import {
  Hi,
  Squares2X2Icon,
  ChatBubbleLeftRightIcon,
  CalendarDaysIcon,
  CircleStackIcon,
  ShieldCheckIcon,
  Cog6ToothIcon,
  InboxArrowDownIcon,
  SparklesIcon,
  CodeBracketIcon,
  ChevronDownIcon,
  EllipsisHorizontalIcon,
} from './icons'

interface TabDef {
  id: string
  label: string
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
}

// Primary sidebar tabs — the ones the owner reaches for most often.
const PRIMARY_TABS: TabDef[] = [
  { id: 'overview', label: 'Overview', icon: Squares2X2Icon },
  { id: 'chat', label: 'Chat', icon: ChatBubbleLeftRightIcon },
  { id: 'productivity', label: 'Productivity', icon: CalendarDaysIcon },
  { id: 'code', label: 'Code', icon: CodeBracketIcon },
  { id: 'inbox', label: 'Inbox', icon: InboxArrowDownIcon },
]

// Secondary tabs tucked under the "More" group so the sidebar stays scannable.
const MORE_TABS: TabDef[] = [
  { id: 'logs', label: 'Logs', icon: ShieldCheckIcon },
  { id: 'brain', label: 'Brain', icon: CircleStackIcon },
  { id: 'studio', label: 'Studio', icon: SparklesIcon },
]

// Settings lives at the bottom of the sidebar (replacing the old Disconnect link).
// It isn't in the tab arrays because it's pinned separately — except on a phone,
// where it folds into the More flyout with everything else that doesn't fit.
const SETTINGS_TAB = 'settings'
const SETTINGS_TAB_DEF: TabDef = { id: SETTINGS_TAB, label: 'Settings', icon: Cog6ToothIcon }

// The bottom bar fits five items with a readable label under each; past that the
// row silently scrolled and the last tabs sat off the right edge where nothing
// suggested they existed. On a phone only the first four are inline and the rest
// — Inbox included — live in the More flyout.
const NARROW_QUERY = '(max-width: 720px)'
const MOBILE_INLINE_TABS = 4

function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW_QUERY).matches ?? false)
  useEffect(() => {
    const mq = window.matchMedia?.(NARROW_QUERY)
    if (!mq) return
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches)
    mq.addEventListener('change', onChange)
    setNarrow(mq.matches)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return narrow
}

// The terminal panel is app chrome rather than a tab, so its open state is
// remembered here instead of in the route.
const TERMINAL_OPEN_KEY = 'totem.terminal.open'

interface NavTabButtonProps {
  tab: TabDef
  active: boolean
  onSelect: (id: string) => void
  sub?: boolean
  badge?: number | null
  badgeTitle?: string
}

// Shared nav button so primary tabs and More sub-items stay visually consistent.
// `badge` is a count to show beside the label; null or 0 renders nothing, so a
// tab with nothing waiting looks exactly as it did before.
function NavTabButton({ tab, active, onSelect, sub, badge, badgeTitle }: NavTabButtonProps) {
  const showBadge = typeof badge === 'number' && badge > 0
  return (
    <button
      type="button"
      className={`nav-item${sub ? ' nav-subitem' : ''}${active ? ' active' : ''}`}
      onClick={() => onSelect(tab.id)}
      title={showBadge ? badgeTitle : undefined}
    >
      <span className="ico"><Hi icon={tab.icon} size={18} /></span>
      {tab.label}
      {showBadge && (
        // The number is decoration for a sighted user; the title text is what
        // actually says what it means, so that is what gets announced.
        <span className="nav-badge" role="status" aria-label={badgeTitle}>
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )
}

interface NavMoreProps {
  tabs: TabDef[]
  activeTab: string
  onSelect: (id: string) => void
  // Count carried up from a tab that folded into the group, so a waiting inbox
  // is still visible when its own button isn't on the bar.
  badge?: number | null
  badgeTitle?: string
}

// Collapsible "More" group for secondary tabs. Auto-expands when one of its
// children is active; on mobile the same items appear in a flyout above the bar.
function NavMore({ tabs, activeTab, onSelect, badge, badgeTitle }: NavMoreProps) {
  const moreActive = tabs.some((t) => t.id === activeTab)
  const [open, setOpen] = useState(moreActive)
  const [flyout, setFlyout] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Keep the desktop accordion open while a More tab is selected.
  useEffect(() => {
    if (moreActive) setOpen(true)
  }, [moreActive])

  // Close the mobile flyout when tapping outside or after picking a tab.
  useEffect(() => {
    if (!flyout) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setFlyout(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [flyout])

  const pick = (id: string) => {
    onSelect(id)
    setFlyout(false)
  }

  return (
    <div className="nav-more" ref={wrapRef}>
      <button
        type="button"
        className={`nav-item nav-more-toggle${moreActive ? ' active' : ''}${open || flyout ? ' open' : ''}`}
        aria-expanded={open || flyout}
        aria-haspopup="true"
        onClick={() => {
          // Narrow screens use a flyout; wide screens use an inline accordion.
          if (window.matchMedia('(max-width: 720px)').matches) {
            setFlyout((v) => !v)
          } else {
            setOpen((v) => !v)
          }
        }}
      >
        <span className="ico"><Hi icon={EllipsisHorizontalIcon} size={18} /></span>
        More
        {typeof badge === 'number' && badge > 0 && (
          <span className="nav-badge" role="status" aria-label={badgeTitle}>
            {badge > 99 ? '99+' : badge}
          </span>
        )}
        <Hi icon={ChevronDownIcon} size={14} className="nav-more-chevron" />
      </button>
      {/* Desktop: inline sub-nav */}
      <div className={`nav-more-items${open ? ' open' : ''}`}>
        {tabs.map((t) => (
          <NavTabButton key={t.id} tab={t} active={activeTab === t.id} onSelect={pick} sub />
        ))}
      </div>
      {/* Mobile: popover above the bottom bar */}
      {flyout && (
        <div className="nav-more-flyout" role="menu">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              className={`nav-item${activeTab === t.id ? ' active' : ''}`}
              onClick={() => pick(t.id)}
            >
              <span className="ico"><Hi icon={t.icon} size={18} /></span>
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function App() {
  const settings = useSettings()
  const narrow = useNarrow()
  // AuthGate decides: a session cookie, a saved bridge secret, or proxy mode.
  const [unlocked, setUnlocked] = useState(false)
  const unlock = useCallback(() => setUnlocked(true), [])
  // Only polls once past the secret gate — before that every request 401s.
  const { open: inboxOpen, byKind: inboxByKind } = useInboxCount(unlocked)
  // The URL is the source of truth for where you are: /productivity/calendar,
  // /settings/providers, /chat?thread=…. See router.ts.
  const [route, setRoute] = useState<Route>(() => parseLocation(window.location, getSettings().landingTab))
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [unreadNotifications, setUnreadNotifications] = useState(0)

  // Normalise the address bar once on boot: a legacy ?tab= link, or a bare "/"
  // resolved through the landing-tab pref, becomes the path it now maps to.
  useEffect(() => {
    const path = buildPath(route, window.location.search)
    if (path !== window.location.pathname + window.location.search + window.location.hash) {
      window.history.replaceState(window.history.state, '', path)
    }
    // Boot-time only: later navigation maintains the URL itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Coming back to a tab should land where you left it (Productivity on the app
  // you were using, Settings on the pane you were in) — the query-string router
  // got that for free by never clearing ?app=/?stab=.
  const lastVisit = useRef<Record<string, Partial<Route>>>({})
  // Read inside navigate() so pushState stays out of the setState updater, which
  // React is free to run twice.
  const routeRef = useRef(route)
  useEffect(() => {
    routeRef.current = route
    lastVisit.current[route.tab] = { app: route.app, sub: route.sub }
  }, [route])

  // Real navigation, so Back/Forward walk the tabs you visited. Re-selecting the
  // tab you're already on replaces rather than stacking another entry.
  const navigate = useCallback((target: NavTarget) => {
    const current = routeRef.current
    const named = typeof target === 'string' ? target : target.tab
    const destination = toRoute({ tab: named ?? current.tab }).tab
    const next = resolveTarget(
      current, target, lastVisit.current[destination] || {}, getSettings().landingTab,
    )

    const path = buildPath(next, window.location.search)
    const here = window.location.pathname + window.location.search
    window.history[path.split('#')[0] === here ? 'replaceState' : 'pushState'](
      window.history.state, '', path,
    )
    routeRef.current = next
    setRoute(next)
  }, [])

  // Back/forward buttons and any external history change.
  useEffect(() => {
    const onPop = () => setRoute(parseLocation(window.location, getSettings().landingTab))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // The badge on the utilities button. Polled rather than pushed: the count only
  // changes when the bridge raises something, and a minute late on a dot is not a
  // failure worth a socket.
  useEffect(() => {
    let alive = true
    const read = () => {
      getNotificationHistory()
        .then((data) => { if (alive) setUnreadNotifications(data.unread) })
        .catch(() => { /* the bell is not worth an error screen */ })
    }
    read()
    const timer = setInterval(read, 60_000)
    return () => { alive = false; clearInterval(timer) }
  }, [notificationsOpen])

  const tab = route.tab
  const selectTab = navigate
  const selectApp = useCallback((app: string) => navigate({ tab: 'productivity', app }), [navigate])
  const selectSubTab = useCallback((sub: string) => navigate({ sub }), [navigate])

  const onAuthError = useCallback(() => {
    clearSecret()
    setUnlocked(false)
  }, [])

  // --- Terminal panel ---
  // Availability is a server fact (TERMINAL_ENABLED), so ask once rather than
  // showing a toggle that would fail. `null` means "still asking".
  const [terminalAvailable, setTerminalAvailable] = useState<boolean | null>(null)
  const [terminalOpen, setTerminalOpen] = useState(
    () => localStorage.getItem(TERMINAL_OPEN_KEY) === 'true',
  )

  // Gated on `unlocked`: before the secret is entered this request can only 401,
  // and firing it from the login screen just puts a red herring in the console.
  useEffect(() => {
    if (!unlocked) return
    let cancelled = false
    getTerminalStatus()
      .then((status: { enabled?: boolean }) => {
        if (!cancelled) setTerminalAvailable(Boolean(status?.enabled))
      })
      // A bridge too old to know the route, or an auth blip: treat as unavailable
      // rather than surfacing an error for a feature the user did not ask for yet.
      .catch(() => { if (!cancelled) setTerminalAvailable(false) })
    return () => { cancelled = true }
  }, [unlocked])

  const toggleTerminal = useCallback(() => {
    setTerminalOpen((prev) => {
      localStorage.setItem(TERMINAL_OPEN_KEY, String(!prev))
      return !prev
    })
  }, [])

  // Ctrl+` (Cmd+` on a Mac) from anywhere, the way every editor does it. Capture
  // phase so it still works while the terminal itself has focus — xterm would
  // otherwise swallow the keystroke before it reached us.
  useEffect(() => {
    if (!terminalAvailable) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '`' || (!e.ctrlKey && !e.metaKey) || e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      toggleTerminal()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [terminalAvailable, toggleTerminal])

  // `g k` reaches the terminal the same way Ctrl+` does — but only once the
  // bridge has confirmed it exists, so the shortcut can't open an empty panel.
  useCommand(COMMANDS.terminalToggle, () => { if (terminalAvailable) toggleTerminal() })

  // Leader-key navigation (shortcuts.ts). It's handed the same `navigate` the
  // sidebar uses, so a shortcut and a click land on exactly the same route —
  // including the "return to the pane you left" memory.
  const chord = useShortcuts(navigate)

  const terminalVisible = Boolean(terminalAvailable) && terminalOpen

  // Reflect appearance prefs on the document root so they apply app-wide.
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('reduce-motion', settings.reduceMotion)
    root.classList.toggle('density-compact', settings.compact)
  }, [settings.reduceMotion, settings.compact])

  // On a phone the bar keeps four tabs and hands the rest to More, so nothing
  // ends up scrolled off the edge.
  const inlineTabs = narrow ? PRIMARY_TABS.slice(0, MOBILE_INLINE_TABS) : PRIMARY_TABS
  const moreTabs = narrow
    ? [...PRIMARY_TABS.slice(MOBILE_INLINE_TABS), ...MORE_TABS, SETTINGS_TAB_DEF]
    : MORE_TABS
  const moreHasInbox = moreTabs.some((t) => t.id === 'inbox')

  if (!unlocked) return <AuthGate onUnlock={unlock} />

  return (
    <div className={`app${terminalVisible ? ' term-open' : ''}`}>
      <nav className="sidebar">
        <div className="brand">
          <img className="brand-logo" src={totemLogo} alt="Totem logo" />
          <span className="brand-name">Totem</span>
        </div>
        {inlineTabs.map((t) => (
          <NavTabButton
            key={t.id}
            tab={t}
            active={tab === t.id}
            onSelect={selectTab}
            badge={t.id === 'inbox' ? inboxOpen : null}
            badgeTitle={t.id === 'inbox' && inboxOpen ? describeInboxCount(inboxOpen, inboxByKind) : undefined}
          />
        ))}
        <NavMore
          tabs={moreTabs}
          activeTab={tab}
          onSelect={selectTab}
          badge={moreHasInbox ? inboxOpen : null}
          badgeTitle={moreHasInbox && inboxOpen ? describeInboxCount(inboxOpen, inboxByKind) : undefined}
        />
        {!narrow && (
          <div className="sidebar-foot">
            <button
              className={`nav-item ${tab === SETTINGS_TAB ? 'active' : ''}`}
              onClick={() => selectTab(SETTINGS_TAB)}
            >
              <span className="ico"><Hi icon={Cog6ToothIcon} size={18} /></span>
              Settings
            </button>
          </div>
        )}
      </nav>
      <main className="main">
        {/* Keep Chat mounted so its conversation survives tab switches. */}
        <ChatView visible={tab === 'chat'} onAuthError={onAuthError} />
        {tab === 'overview' && <OverviewView onNavigate={navigate} onAuthError={onAuthError} />}
        {/* `/inbox#P12` is a release notification's "tap to update" link. */}
        {tab === 'inbox' && <InboxView onAuthError={onAuthError} focusId={route.hash} />}
        {tab === 'logs' && <LogsView onAuthError={onAuthError} />}
        {tab === 'productivity' && (
          <ProductivityView app={route.app || ''} onApp={selectApp} onAuthError={onAuthError} />
        )}
        {tab === 'brain' && <BrainView onAuthError={onAuthError} />}
        {tab === 'code' && <GithubView onAuthError={onAuthError} />}
        {tab === 'studio' && (
          <StudioView onAuthError={onAuthError} subTab={route.sub || undefined} onSubTab={selectSubTab} />
        )}
        {tab === SETTINGS_TAB && (
          <SettingsView
            onAuthError={onAuthError}
            subTab={route.sub || undefined}
            onSubTab={selectSubTab}
            scrollTo={route.hash || undefined}
          />
        )}
      </main>
      {terminalVisible && <TerminalPanel open onClose={toggleTerminal} />}
      <NotificationCenter
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
        // A notification's deep link is a path, the same shape the router parses
        // out of the address bar — so reuse that rather than a second mapping
        // that can disagree with it.
        onNavigate={(url) => {
          const target = new URL(url, window.location.origin)
          window.history.pushState({}, '', target.pathname + target.search + target.hash)
          setRoute(parseLocation(window.location, getSettings().landingTab))
          setNotificationsOpen(false)
        }}
      />
      <UsageQuickPanels
        onNavigate={navigate}
        onAuthError={onAuthError}
        terminalAvailable={Boolean(terminalAvailable)}
        terminalOpen={terminalVisible}
        onToggleTerminal={toggleTerminal}
        unreadNotifications={unreadNotifications}
        onOpenNotifications={() => setNotificationsOpen(true)}
      />
      <ShortcutOverlay chord={chord} />
      <ToastHost />
    </div>
  )
}
