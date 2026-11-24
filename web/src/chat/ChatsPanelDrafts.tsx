import { useRef, useState } from 'react'
import { useChat } from './store'
import { draftRows, type DraftRow as Row } from './draftsShared'
import { useDraftState, useShownDraft, openDraft, discardDraft } from './draftsWeb'
import ProjectIcon from './ProjectIcon'
import { TI } from './ui'
import { IconPencil, IconX, IconHome, IconChecklist, IconClock } from './icons'

function DraftRow({ row, onOpen, onDiscard }: { row: Row; onOpen: () => void; onDiscard: (el: HTMLElement, byKey: boolean) => void }) {
  const { preview, place, project, active } = row
  const icon = row.icon === 'task' ? <TI icon={IconChecklist} size={14} />
    : project ? <ProjectIcon p={project} size={14} />
    : <TI icon={row.icon === 'temporary' ? IconClock : IconHome} size={14} />
  const open = () => { openDraft(row.key); onOpen() }
  return (
    <div
      role="button"
      tabIndex={0}
      className={`vc-draft${active ? ' active' : ''}`}
      aria-current={active ? 'true' : undefined}
      aria-label={`Unsent draft in ${place}: ${preview}`}
      title={row.icon === 'task' ? `Unsent draft for a task in ${place}` : `Unsent draft in ${place}`}
      onClick={open}
      onKeyDown={(e) => {
        // Keys on the discard button are the button's.
        if ((e.target as HTMLElement).closest('button')) return
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() }
      }}
    >
      <span className="vc-draft-head">
        <TI icon={IconPencil} size={13} className="vc-draft-pen" />
        {icon}
        <span className="vc-draft-place">{place}</span>
        <button
          type="button"
          className="vc-draft-x"
          aria-label="Discard draft"
          title="Discard draft"
          // A click from the keyboard has no pointer detail; focus then moves on to a neighbouring row.
          onClick={(e) => { e.stopPropagation(); onDiscard(e.currentTarget.closest('.vc-draft') as HTMLElement, e.detail === 0); discardDraft(row.key) }}
        >
          <TI icon={IconX} size={12} />
        </button>
      </span>
      <span className="vc-draft-text">{preview}</span>
    </div>
  )
}

/**
 * Unsent new-chat drafts at the top of the chats list, as T3 Code lists them; nothing when there
 * are none. `homeOnly`: the list is scoped to Home, so drafts headed for a project are left out
 * (projectId null alone means every draft).
 */
export default function ChatsPanelDrafts({ projectId, homeOnly = false, onOpen }: { projectId: string | null; homeOnly?: boolean; onOpen: () => void }) {
  const state = useDraftState()
  const shown = useShownDraft()
  const projects = useChat((s) => s.projects)
  const [arrival, setArrival] = useState<{ key: string | null; listed: boolean }>({ key: null, listed: false })
  if (arrival.key !== shown) setArrival({ key: shown, listed: !!shown && !!state.drafts[shown] })
  const all = draftRows(state, { projects, projectId, shown, listedOnArrival: arrival.key === shown && arrival.listed })
  const rows = homeOnly ? all.filter((r) => !r.project) : all
  const blockRef = useRef<HTMLDivElement>(null)
  // A row discarded from the keyboard hands focus to the next row, else the one
  // before, else the list, once the row has gone.
  const moveFocus = (row: HTMLElement, byKey: boolean) => {
    if (!byKey) return
    const all = [...(blockRef.current?.querySelectorAll<HTMLElement>('.vc-draft') || [])]
    const i = all.indexOf(row)
    const next = all[i + 1] || all[i - 1] || null
    const list = blockRef.current?.closest<HTMLElement>('.vc-threads-list') || null
    requestAnimationFrame(() => {
      if (next?.isConnected) next.focus()
      else if (list) { if (!list.hasAttribute('tabindex')) list.tabIndex = -1; list.focus() }
    })
  }
  if (!rows.length) return null
  return (
    <div className="vc-drafts" aria-label="Unsent drafts" ref={blockRef}>
      {rows.map((r) => <DraftRow key={r.key} row={r} onOpen={onOpen} onDiscard={moveFocus} />)}
    </div>
  )
}
