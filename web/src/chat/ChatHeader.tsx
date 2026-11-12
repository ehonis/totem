import React, { useEffect, useMemo, useRef, type RefObject } from 'react'
import type { ChatThread, Project } from './types'
import { TI, useDismiss } from './ui'
import {
  IconEdit, IconFolder, IconFolderOff, IconGhost2, IconLayoutSidebar, IconLoader2, IconMenu, IconPinned, IconPlayerPlay,
  IconSettings, IconSparkles, IconUserPlus, IconChartBar,
} from './icons'
import ProjectIcon from './ProjectIcon'
import ThreadIcon from './ThreadIcon'
import UsageChips, { useUsageSummary } from './UsageChips'
import { HeaderChip, HeaderMenu, type HeaderItem } from './HeaderPanels'
import { useHeaderFold } from './headerFold'
import TotemsGlyph from '../components/TotemsIcon'
import { TotemIcon, TotemRunButton, useTotemRun } from '../totems/shared'

// The chat's top bar. It takes everything it shows as props, so the layout test
// (scripts/web-layout.test.mjs, through ChatHeader.harness.tsx) draws this very
// component; ChatView reads the store and hands it over. What folds as it narrows,
// and in what order, is chat/headerFold.ts. A control that folds away has a row in
// "…", so all of them stay reachable at any width; the two that only shrink are the
// avatars (a count on the add-totems button; its picker lists them) and the
// hover-only retitle button (also in the chat's own menu).

export interface ChatHeaderProps {
  /** What leads the header: the phone's drawer button, or Show chats and New chat while the chats panel is hidden. */
  start?: 'menu' | 'panel' | null
  onOpenMenu?: () => void
  onShowPanel?: () => void
  onNewChat: () => void
  parentProject?: Project
  project?: Project
  /** A project's home: its crumb is the last thing in the header and keeps its name. */
  projectIsLast?: boolean
  contextOff?: boolean
  onOpenProject: (id: string) => void
  onToggleContext?: () => void
  /** A totem's chat or a group chat: the "Totems /" crumb. */
  totemsCrumb?: boolean
  onTotems: (id?: string) => void
  /** The chat's own icon and the regenerate-title button, once it has messages. */
  thread?: Pick<ChatThread, 'icon' | 'kind'>
  title?: string
  retitling?: boolean
  onRetitle?: () => void
  /** A totem's chat: its run and settings buttons. */
  totem?: { id: string; job?: any }
  /** Any other chat can bring totems in; a group chat shows them. */
  members?: { ids: string[]; dir: Map<string, any>; onPick: () => void; ref?: RefObject<HTMLButtonElement> }
  panels: HeaderItem[]
  onManageUsage?: () => void
  onKeep?: () => void
  temporary?: { on: boolean; onToggle: () => void }
  /** The phone puts New chat at the end. */
  newChatAtEnd?: boolean
}

const shown = (el: HTMLElement | null, scope: Element): el is HTMLElement => {
  for (let n: HTMLElement | null = el; n && n !== scope; n = n.parentElement) if (getComputedStyle(n).display === 'none') return false
  return !!el
}

/** Back to where the totem picker was opened from: the add-totems button, or "…" once that has folded away. */
export function focusMembersControl(scope: ParentNode = document) {
  const top = scope.querySelector<HTMLElement>('.vc-top')
  if (!top) return
  const btn = top.querySelector<HTMLElement>('.vc-members-btn')
  const more = top.querySelector<HTMLElement>('.vc-top-more')
  if (shown(btn, top)) btn.focus()
  else if (shown(more, top)) more.focus()
}

const FOCUSABLE = 'input, textarea, select, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

/**
 * The totem picker beside the header. Escape anywhere, or a click outside it and
 * its button, closes it (useDismiss marks that Escape, so a side panel beside the
 * chat stays open); its first control takes focus however it was opened, and once
 * it closes, other than by a click elsewhere, focus goes back to where it came from.
 */
export function MembersPop({ anchor, onClose, children }: { anchor?: RefObject<HTMLElement>; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const how = useRef<'outside' | 'escape' | null>(null)
  const close = useRef(onClose)
  close.current = onClose
  const refs = useMemo(() => [ref, anchor].filter(Boolean) as RefObject<HTMLElement>[], [anchor])
  const dismiss = useMemo(() => (h: 'outside' | 'escape') => { how.current = h; close.current() }, [])
  useDismiss(true, refs, dismiss)
  useEffect(() => {
    const node = ref.current
    const scope = node?.parentElement || document
    node?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    // Only once it is really gone (StrictMode's rehearsal unmount leaves it in place).
    return () => { if (how.current !== 'outside') requestAnimationFrame(() => { if (!node?.isConnected) focusMembersControl(scope) }) }
  }, [])
  return <div ref={ref} className="vc-members-pop">{children}</div>
}

function openUsageSettings() {
  window.history.pushState(null, '', '/settings/usage')
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export default function ChatHeader(p: ChatHeaderProps) {
  const ref = useRef<HTMLElement>(null)
  const fold = useHeaderFold(ref)
  const totemRun = useTotemRun(p.totem?.job)
  const usage = useUsageSummary()
  const memberCount = p.members?.ids.length || 0

  // Each control's row in "…", in the order the header shows them.
  const rows: HeaderItem[] = []
  const crumbRow = (pr: Project, into: HeaderItem['into']): HeaderItem => ({ id: `project-${pr.id}`, glyph: <ProjectIcon p={pr} size={15} />, label: pr.name, title: `Open ${pr.name}`, into, open: () => p.onOpenProject(pr.id) })
  if (p.start === 'panel') {
    rows.push({ id: 'show-chats', icon: IconLayoutSidebar, label: 'Show chats', title: 'Show chats', into: 'start', open: () => p.onShowPanel?.() })
    rows.push({ id: 'new-chat', icon: IconEdit, label: 'New chat', title: 'New chat', into: 'start', open: p.onNewChat })
  }
  if (p.parentProject) rows.push(crumbRow(p.parentProject, 'menu'))
  if (p.project && !p.projectIsLast) rows.push(crumbRow(p.project, 'project'))
  if (p.totemsCrumb) rows.push({ id: 'all-totems', glyph: <TotemsGlyph width={15} height={15} />, label: 'All totems', title: 'All totems', into: 'menu', open: () => p.onTotems() })
  if (p.project && p.onToggleContext) {
    rows.push({
      id: 'context', icon: p.contextOff ? IconFolderOff : IconFolder, label: 'Project context', detail: p.contextOff ? 'Off' : 'On',
      tone: p.contextOff ? 'on' : '', title: `Turn ${p.project.name}'s context ${p.contextOff ? 'on' : 'off'} for this chat`, into: 'menu', open: p.onToggleContext,
    })
  }
  if (p.totem) {
    if (p.totem.job) rows.push({ id: 'totem-run', icon: totemRun.running ? IconLoader2 : IconPlayerPlay, label: totemRun.running ? 'Running' : 'Run now', title: totemRun.running ? 'Running now. Its report will appear here.' : 'Run now, without waiting for its schedule', disabled: totemRun.running, into: 'menu', open: totemRun.run })
    rows.push({ id: 'totem-settings', icon: IconSettings, label: 'Totem settings', title: "This totem's settings, memory and runs", into: 'menu', open: () => p.onTotems(p.totem!.id) })
  }
  if (p.members) {
    rows.push({
      id: 'members', icon: IconUserPlus, label: memberCount ? 'Totems in this chat' : 'Bring totems in', detail: memberCount ? String(memberCount) : undefined,
      title: memberCount ? 'Add or remove totems in this chat' : 'Bring totems into this chat', into: 'menu', focusAfter: '.vc-members-pop', open: p.members.onPick,
    })
  }
  rows.push(...p.panels)
  if (usage) rows.push({ id: 'usage', icon: IconChartBar, label: 'AI usage', detail: usage.text, tone: usage.tone as HeaderItem['tone'], title: usage.label, into: 'usage', open: p.onManageUsage || openUsageSettings })
  if (p.onKeep) rows.push({ id: 'keep', icon: IconPinned, label: 'Keep this chat', title: 'Keep this chat after midnight', into: 'menu', open: p.onKeep })
  if (p.temporary) rows.push({ id: 'temporary', icon: IconGhost2, label: 'Temporary chat', detail: p.temporary.on ? 'On' : 'Off', tone: p.temporary.on ? 'on' : '', title: p.temporary.on ? 'Turn off temporary chat' : 'Temporary chat — not kept past midnight', into: 'menu', open: p.temporary.onToggle })

  return (
    <header className="vc-top" ref={ref}>
      {p.start === 'menu' && (
        <button type="button" className="vc-icon-btn" onClick={p.onOpenMenu} aria-label="Menu"><TI icon={IconMenu} size={21} /></button>
      )}
      {/* Panel collapsed: the header carries what it held — show chats, new chat. */}
      {p.start === 'panel' && (
        <>
          <button type="button" className="vc-icon-btn" onClick={p.onShowPanel} aria-label="Show chats" title="Show chats" data-fold-into="start"><TI icon={IconLayoutSidebar} size={19} /></button>
          <button type="button" className="vc-icon-btn" onClick={p.onNewChat} aria-label="New chat" title="New chat" data-fold-into="start"><TI icon={IconEdit} size={19} /></button>
        </>
      )}
      <div className="vc-top-title-wrap">
        {p.parentProject && (
          <span className="vc-top-crumb outer" data-fold-into="menu">
            <button type="button" className="vc-top-project" onClick={() => p.onOpenProject(p.parentProject!.id)} title={`Open ${p.parentProject.name}`} aria-label={`Open ${p.parentProject.name}`}>
              <ProjectIcon p={p.parentProject} size={16} />
              <span>{p.parentProject.name}</span>
            </button>
            <span className="vc-top-sep" aria-hidden>/</span>
          </span>
        )}
        {p.project && (
          <span className={`vc-top-crumb ${p.projectIsLast ? 'last' : ''}`} data-fold-into={p.projectIsLast ? undefined : 'project'}>
            <button type="button" className={`vc-top-project ${p.contextOff ? 'context-off' : ''}`} onClick={() => p.onOpenProject(p.project!.id)} title={`Open ${p.project.name}`} aria-label={`Open ${p.project.name}`}>
              <ProjectIcon p={p.project} size={16} />
              <span>{p.project.name}</span>
            </button>
            {!p.projectIsLast && <span className="vc-top-sep" aria-hidden>/</span>}
          </span>
        )}
        {p.totemsCrumb && (
          <span className="vc-top-crumb outer" data-fold-into="menu">
            <button type="button" className="vc-top-project vc-top-totems" title="All totems" aria-label="All totems" onClick={() => p.onTotems()}>
              <TotemsGlyph width={15} height={15} /><span>Totems</span>
            </button>
            <span className="vc-top-sep" aria-hidden>/</span>
          </span>
        )}
        {p.thread && <ThreadIcon t={p.thread} size={17} busy={p.retitling} />}
        {p.title !== undefined && <div className={`vc-top-title ${p.retitling ? 'vc-shimmer vc-retitling' : ''}`}>{p.title}</div>}
        {p.thread && p.onRetitle && (
          <button type="button" className="vc-retitle" onClick={p.onRetitle} disabled={p.retitling} aria-label="Regenerate title and icon" title="Regenerate title and icon from the whole chat">
            <TI icon={IconSparkles} size={15} className={p.retitling ? 'vc-retitle-spin' : ''} />
          </button>
        )}
      </div>
      <div className="vc-top-right">
        {p.project && p.onToggleContext && (
          <button
            type="button"
            className={`vc-icon-btn ${p.contextOff ? 'on' : ''}`}
            onClick={p.onToggleContext}
            aria-pressed={p.contextOff}
            aria-label={p.contextOff ? 'Project context is off for this chat' : 'Project context is on for this chat'}
            title={p.contextOff
              ? `Project context off: this chat doesn't read ${p.project.name}'s instructions, memory or files, and adds nothing to them. Click to turn it on.`
              : `Project context on: this chat reads ${p.project.name}'s instructions, memory and files. Click to leave them out of this chat.`}
            data-fold-into="menu"
          >
            <TI icon={p.contextOff ? IconFolderOff : IconFolder} size={19} />
          </button>
        )}
        {p.totem?.job && <TotemRunButton job={p.totem.job} data-fold-into="menu" />}
        {p.totem && (
          <button type="button" className="vc-icon-btn" onClick={() => p.onTotems(p.totem!.id)} aria-label="Totem settings" title="This totem's settings, memory and runs" data-fold-into="menu"><TI icon={IconSettings} size={19} /></button>
        )}
        {p.members && (
          <span className="vc-members" data-fold-into="menu">
            {p.members.ids.slice(0, 4).map((id) => (
              <button key={id} type="button" className="vc-member" title={`${p.members!.dir.get(id)?.name || 'Totem'}: settings, memory and runs`} onClick={() => p.onTotems(id)}>
                <TotemIcon name={p.members!.dir.get(id)?.iconName} size={14} />
              </button>
            ))}
            <button ref={p.members.ref} type="button" className="vc-icon-btn vc-members-btn" onClick={p.members.onPick} aria-label={memberCount ? `Totems in this chat: ${memberCount}` : 'Bring totems into this chat'} title={memberCount ? 'Add or remove totems in this chat' : 'Bring totems into this chat'}>
              <TI icon={IconUserPlus} size={19} />
              {/* Stands in for the avatars once the header is too narrow for them. */}
              {!!memberCount && <span className="vc-members-count" aria-hidden>{memberCount}</span>}
            </button>
          </span>
        )}
        {p.panels.length > 0 && (
          <span className="vc-top-panels">
            {p.panels.map((item) => <HeaderChip key={item.id} item={item} />)}
          </span>
        )}
        <HeaderMenu items={rows} fold={fold} />
        <UsageChips onManage={p.onManageUsage} foldInto="usage" />
        {p.onKeep && (
          <button type="button" className="vc-btn sm" onClick={p.onKeep} title="Keep this chat after midnight" data-fold-into="menu">Keep</button>
        )}
        {p.temporary && (
          <button
            type="button"
            className={`vc-icon-btn ${p.temporary.on ? 'on' : ''}`}
            onClick={p.temporary.onToggle}
            aria-pressed={p.temporary.on}
            title={p.temporary.on ? 'Turn off temporary chat' : 'Temporary chat — not kept past midnight'}
            data-fold-into="menu"
          >
            <TI icon={IconGhost2} size={19} />
          </button>
        )}
        {p.newChatAtEnd && (
          // The phone's own New chat stays: a phone is never narrower than its header needs.
          <button type="button" className="vc-icon-btn" onClick={p.onNewChat} aria-label="New chat"><TI icon={IconEdit} size={19} /></button>
        )}
      </div>
    </header>
  )
}
