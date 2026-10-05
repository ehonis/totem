import React, { useEffect, useState } from 'react'
import { Hi } from '../icons'
import totemLogo from '../assets/totem-logo.png'
import ThreadList from '../chat/ThreadList'
import { useChat, setActive } from '../chat/store'
import { TI } from '../chat/ui'
import { IconBell, IconEdit, IconWaveSine, IconMenu, IconSearch, IconLayoutSidebar, IconLayoutSidebarLeftCollapse, IconX } from '../chat/icons'

// The app shell, after ChatGPT's current layout.
//
// Desktop: a narrow rail of every Totem tab down the far left, and beside it a
// panel holding the chats — "New chat", then Recents — that collapses to give a
// view the full width. The panel is there on every tab, so a chat is one click
// from anywhere, the way ChatGPT keeps history beside whatever you're doing.
//
// Phone: no bottom dock. Each screen has a top bar (☰, its name, new chat) and
// the ☰ opens a drawer with the tabs and the chats together, which is how the
// ChatGPT app is laid out.

export interface TabDef {
  id: string
  label: string
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
}

const PANEL_KEY = 'totem.panel.open'

/**
 * ChatGPT's iOS gesture: drag from the left edge to pull the page aside and
 * reveal the sidebar; drag the page back (or tap it) to close. While a finger is
 * down the page follows it (--sh-drag), and on release it settles open or shut.
 * Vertical scrolls are left alone — a gesture only counts once it is clearly
 * sideways.
 */
export function useEdgeSwipe(enabled: boolean, open: boolean, setOpen: (v: boolean) => void) {
  useEffect(() => {
    if (!enabled) return
    const root = document.documentElement
    const width = () => Math.min(window.innerWidth * 0.84, 330)
    let start: { x: number; y: number; t: number; from: 'edge' | 'page' } | null = null
    let dragging = false
    let dx = 0
    const set = (px: number | null) => {
      if (px === null) { root.style.removeProperty('--sh-drag'); root.classList.remove('sh-dragging'); return }
      root.style.setProperty('--sh-drag', `${Math.max(0, Math.min(width(), px))}px`)
      root.classList.add('sh-dragging')
    }
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0]
      if (!t || e.touches.length > 1) return
      if (!open && t.clientX <= 28) start = { x: t.clientX, y: t.clientY, t: Date.now(), from: 'edge' }
      else if (open && t.clientX >= width() - 10) start = { x: t.clientX, y: t.clientY, t: Date.now(), from: 'page' }
      else start = null
      dragging = false
      dx = 0
    }
    const onMove = (e: TouchEvent) => {
      if (!start) return
      const t = e.touches[0]
      const mx = t.clientX - start.x
      const my = t.clientY - start.y
      if (!dragging) {
        if (Math.abs(my) > 12 && Math.abs(my) > Math.abs(mx)) { start = null; return }
        if (Math.abs(mx) < 8) return
        dragging = true
      }
      dx = mx
      set(start.from === 'edge' ? mx : width() + mx)
      if (e.cancelable) e.preventDefault()
    }
    const onEnd = () => {
      if (!start) return
      const fast = Date.now() - start.t < 250
      if (dragging) {
        if (start.from === 'edge') setOpen(dx > width() * 0.35 || (fast && dx > 30))
        else setOpen(!(dx < -width() * 0.3 || (fast && dx < -30)))
      }
      set(null)
      start = null
      dragging = false
    }
    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd)
    window.addEventListener('touchcancel', onEnd)
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
      set(null)
    }
  }, [enabled, open, setOpen])
}

export function usePanelOpen(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(() => localStorage.getItem(PANEL_KEY) !== 'false')
  const set = (v: boolean) => { localStorage.setItem(PANEL_KEY, String(v)); setOpen(v) }
  return [open, set]
}

function Badge({ count, title }: { count?: number | null; title?: string }) {
  if (!count) return null
  return <span className="sh-badge" role="status" aria-label={title}>{count > 99 ? '99+' : count}</span>
}

export function Rail({ tabs, bottom, active, onSelect, panelOpen, onTogglePanel, badges }: {
  tabs: TabDef[]
  bottom: TabDef
  active: string
  onSelect: (id: string) => void
  panelOpen: boolean
  onTogglePanel: () => void
  badges: Record<string, { count: number; title?: string }>
}) {
  return (
    <nav className="sh-rail" aria-label="Totem">
      <button type="button" className="sh-rail-brand" onClick={onTogglePanel} title={panelOpen ? 'Hide chats' : 'Show chats'} aria-label={panelOpen ? 'Hide chats' : 'Show chats'}>
        <img src={totemLogo} alt="" className="sh-rail-logo" />
        {!panelOpen && <span className="sh-rail-brand-toggle"><TI icon={IconLayoutSidebar} size={18} /></span>}
      </button>
      <div className="sh-rail-tabs">
        {tabs.map((t) => (
          <button key={t.id} type="button" className={`sh-rail-btn ${active === t.id ? 'on' : ''}`} onClick={() => onSelect(t.id)} title={t.label} aria-label={t.label} aria-current={active === t.id ? 'page' : undefined}>
            <Hi icon={t.icon} size={21} />
            <Badge count={badges[t.id]?.count} title={badges[t.id]?.title} />
            <span className="sh-tip">{t.label}</span>
          </button>
        ))}
      </div>
      <button type="button" className={`sh-rail-btn sh-rail-bottom ${active === bottom.id ? 'on' : ''}`} onClick={() => onSelect(bottom.id)} title={bottom.label} aria-label={bottom.label}>
        <Hi icon={bottom.icon} size={21} />
        <span className="sh-tip">{bottom.label}</span>
      </button>
    </nav>
  )
}

function Brand() {
  return <span className="sh-brand"><span className="brand-name">Totem</span></span>
}

export function SidePanel({ onOpenChat, onNotifications, unread, onCollapse }: {
  onOpenChat: () => void
  onNotifications: () => void
  unread: number
  onCollapse: () => void
}) {
  const activeId = useChat((s) => s.activeId)
  const [search, setSearch] = useState(0)
  return (
    <aside className="sh-panel" aria-label="Chats">
      <div className="sh-panel-head">
        <Brand />
        <div className="sh-panel-actions">
          <button type="button" className="sh-icon" onClick={onNotifications} aria-label="Notifications" title="Notifications">
            <TI icon={IconBell} size={19} />
            {unread > 0 && <span className="sh-dot" />}
          </button>
          <button type="button" className="sh-icon" onClick={() => setSearch((n) => n + 1)} aria-label="Search chats" title="Search chats">
            <TI icon={IconSearch} size={19} />
          </button>
          <button type="button" className="sh-icon" onClick={onCollapse} aria-label="Hide chats" title="Hide chats">
            <TI icon={IconLayoutSidebarLeftCollapse} size={19} />
          </button>
        </div>
      </div>
      <button type="button" className="sh-new" onClick={() => { setActive(null); onOpenChat() }}>
        <TI icon={IconEdit} size={18} />New chat
      </button>
      <ThreadList activeId={activeId} onOpen={(id) => { setActive(id); onOpenChat() }} searchSignal={search} />
    </aside>
  )
}

/**
 * Phone: the bottom-right corner is a "new chat" button on every screen but the
 * chat itself — the quickest way from a todo list or a calendar to asking Totem
 * something. It replaced the utilities launcher there, which on a phone mostly
 * went unused; the drawer still reaches everything that launcher did.
 */
export function NewChatFab({ onNewChat, onVoice }: { onNewChat: () => void; onVoice: () => void }) {
  return (
    <>
      {/* Voice in one tap: a new chat that opens straight into voice mode. */}
      <button type="button" className="sh-fab sh-fab-voice" onClick={onVoice} aria-label="Talk to Totem" title="Voice mode">
        <TI icon={IconWaveSine} size={21} stroke={2} />
      </button>
      <button type="button" className="sh-fab" onClick={onNewChat} aria-label="New chat" title="New chat">
        <TI icon={IconEdit} size={22} stroke={2} />
      </button>
    </>
  )
}

export function MobileBar({ title, onMenu, onNewChat }: { title: string; onMenu: () => void; onNewChat: () => void }) {
  return (
    <header className="sh-mbar">
      <button type="button" className="sh-icon" onClick={onMenu} aria-label="Menu"><TI icon={IconMenu} size={22} /></button>
      <span className="sh-mbar-title">{title}</span>
      <button type="button" className="sh-icon" onClick={onNewChat} aria-label="New chat"><TI icon={IconEdit} size={20} /></button>
    </header>
  )
}

export function MobileDrawer({ open, onClose, tabs, active, onSelect, onOpenChat, badges, onNotifications, unread }: {
  open: boolean
  onClose: () => void
  tabs: TabDef[]
  active: string
  onSelect: (id: string) => void
  onOpenChat: () => void
  badges: Record<string, { count: number; title?: string }>
  onNotifications: () => void
  unread: number
}) {
  const activeId = useChat((s) => s.activeId)
  const [search, setSearch] = useState(0)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  const go = (id: string) => { onSelect(id); onClose() }
  return (
    <>
      <div className={`sh-scrim ${open ? 'show' : ''}`} onClick={onClose} />
      <aside className={`sh-drawer ${open ? 'open' : ''}`} aria-hidden={!open} aria-label="Menu">
        <div className="sh-panel-head">
          <Brand />
          <div className="sh-panel-actions">
            <button type="button" className="sh-icon" onClick={() => { onNotifications(); onClose() }} aria-label="Notifications">
              <TI icon={IconBell} size={20} />
              {unread > 0 && <span className="sh-dot" />}
            </button>
            <button type="button" className="sh-icon" onClick={() => setSearch((n) => n + 1)} aria-label="Search chats"><TI icon={IconSearch} size={20} /></button>
            <button type="button" className="sh-icon" onClick={onClose} aria-label="Close"><TI icon={IconX} size={21} /></button>
          </div>
        </div>
        <div className="sh-drawer-scroll">
          <button type="button" className="sh-new" onClick={() => { setActive(null); onOpenChat(); onClose() }}>
            <TI icon={IconEdit} size={19} />New chat
          </button>
          <div className="sh-drawer-nav">
            {tabs.map((t) => (
              <button key={t.id} type="button" className={`sh-drawer-item ${active === t.id ? 'on' : ''}`} onClick={() => go(t.id)}>
                <Hi icon={t.icon} size={20} />
                <span>{t.label}</span>
                <Badge count={badges[t.id]?.count} title={badges[t.id]?.title} />
              </button>
            ))}
          </div>
          <ThreadList activeId={activeId} onOpen={(id) => { setActive(id); onOpenChat(); onClose() }} searchSignal={search} />
        </div>
      </aside>
    </>
  )
}

