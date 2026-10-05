// Dragging a chat in the panel onto a project, a folder, or Home moves it there.
// Desktop only: on a touch screen a long press is the context menu's, and the
// menu's "Move to…" does the same job.
import { useState } from 'react'
import type React from 'react'
import { moveThread, threadTitle, getState } from './store'
import { pushToast } from '../toast'

const THREAD_TYPE = 'application/x-totem-thread'

export const canDragThreads = () => typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches

/** Props for a draggable chat row. */
export function dragThreadProps(id: string): Partial<React.HTMLAttributes<HTMLElement>> & { draggable?: boolean } {
  if (!canDragThreads()) return {}
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(THREAD_TYPE, id)
      e.dataTransfer.effectAllowed = 'move'
    },
  }
}

/**
 * A place a chat can be dropped: `target` is a project or folder id, or null
 * for Home. Returns the props to spread and whether a chat is over it.
 */
export function useThreadDrop(target: string | null, label: string) {
  const [over, setOver] = useState(false)
  const isThread = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes(THREAD_TYPE)
  const props = {
    onDragOver: (e: React.DragEvent) => {
      if (!isThread(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (!over) setOver(true)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(false)
    },
    onDrop: (e: React.DragEvent) => {
      if (!isThread(e)) return
      e.preventDefault()
      setOver(false)
      const id = e.dataTransfer.getData(THREAD_TYPE)
      const t = getState().threads.find((x) => x.id === id)
      if (!t || (t.projectId || null) === target) return
      moveThread(id, target)
      pushToast(`Moved “${threadTitle(t)}” to ${label}`, 'info')
    },
  }
  return { over, props }
}
