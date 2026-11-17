import React from 'react'
import { createRoot } from 'react-dom/client'
import Composer from './Composer'
import ContextMeter from './ContextMeter'
import QueuedMessages from './QueuedMessages'
import TaskBar from '../work/TaskBar'
import { loadWork } from '../work/state'
import type { ChatThread, QueuedMessage } from './types'

// Not part of the app: scripts/web-layout.test.mjs bundles this page and draws the
// real composer with the tab over its top edge (the linked task and the queued
// messages), with the real CSS, in each combination: `?v=both|task|queue|many`.
// The test feeds the task through a fictional /api/todos/board.

const noop = () => {}
const at = Date.now()
const queued = (n: number): QueuedMessage[] =>
  ['Fictional-errors.csv', 'Then check the second share too', 'And write up what changed'].slice(0, n).map((text, i) => ({ id: `q${i}`, text, createdAt: at + i }))
const v = new URLSearchParams(location.search).get('v') || 'both'
const task = v !== 'queue'
const queue = v === 'task' ? [] : queued(v === 'many' ? 3 : 1)
const thread = { id: 'fixture', taskId: task ? 'k1' : undefined } as unknown as ChatThread

function Harness() {
  return (
    <div className="vc" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div className="vc-dock">
        <Composer
          value="" onChange={noop} onSend={noop} onStop={noop} onSteer={() => true} onQueue={() => true} busy
          placeholder="Steer this reply: add context or change course"
          leftSlot={<ContextMeter s={{ used: 401_000, max: 1_000_000, percent: 40, autoCompactAt: null, tone: null, at }} />}
          rightSlot={<span className="vc-model-group" style={{ color: 'var(--text)', fontSize: 14 }}>Fictional model · Medium</span>}
          above={
            <div className="vc-above">
              <TaskBar thread={thread} draftTaskId={null} projectId={null} />
              {queue.length > 0 && <QueuedMessages queue={queue} canSteer editingId={null} onEdit={noop} onCancelEdit={noop} onSteer={noop} onRemove={noop} onMove={noop} />}
            </div>
          }
        />
      </div>
    </div>
  )
}

void loadWork()
createRoot(document.getElementById('root')!).render(<Harness />)
