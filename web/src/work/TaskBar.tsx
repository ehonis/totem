import React, { useRef, useState } from 'react'
import { linkTask, clearTaskDraft } from '../chat/store'
import type { ChatThread } from '../chat/types'
import { TI } from '../chat/ui'
import { IconCircleCheck, IconChecklist, IconLink, IconX, IconTable } from '../chat/icons'
import { dueLabel } from './groups'
import { TaskPicker } from './pickers'
import { completeTask, findTask, useWork } from './state'
import './work.css'

// The strip over the composer that says which task a chat is for, drawn like the
// queue's drawer: the task (a click shows it in the chats panel's Tasks face), its
// due day, Mark done, and the link to change or drop it. On a new chat started
// from a task it says so, with × to start a plain chat instead.

/** Ask the chats panel to turn to its Tasks face (ProjectNav listens). */
export const showTasksPanel = () => window.dispatchEvent(new CustomEvent('totem:panel-mode', { detail: 'tasks' }))

interface Props {
  /** The open chat, once it has messages. */
  thread: ChatThread | null
  /** A new chat being started from a task. */
  draftTaskId: string | null
  /** The chat's project, where a task made from the picker is filed. */
  projectId: string | null
  onShowPanel?: () => void
}

/** Nothing (and no task reads) unless the chat has a task. */
export default function TaskBar(props: Props) {
  const ref = props.thread?.taskId || props.draftTaskId
  return ref ? <TaskStrip {...props} taskRef={ref} /> : null
}

function TaskStrip({ thread, projectId, onShowPanel, taskRef: ref }: Props & { taskRef: string }) {
  // Subscribing keeps the store fresh while the strip is up.
  const task = useWork(() => findTask(ref))
  const loaded = useWork((s) => s.loaded)
  const [picking, setPicking] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const due = task && !task.done ? dueLabel(task.dueDate, new Date()) : null
  const reveal = () => { showTasksPanel(); onShowPanel?.() }
  const title = task?.title || (loaded ? 'A task that is no longer on your list' : 'Reading the task…')
  return (
    <div className="wk-taskbar" role="group" aria-label="Linked task">
      <TI icon={task?.kind === 'sheet' ? IconTable : IconChecklist} size={14} className="wk-taskbar-icon" />
      <span className="wk-taskbar-label">{thread ? 'Task' : 'New chat for'}</span>
      <button type="button" className={`wk-taskbar-title ${task ? '' : 'gone'}`} onClick={task ? reveal : undefined} title={task ? `${task.title}: show it in the Tasks panel` : undefined}>
        {title}{task?.done ? ' (done)' : ''}
      </button>
      {due && <span className={`wk-due ${due.tone}`}>{due.text}</span>}
      {thread && task?.kind === 'local' && !task.done && (
        <button type="button" className="wk-taskbar-btn" onClick={() => completeTask(task.ref)} title="Mark the task done">
          <TI icon={IconCircleCheck} size={14} />Done
        </button>
      )}
      {thread ? (
        <button ref={anchor} type="button" className="wk-taskbar-btn" onClick={() => setPicking((v) => !v)} aria-label="Change or unlink the task" title="Change or unlink the task">
          <TI icon={IconLink} size={14} />
        </button>
      ) : (
        <button type="button" className="wk-taskbar-btn" onClick={clearTaskDraft} aria-label="Start a plain chat instead" title="Start a plain chat instead">
          <TI icon={IconX} size={14} />
        </button>
      )}
      {thread && picking && (
        <TaskPicker
          open anchor={anchor} onClose={() => setPicking(false)} align="end"
          value={thread.taskId || null} projectId={projectId}
          onPick={(next) => linkTask(thread.id, next)}
        />
      )}
    </div>
  )
}
