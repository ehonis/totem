import React, { useState, useCallback, useEffect, useRef } from 'react'
import { clearSecret, getTerminalStatus } from './api'
import { getSettings, useSettings } from './settings'
import { parseLocation, buildPath, toRoute, resolveTarget, type NavTarget, type Route } from './router'
import { COMMANDS } from './shortcuts'
import { useShortcuts, useCommand } from './useShortcuts'
import { useInboxCount, describeInboxCount } from './useInboxCount'
import AuthGate from './components/AuthGate'
import OverviewView from './components/OverviewView'
import InboxView from './components/InboxView'
import LogsView from './components/LogsView'
import ProductivityView from './components/ProductivityView'
import BrainView from './components/BrainView'
import SearchView from './components/SearchView'
import DevView from './components/DevView'
import ChatView from './components/ChatView'
import MessagesView from './messages/MessagesView'
import { useAppleStatus } from './messages/useAppleStatus'
import { appleEnabled } from './messages/api'
import ScreenView from './screen/ScreenView'
import { useScreenStatus } from './screen/useScreenStatus'
import { screenEnabled } from './screen/api'
import { Rail, SidePanel, MobileBar, MobileDrawer, NewChatFab, usePanelOpen, useEdgeSwipe } from './components/Shell'
import { setActive, requestVoice } from './chat/store'
import TotemsView from './components/TotemsView'
import TotemsIcon from './components/TotemsIcon'
import SettingsView from './components/SettingsView'
import TerminalPanel from './components/TerminalPanel'
import UsageQuickPanels from './components/UsageQuickPanels'
import ShortcutOverlay from './components/ShortcutOverlay'
import NotificationCenter from './components/NotificationCenter'
import { getNotificationHistory } from './push'
import ToastHost from './components/ToastHost'
import RunningChats from './chat/RunningChats'
import {
  Hi,
  Squares2X2Icon,
  ChatBubbleLeftRightIcon,
  ChatBubbleOvalLeftIcon,
  ComputerDesktopIcon,
  CalendarDaysIcon,
  CircleStackIcon,
  ShieldCheckIcon,
  Cog6ToothIcon,
  InboxArrowDownIcon,
  CodeBracketIcon,
  MagnifyingGlassIcon,
  ChevronDownIcon,
  EllipsisHorizontalIcon,
  WrenchScrewdriverIcon,
} from './icons'

interface TabDef {
  id: string
  label: string
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
}

// Primary sidebar tabs — the ones the owner reaches for most often.
const PRIMARY_TABS: TabDef[] = [
  { id: 'overview', label: 'Overview', icon: Squares2X2Icon },
  { id: 'search', label: 'Search', icon: MagnifyingGlassIcon },
  { id: 'totems', label: 'Totems', icon: TotemsIcon },
  { id: 'chat', label: 'Chat', icon: ChatBubbleLeftRightIcon },
  { id: 'productivity', label: 'Productivity', icon: CalendarDaysIcon },
  { id: 'inbox', label: 'Inbox', icon: InboxArrowDownIcon },
  // CI, reviews and runners across the repos in data/dev.json, plus outside alerts.
  { id: 'dev', label: 'Dev', icon: WrenchScrewdriverIcon },
]

// No longer on the nav: Brain opens from the Overview's app row, Code is the last
// section of Dev, and the AI workshop (Studio's skills/jobs/connections, and Logs)
// lives in Settings.
// Their routes still work, so links and shortcuts to them keep landing.
const MORE_TABS: TabDef[] = []

// Messages from the Mac Totem runs on. On the rail only when the bridge says
// Apple data is on (APPLE_ENABLED on a Mac); the route works either way and
// explains itself. Chat's double bubble is taken, so this is the single oval.
const MESSAGES_TAB_DEF: TabDef = { id: 'messages', label: 'Messages', icon: ChatBubbleOvalLeftIcon }

// The desktop of the machine Totem runs on (SCREEN_ENABLED). On the desktop rail
// only, never in the phone drawer; /screen on a phone explains itself.
const SCREEN_TAB_DEF: TabDef = { id: 'screen', label: 'Screen', icon: ComputerDesktopIcon }

// Settings lives at the bottom of the sidebar (replacing the old Disconnect link).
// It isn't in the tab arrays because it's pinned separately — except on a phone,
// where it folds into the More flyout with everything else that doesn't fit.
const SETTINGS_TAB = 'settings'
// Pages drawn over a moving colour glow (glow.css). The chat, editors and the
// Totems scene keep a plain background.
const GLOW_TABS = new Set(['overview', 'productivity', 'inbox', 'search', 'messages', SETTINGS_TAB])
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

/** The tab list with Messages after Chat, when the bridge reads Messages. */
function withMessages(tabs: TabDef[], on: boolean): TabDef[] {
  if (!on) return tabs
  const at = tabs.findIndex((t) => t.id === 'chat')
  return [...tabs.slice(0, at + 1), MESSAGES_TAB_DEF, ...tabs.slice(at + 1)]
}

const safeDecode = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }

// The terminal panel is app chrome rather than a tab, so its open state is
// remembered here instead of in the route.
const TERMINAL_OPEN_KEY = 'totem.terminal.open'

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
  const [panelOpen, setPanelOpen] = usePanelOpen()
  const [drawerOpen, setDrawerOpen] = useState(false)
  useEdgeSwipe(narrow, drawerOpen, setDrawerOpen)
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

  // Apple Messages: asked once after sign-in, like the terminal above.
  const { status: appleStatus, refresh: refreshAppleStatus } = useAppleStatus(unlocked, onAuthError)
  const { status: screenStatus, refresh: refreshScreenStatus } = useScreenStatus(unlocked, onAuthError)

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

  // Every tab is on the rail (desktop) or in the drawer (phone); nothing is
  // folded under "More" any more.
  const allTabs = withMessages([...PRIMARY_TABS, ...MORE_TABS], appleEnabled(appleStatus))
  const railTabs = screenEnabled(screenStatus) ? [...allTabs, SCREEN_TAB_DEF] : allTabs
  const badges = inboxOpen ? { inbox: { count: inboxOpen, title: describeInboxCount(inboxOpen, inboxByKind) } } : {}
  const tabLabel = [...allTabs, MESSAGES_TAB_DEF, SCREEN_TAB_DEF, SETTINGS_TAB_DEF].find((t) => t.id === tab)?.label || 'Totem'
  const openChat = () => selectTab('chat')
  const newChat = () => { setActive(null); selectTab('chat') }
  const showPanel = useCallback(() => { if (!narrow) setPanelOpen(true) }, [narrow, setPanelOpen])

  if (!unlocked) return <AuthGate onUnlock={unlock} />

  return (
    <div className={`app shell${terminalVisible ? ' term-open' : ''}${!narrow && panelOpen ? ' panel-open' : ''}${narrow && drawerOpen ? ' drawer-open' : ''}`}>
      {!narrow && (
        <Rail
          tabs={railTabs}
          bottom={SETTINGS_TAB_DEF}
          active={tab}
          onSelect={selectTab}
          panelOpen={panelOpen}
          onTogglePanel={() => setPanelOpen(!panelOpen)}
          badges={badges}
        />
      )}
      {!narrow && panelOpen && (
        <SidePanel onOpenChat={openChat} onNotifications={() => setNotificationsOpen(true)} unread={unreadNotifications} onCollapse={() => setPanelOpen(false)} />
      )}
      <main className="main" data-glow={GLOW_TABS.has(tab) ? tab : undefined}>
        {GLOW_TABS.has(tab) && <div className="page-glow" aria-hidden />}
        {/* The chat draws its own top bar; every other screen gets ChatGPT's. */}
        {narrow && tab !== 'chat' && (
          <MobileBar
            title={tabLabel}
            onMenu={() => setDrawerOpen(true)}
            // On Messages the top bar's pencil means "new message", as in the Messages app.
            onNewChat={tab === 'messages' ? () => window.dispatchEvent(new Event('totem:new-message')) : newChat}
          />
        )}
        {/* Keep Chat mounted so its conversation survives tab switches. */}
        <ChatView visible={tab === 'chat'} onAuthError={onAuthError} onOpenMenu={() => setDrawerOpen(true)} panelOpen={panelOpen} onShowPanel={() => setPanelOpen(true)} />
        {tab === 'overview' && <OverviewView onNavigate={navigate} onAuthError={onAuthError} />}
        {/* `/inbox#P12` is a release notification's "tap to update" link. */}
        {tab === 'inbox' && <InboxView onAuthError={onAuthError} focusId={route.hash} />}
        {tab === 'logs' && <LogsView onAuthError={onAuthError} />}
        {tab === 'productivity' && (
          <ProductivityView app={route.app || ''} onApp={selectApp} onAuthError={onAuthError} />
        )}
        {tab === 'search' && <SearchView onAuthError={onAuthError} onNavigate={navigate} />}
        {tab === 'brain' && <BrainView onAuthError={onAuthError} openPath={route.hash ? safeDecode(route.hash) : undefined} />}
        {tab === 'dev' && <DevView onAuthError={onAuthError} />}
        {tab === 'messages' && (
          <MessagesView status={appleStatus} onRefreshStatus={refreshAppleStatus} onAuthError={onAuthError} narrow={narrow} />
        )}
        {tab === 'screen' && <ScreenView status={screenStatus} onRefreshStatus={refreshScreenStatus} narrow={narrow} />}
        {tab === 'totems' && <TotemsView onAuthError={onAuthError} onOpenChat={openChat} />}
        {tab === SETTINGS_TAB && (
          <SettingsView
            onAuthError={onAuthError}
            subTab={route.sub || undefined}
            onSubTab={selectSubTab}
            scrollTo={route.hash || undefined}
          />
        )}
      </main>
      {narrow && tab !== 'chat' && tab !== 'messages' && <NewChatFab onNewChat={newChat} onVoice={() => { requestVoice(); selectTab('chat') }} />}
      {narrow && (
        <MobileDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          // No Messages on a phone: the Messages app is right there. /messages
          // still opens, and agents still read Messages through apple__*.
          tabs={allTabs.filter((t) => t.id !== 'messages')}
          bottom={SETTINGS_TAB_DEF}
          active={tab}
          onSelect={selectTab}
          onOpenChat={openChat}
          badges={badges}
          onNotifications={() => setNotificationsOpen(true)}
          unread={unreadNotifications}
        />
      )}
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
      {/* Chats answering out of sight, bottom-right; a click opens one in the panel and the chat. */}
      <RunningChats onOpenChat={openChat} onShowPanel={showPanel} narrow={narrow} />
      <ShortcutOverlay chord={chord} />
      <ToastHost />
    </div>
  )
}
