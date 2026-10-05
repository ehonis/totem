import React, { useState } from 'react'
import type { ToolPart } from './types'
import { TI, toolApp, toolIcon, formatDuration } from './ui'
import { IconChevronRight, IconX, IconCheck } from './icons'
import Spark from './Spark'

// A run of consecutive tool calls inside a reply. Collapsed it is one line —
// what the agent is doing right now while it works, a summary once it has
// finished — because the answer is the point and the steps are the receipt.
// Expanded, each call is a card with what went in and what came back.

function summarize(tools: ToolPart[], live: boolean) {
  const running = tools.find((t) => t.status === 'running')
  if (live && running) return { text: running.title + (running.detail ? ` · ${running.detail}` : ''), running: true }
  const apps = [...new Set(tools.map((t) => toolApp(t.server)?.label).filter(Boolean))] as string[]
  const failed = tools.filter((t) => t.status === 'error').length
  const steps = `${tools.length} step${tools.length === 1 ? '' : 's'}`
  let text: string
  if (tools.length === 1) text = tools[0].title + (tools[0].detail ? ` · ${tools[0].detail}` : '')
  else if (apps.length) text = `Used ${apps.slice(0, 3).join(', ')}${apps.length > 3 ? ` and ${apps.length - 3} more` : ''} · ${steps}`
  else text = `Worked through ${steps}`
  if (failed) text += ` · ${failed} failed`
  return { text, running: false }
}

function elapsed(tools: ToolPart[]) {
  const start = Math.min(...tools.map((t) => t.startedAt || Infinity))
  const end = Math.max(...tools.map((t) => t.endedAt || 0))
  return Number.isFinite(start) && end > start ? end - start : 0
}

function ToolCard({ tool }: { tool: ToolPart }) {
  const [open, setOpen] = useState(false)
  const app = toolApp(tool.server)
  const hasBody = !!(tool.input || tool.output)
  const ms = tool.endedAt && tool.startedAt ? tool.endedAt - tool.startedAt : 0
  return (
    <div className={`vc-tool ${tool.status}`}>
      <button type="button" className="vc-tool-head" onClick={() => hasBody && setOpen((o) => !o)} aria-expanded={open} disabled={!hasBody}>
        <span className="vc-tool-icon"><TI icon={toolIcon(tool.kind, tool.server, tool.detail)} size={15} /></span>
        <span className="vc-tool-title">{tool.title}</span>
        {app && <span className="vc-tool-app">{app.label}</span>}
        {tool.detail && <span className="vc-tool-detail">{tool.detail}</span>}
        <span className="vc-tool-state">
          {tool.status === 'running' ? <Spark size={13} />
            : tool.status === 'error' ? <TI icon={IconX} size={14} />
              : ms >= 1500 ? formatDuration(ms) : <TI icon={IconCheck} size={14} />}
        </span>
        {hasBody && <TI icon={IconChevronRight} size={14} className={`vc-chev ${open ? 'open' : ''}`} />}
      </button>
      {open && (
        <div className="vc-tool-body">
          {tool.input && (
            <div className="vc-tool-io">
              <div className="vc-tool-io-label">{tool.kind === 'command' ? 'Command' : 'Input'}</div>
              <pre>{tool.input}</pre>
            </div>
          )}
          {tool.output && (
            <div className="vc-tool-io">
              <div className="vc-tool-io-label">{tool.status === 'error' ? 'Error' : 'Result'}</div>
              <pre>{tool.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function WorkLog({ tools, live }: { tools: ToolPart[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  const { text, running } = summarize(tools, live)
  const ms = elapsed(tools)
  const icon = toolIcon(tools[tools.length - 1].kind, tools[tools.length - 1].server, tools[tools.length - 1].detail)
  return (
    <div className={`vc-worklog ${open ? 'open' : ''}`}>
      <button type="button" className="vc-worklog-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {running ? <Spark size={15} /> : <TI icon={icon} size={15} />}
        <span className={`vc-worklog-text ${running ? 'vc-shimmer' : ''}`}>{text}</span>
        {!running && ms > 1500 && <span className="vc-worklog-time">{formatDuration(ms)}</span>}
        <TI icon={IconChevronRight} size={14} className={`vc-chev ${open ? 'open' : ''}`} />
      </button>
      {open && <div className="vc-worklog-list">{tools.map((t) => <ToolCard key={t.id} tool={t} />)}</div>}
    </div>
  )
}
