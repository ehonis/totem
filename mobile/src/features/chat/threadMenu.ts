// A chat's "…" menu (web ThreadList's ThreadMenu, MoveMenu and SnoozeMenu) as
// one native UIMenu: read state, settle, snooze with T3's presets in a submenu,
// rename, regenerate the title, pin, move to a project or folder, project
// context, keep, delete. Used by the drawer rows (long-press) and the chat's
// title (tap).
import { router } from 'expo-router'
import type { MenuAction } from '@react-native-menu/menu'
import {
  getState, keepThread, moveThread, regenerateTitle, removeThread, renameThread, setProjectContext, threadTitle,
} from '../../lib/chat/store'
import { snoozePresets, type Shelf } from '../../lib/chat/settle'
import type { ChatThread } from '../../lib/chat/types'
import { pushToast } from '../../lib/toast'
import { prompt } from '../../ui/menu'
import { markRead, markUnread, setPinned, settleThread, snoozeThread, unsettleThread, wakeThread } from './threadOps'

export function threadMenu(t: ChatThread, shelf: Shelf, live: boolean): { actions: MenuAction[]; run: (id: string) => void } {
  const { projects } = getState()
  const inProject = !!(t.projectId && projects.some((p) => p.id === t.projectId))
  const presets = snoozePresets(new Date())
  const asked = t.messages.some((m) => m.role === 'user')
  const roots = projects.filter((p) => !p.parentId)
  const moveRows = roots.flatMap((p) => [{ p, folder: false }, ...projects.filter((f) => f.parentId === p.id).map((f) => ({ p: f, folder: true }))])

  const actions: MenuAction[] = [
    {
      id: 'state', title: '', displayInline: true, subactions: [
        t.needsReply ? { id: 'read', title: 'Mark as read', image: 'envelope.open' } : { id: 'unread', title: 'Mark as unread', image: 'envelope.badge' },
        shelf === 'settled'
          ? { id: 'unsettle', title: 'Un-settle', image: 'arrow.uturn.backward' }
          : { id: 'settle', title: 'Settle', image: 'checkmark', attributes: live ? { disabled: true } : undefined },
        shelf === 'snoozed'
          ? { id: 'wake', title: 'Wake now', image: 'alarm' }
          : {
              id: 'snooze', title: 'Snooze', image: 'clock', subactions: [
                ...presets.map((p) => ({ id: `snooze:${p.until}`, title: p.label, subtitle: p.when })),
                { id: 'snooze-custom', title: 'Custom…' },
              ],
            },
      ],
    },
    { id: 'rename', title: 'Rename', image: 'pencil' },
    ...(asked ? [{ id: 'retitle', title: 'Regenerate title and icon', image: 'sparkles' }] : []),
    { id: 'pin', title: t.pinned ? 'Unpin' : 'Pin', image: t.pinned ? 'pin.slash' : 'pin' },
    {
      id: 'move', title: 'Move to…', image: 'folder', subactions: [
        ...(inProject ? [{ id: 'move:', title: 'Home (no project)', image: 'house' }] : []),
        ...moveRows.map(({ p, folder }) => ({ id: `move:${p.id}`, title: folder ? `   ${p.name}` : p.name, image: folder ? 'folder' : undefined, attributes: p.id === t.projectId ? { disabled: true } : undefined })),
        ...(!projects.length ? [{ id: 'noop', title: 'No projects yet. Make one from the Projects list.', attributes: { disabled: true } }] : []),
      ],
    },
    ...(inProject ? [{ id: 'context', title: t.projectContextOff ? 'Use project context' : 'Leave out project context', image: t.projectContextOff ? 'folder' : 'folder.badge.minus' }] : []),
    ...(t.kind === 'temporary' ? [{ id: 'keep', title: 'Keep this chat', image: 'checkmark' }] : []),
    { id: 'danger', title: '', displayInline: true, subactions: [{ id: 'delete', title: 'Delete', image: 'trash', attributes: { destructive: true } }] },
  ]

  const run = (id: string) => {
    if (id === 'read') markRead(t.id)
    else if (id === 'unread') markUnread(t.id)
    else if (id === 'settle') settleThread(t.id)
    else if (id === 'unsettle') unsettleThread(t.id)
    else if (id === 'wake') wakeThread(t.id)
    else if (id.startsWith('snooze:')) snoozeThread(t.id, Number(id.slice(7)))
    else if (id === 'snooze-custom') router.push({ pathname: '/chat/snooze', params: { id: t.id } })
    else if (id === 'rename') {
      prompt('Rename chat', { defaultValue: threadTitle(t) }).then((v) => { if (v && v !== threadTitle(t)) renameThread(t.id, v) })
    } else if (id === 'retitle') regenerateTitle(t.id)
    else if (id === 'pin') setPinned(t.id, !t.pinned)
    else if (id.startsWith('move:')) {
      const pid = id.slice(5) || null
      const p = pid ? projects.find((x) => x.id === pid) : null
      moveThread(t.id, pid)
      pushToast(`Moved “${threadTitle(t)}” to ${p ? p.name : 'Home'}`, 'info')
    } else if (id === 'context') setProjectContext(t.id, !!t.projectContextOff)
    else if (id === 'keep') keepThread(t.id)
    else if (id === 'delete') {
      removeThread(t.id)
      pushToast(`Deleted “${threadTitle(t)}”`, 'info')
    }
  }
  return { actions, run }
}
