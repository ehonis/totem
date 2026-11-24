import React from 'react'
import { createRoot } from 'react-dom/client'
import { ChatBubbleLeftRightIcon, Cog6ToothIcon } from '../icons'
import { MobileDrawer, SidePanel } from '../components/Shell'
import { syncThreads } from './store'
import { drafts } from './draftsWeb'

// Not part of the app: scripts/web-layout.test.mjs bundles this page and draws
// the real chats panel (desktop) or phone drawer around ChatsNav, with the real
// CSS, against a stub bridge that lists long fictional chats (some linked to
// fictional tasks). `?phone=1` draws the drawer, `?desktop=macos|windows` the desktop app's chrome, `?drafts=1` adds
// unsent drafts (two new chats and one on "Fictional chat 1").
const q = new URLSearchParams(location.search)
if (q.get('desktop')) document.documentElement.dataset.desktop = q.get('desktop')!
if (q.get('drafts')) {
  const home = { place: { kind: 'home' as const } }
  drafts.write('new:harness-a', { text: 'Fictional draft about the week ahead' }, home)
  drafts.write('new:harness-b', { attachments: [{ id: 'harnessfile1', name: 'plan.pdf', mime: 'application/pdf', size: 1, kind: 'file' }] }, { place: { kind: 'task', id: 'k1' } })
  drafts.write('c1', { text: 'Fictional unsent reply' }, home)
}
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
      <SidePanel onOpenChat={noop} chatShowing onNotifications={noop} unread={0} onCollapse={noop} />
      <main className="main" />
    </div>
  )
}

void syncThreads()
createRoot(document.getElementById('root')!).render(<Harness />)
