import React from 'react'
import { createRoot } from 'react-dom/client'
import { ChatBubbleLeftRightIcon, Cog6ToothIcon } from '../icons'
import { MobileDrawer, SidePanel } from '../components/Shell'
import { syncThreads } from './store'

// Not part of the app: scripts/web-layout.test.mjs bundles this page and draws
// the real chats panel (desktop) or phone drawer around one face of ChatsNav,
// with the real CSS, against a stub bridge that lists long fictional chats,
// totems and tasks. `?face=chats|totems|tasks` picks the face, `?phone=1` the
// drawer, `?desktop=macos|windows` the desktop app's chrome.
const q = new URLSearchParams(location.search)
localStorage.setItem('totem.panel.mode', q.get('face') || 'chats')
if (q.get('desktop')) document.documentElement.dataset.desktop = q.get('desktop')!
const noop = () => {}
const chat = { id: 'chat', label: 'Chat', icon: ChatBubbleLeftRightIcon }
const settings = { id: 'settings', label: 'Settings', icon: Cog6ToothIcon }

function Harness() {
  if (q.get('phone')) {
    return (
      <div className="app shell drawer-open">
        <main className="main" />
        <MobileDrawer open onClose={noop} tabs={[chat]} bottom={settings} active="chat" onSelect={noop} onOpenChat={noop} badges={{}} onNotifications={noop} unread={0} />
      </div>
    )
  }
  return (
    <div className="app shell panel-open">
      <nav className="sh-rail" />
      <SidePanel onOpenChat={noop} onNotifications={noop} unread={0} onCollapse={noop} />
      <main className="main" />
    </div>
  )
}

void syncThreads()
createRoot(document.getElementById('root')!).render(<Harness />)
