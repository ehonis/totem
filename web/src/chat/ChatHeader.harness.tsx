import React from 'react'
import { createRoot } from 'react-dom/client'
import ChatHeader, { type ChatHeaderProps } from './ChatHeader'
import { panelItems, type PanelState } from './HeaderPanels'
import type { Project } from './types'
import { FOLD_STEPS, titleFloor } from './headerFold'

// Not part of the app: scripts/web-layout.test.mjs bundles this page and draws
// the real chat header in every shape it takes, beside a side panel, at widths
// down to 180px, with the real CSS. The usage pills are the real UsageChips, fed
// by the test (one provider or three). Each variant sits in its own .vc-split.

const project = (id: string, name: string, icon: string) => ({ id, name, icon }) as unknown as Project
const pix = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="60" height="40" fill="#ddd"/></svg>')
const allPanels = (waiting = false): PanelState => ({
  files: 12,
  agents: { total: 3, running: 2 },
  browser: { url: 'http://127.0.0.1:8766/stays', image: pix, live: true, waiting },
  open: { files: false, agents: false, browser: false },
})
const noop = () => {}
const dir = new Map<string, any>([
  ['a', { id: 'a', name: 'Daily brief', iconName: 'sun' }],
  ['b', { id: 'b', name: 'Networking', iconName: 'users' }],
  ['c', { id: 'c', name: 'Research', iconName: 'sparkles' }],
])
const thread = { icon: 'gift', kind: 'regular' as const }
// The test runs every variant with titles of several lengths (`?title=`).
const title = new URLSearchParams(location.search).get('title') || 'Pittsburgh stays for the November birthday weekend'
const base: ChatHeaderProps = { onNewChat: noop, onOpenProject: noop, onTotems: noop, panels: [], onManageUsage: noop }

export const VARIANTS: Record<string, ChatHeaderProps> = {
  // An ordinary chat with every side-panel chip.
  plain: { ...base, thread, title, onRetitle: noop, members: { ids: [], dir, onPick: noop }, panels: panelItems(allPanels(), noop) },
  // The agent waits on the owner in the browser.
  waiting: { ...base, thread, title, onRetitle: noop, members: { ids: [], dir, onPick: noop }, panels: panelItems(allPanels(true), noop) },
  // A group chat, the chats panel hidden.
  group: { ...base, start: 'panel', onShowPanel: noop, totemsCrumb: true, thread, title, onRetitle: noop, members: { ids: ['a', 'b', 'c'], dir, onPick: noop }, panels: panelItems(allPanels(), noop) },
  // A group chat in a folder of a project: two project crumbs, the project switch, the Totems crumb, avatars.
  projectGroup: {
    ...base, start: 'panel', onShowPanel: noop, parentProject: project('p1', 'Personal finance and planning', 'wallet'), project: project('p2', 'Trips and travel', 'plane'),
    onToggleContext: noop, totemsCrumb: true, thread, title, onRetitle: noop, members: { ids: ['a', 'b', 'c'], dir, onPick: noop }, panels: panelItems(allPanels(), noop),
  },
  // A totem's own chat: run and settings.
  totem: { ...base, totemsCrumb: true, thread, title: 'Daily brief', onRetitle: noop, totem: { id: 'a', job: dir.get('a') }, panels: panelItems(allPanels(), noop) },
  // A temporary chat with messages: Keep.
  temporary: { ...base, thread: { icon: '', kind: 'temporary' }, title, onRetitle: noop, members: { ids: [], dir, onPick: noop }, onKeep: noop, panels: panelItems(allPanels(), noop) },
  // A project's home: no title, the project's crumb keeps its name.
  projectHome: { ...base, start: 'panel', onShowPanel: noop, project: project('p2', 'Trips and travel', 'plane'), projectIsLast: true, onToggleContext: noop, panels: [] },
  // A new chat: the Temporary switch.
  newChat: { ...base, title: 'New chat', temporary: { on: false, onToggle: noop }, panels: [] },
  // The phone's header: the drawer button first, New chat last.
  phone: { ...base, start: 'menu', onOpenMenu: noop, newChatAtEnd: true, thread, title, onRetitle: noop, members: { ids: [], dir, onPick: noop }, panels: panelItems(allPanels(), noop) },
}

function Harness() {
  return (
    <>
      {Object.entries(VARIANTS).map(([id, props]) => (
        <div key={id} data-variant={id} style={{ height: 64, position: 'relative' }}>
          <div className="vc-split has-artifact">
            <div className="vc"><ChatHeader {...props} /></div>
            <div className="vc vc-artifact"><header className="vc-art-head" /></div>
          </div>
        </div>
      ))}
    </>
  )
}

// The test checks the header against the same floor the fold uses.
;(window as any).__titleFloor = titleFloor
;(window as any).__foldSteps = [...FOLD_STEPS]

const el = document.getElementById('root')
if (el) createRoot(el).render(<Harness />)
