import React, { useState } from 'react'
import type { QueuedMessage } from './types'
import { TI } from './ui'
import { IconListNumbers, IconChevronDown, IconGripVertical, IconPencil, IconCornerUpRight, IconX } from './icons'

/**
 * The messages waiting for the running reply, T3 Code's queued-runs drawer: a
 * strip on the composer's top edge, first in line first. Each one can be edited
 * in the composer, sent into the running reply as a steer, removed, or dragged
 * (or moved with the arrow keys on its grip) to another place in line.
 */
export default function QueuedMessages({ queue, canSteer, editingId, onEdit, onCancelEdit, onSteer, onRemove, onMove }: {
  queue: QueuedMessage[]
  /** A reply is running that can take a steer. */
  canSteer: boolean
  /** The message being edited in the composer, if any. */
  editingId: string | null
  onEdit: (q: QueuedMessage) => void
  onCancelEdit: () => void
  onSteer: (id: string) => void
  onRemove: (id: string) => void
  /** Put `id` before `beforeId` (null: last). */
  onMove: (id: string, beforeId: string | null) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const [dragging, setDragging] = useState<string | null>(null)
  // Where the dragged row would land: before this index (queue.length = last).
  const [dropAt, setDropAt] = useState<number | null>(null)
  if (!queue.length) return null
  const n = queue.length

  const moveTo = (id: string, at: number) => {
    const rest = queue.filter((q) => q.id !== id)
    const from = queue.findIndex((q) => q.id === id)
    const target = at > from ? at - 1 : at
    if (target === from) return
    onMove(id, rest[target]?.id ?? null)
  }

  const onGripKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); onMove(queue[i].id, queue[i - 1].id) }
    if (e.key === 'ArrowDown' && i < n - 1) { e.preventDefault(); onMove(queue[i].id, queue[i + 2]?.id ?? null) }
  }

  return (
    <div className="vc-queue" role="region" aria-label={`${n} queued message${n === 1 ? '' : 's'}`} aria-live="polite">
      <button type="button" className="vc-queue-head" onClick={() => setExpanded((x) => !x)} aria-expanded={expanded}
        aria-label={expanded ? 'Collapse queued messages' : 'Expand queued messages'}>
        <TI icon={IconListNumbers} size={12} />
        <span className="vc-queue-label">Queued</span>
        <span className="vc-queue-count">{n}</span>
        <span className="vc-queue-spacer" />
        <TI icon={IconChevronDown} size={14} className={`vc-queue-chevron ${expanded ? '' : 'collapsed'}`} />
      </button>
      {expanded && (
        <ol className="vc-queue-list">
          {queue.map((q, i) => {
            const editing = editingId === q.id
            const images = (q.attachments || []).filter((a) => a.kind === 'image')
            const files = (q.attachments || []).filter((a) => a.kind !== 'image')
            const preview = q.text.trim().replace(/\s+/g, ' ') || (files.length ? files.map((f) => f.name).join(', ') : images.length ? '' : 'Queued message')
            return (
              <li key={q.id}
                className={`vc-queue-row ${editing ? 'editing' : ''} ${dragging === q.id ? 'dragging' : ''}`}
                draggable={dragging === q.id}
                onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', q.id) }}
                onDragEnd={() => { setDragging(null); setDropAt(null) }}
                onDragOver={(e) => {
                  if (!dragging) return
                  e.preventDefault()
                  const r = e.currentTarget.getBoundingClientRect()
                  setDropAt(e.clientY > r.top + r.height / 2 ? i + 1 : i)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragging && dropAt != null) moveTo(dragging, dropAt)
                  setDragging(null); setDropAt(null)
                }}>
                {dropAt === i && dragging && <span className="vc-queue-drop top" />}
                {dropAt === i + 1 && i === n - 1 && dragging && <span className="vc-queue-drop bottom" />}
                {n > 1 ? (
                  <button type="button" className="vc-queue-btn vc-queue-grip" aria-label="Reorder queued message (drag, or press the arrow keys)"
                    title="Drag to reorder" onPointerDown={() => setDragging(q.id)} onPointerUp={() => setDragging(null)} onKeyDown={(e) => onGripKey(e, i)}>
                    <TI icon={IconGripVertical} size={13} />
                  </button>
                ) : <span className="vc-queue-grip-space" />}
                <span className="vc-queue-content" title={q.text || undefined}>
                  {images.map((a) => (
                    <span key={a.id} className="vc-queue-thumb">{a.url && <img src={a.url} alt="" />}</span>
                  ))}
                  <span className="vc-queue-text">{preview}</span>
                </span>
                <span className="vc-queue-actions">
                  {editing ? (
                    <button type="button" className="vc-queue-pill" onClick={onCancelEdit}>Cancel</button>
                  ) : (
                    <>
                      <button type="button" className="vc-queue-btn" onClick={() => onEdit(q)} aria-label="Edit queued message" title="Edit in the composer">
                        <TI icon={IconPencil} size={13} />
                      </button>
                      <button type="button" className="vc-queue-pill" onClick={() => onSteer(q.id)} disabled={!canSteer}
                        title={canSteer ? 'Send as a steer instead' : 'There is no active run to steer'}>
                        <TI icon={IconCornerUpRight} size={13} />Steer
                      </button>
                      <button type="button" className="vc-queue-btn" onClick={() => onRemove(q.id)} aria-label="Remove queued message" title="Remove from queue">
                        <TI icon={IconX} size={14} />
                      </button>
                    </>
                  )}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
