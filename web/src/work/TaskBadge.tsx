import React from 'react'
import { TI } from '../chat/ui'
import { IconChecklist, IconCircleCheck, IconTable } from '../chat/icons'
import { useChat } from '../chat/store'
import { folderLabel } from '../todos/folders'
import { dueLabel } from './groups'
import { findTask, useWork } from './state'
import { openTaskCard } from './card'
import './work.css'

// A chat's linked task on its card in the chats panel, the way T3 Code shows a
// thread's pull request: a glyph coloured by the task's state, its title, and
// its due day. One click opens the task's card (pinned at the chat's top right
// when that chat is open, a dialog otherwise). Done reads green with a check, as
// a merged PR reads violet.

export default function TaskBadge({ taskRef }: { taskRef: string }) {
  // Subscribing keeps the task store fresh while any card names a task.
  const task = useWork(() => findTask(taskRef))
  const loaded = useWork((s) => s.loaded)
  const projects = useChat((s) => s.projects)
  if (!task) {
    if (!loaded) return <span className="sb-task loading" aria-hidden><TI icon={IconChecklist} size={12} /><span className="sb-task-title">…</span></span>
    return <span className="sb-task gone" title="A task that is no longer on your list"><TI icon={IconChecklist} size={12} /><span className="sb-task-title">Task removed</span></span>
  }
  const due = task.done ? null : dueLabel(task.dueDate, new Date())
  const tone = task.done ? 'done' : due?.tone === 'overdue' || due?.tone === 'today' ? due.tone : 'open'
  const icon = task.done ? IconCircleCheck : task.kind === 'sheet' ? IconTable : IconChecklist
  const where = folderLabel(task.folderId, projects)
  const label = `Task: ${task.title}${task.done ? ' (done)' : due ? `, due ${due.text.toLowerCase()}` : ''}. ${where}`
  return (
    <button
      type="button"
      className={`sb-task ${tone}`}
      onClick={(e) => { e.stopPropagation(); openTaskCard(task.ref) }}
      onPointerDown={(e) => e.stopPropagation()}
      draggable={false}
      onDragStart={(e) => { e.preventDefault(); e.stopPropagation() }}
      aria-label={label}
      aria-haspopup="dialog"
      title={`${task.title}\n${task.done ? 'Done' : due ? `Due ${due.text}` : 'No due date'} · ${where}`}
    >
      <TI icon={icon} size={12} className="sb-task-icon" />
      <span className="sb-task-title">{task.title}</span>
      {due && <span className={`sb-task-due ${due.tone}`}>{due.text}</span>}
    </button>
  )
}
