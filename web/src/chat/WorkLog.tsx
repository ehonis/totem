import React, { useState } from 'react'
import type { ToolPart } from './types'
import { TI, toolApp, toolIcon, formatDuration } from './ui'
import { IconChevronRight, IconX, IconCheck } from './icons'
import { summarizeWork, workElapsed, workSources, type WorkItem, type WorkSource } from './workFold'
import Markdown from '../components/Markdown'
import Spark from './Spark'

// The working steps of a reply (workFold.ts). Collapsed it is one line — what
// the agent is doing right now while it works, a summary once it has finished,
// led by the logos of the connectors it used — because the answer is the point
// and the steps are the receipt. Expanded, it reads in order: what the agent
// said along the way, and each call as a card with what went in and came back.

/** A connector's own logo, or its glyph when it has none or the image fails. */
function Logo({ logo, server, kind = 'mcp', detail, size }: { logo?: string; server?: string; kind?: string; detail?: string; size: number }) {
  const [broken, setBroken] = useState(false)
  if (logo && !broken) return <img className="vc-tool-logo" src={logo} alt="" width={size} height={size} referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} />
  return <TI icon={toolIcon(kind, server, detail)} size={size} />
}

const STACK = 3

/** The sources' marks overlapped, like T3 Code's, with a count past three. */
function SourceStack({ sources }: { sources: WorkSource[] }) {
  return (
    <span className="vc-stack" aria-hidden>
      {sources.slice(0, STACK).map((s) => <span key={s.key} className="vc-stack-mark" title={s.label}><Logo logo={s.logo} server={s.server} size={12} /></span>)}
      {sources.length > STACK && <span className="vc-stack-mark vc-stack-more">+{sources.length - STACK}</span>}
    </span>
  )
}

function ToolCard({ tool }: { tool: ToolPart }) {
  const [open, setOpen] = useState(false)
  const app = tool.app || toolApp(tool.server)?.label
  const hasBody = !!(tool.input || tool.output)
  const ms = tool.endedAt && tool.startedAt ? tool.endedAt - tool.startedAt : 0
  return (
    <div className={`vc-tool ${tool.status}`}>
      <button type="button" className="vc-tool-head" onClick={() => hasBody && setOpen((o) => !o)} aria-expanded={open} disabled={!hasBody}>
        <span className="vc-tool-icon"><Logo logo={tool.logo} server={tool.server} kind={tool.kind} detail={tool.detail} size={15} /></span>
        <span className="vc-tool-title">{tool.title}</span>
        {app && <span className="vc-tool-app">{app}</span>}
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

export default function WorkLog({ items, live }: { items: WorkItem[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  const tools = items.flatMap((i) => (i.kind === 'tools' ? i.tools : []))
  const { text, running } = summarizeWork(tools, live)
  const sources = workSources(tools)
  const ms = workElapsed(tools)
  const last = tools[tools.length - 1]
  return (
    <div className={`vc-worklog ${open ? 'open' : ''}`}>
      <button type="button" className="vc-worklog-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {sources.length ? <SourceStack sources={sources} />
          : running ? <Spark size={15} />
            : <Logo logo={last.logo} server={last.server} kind={last.kind} detail={last.detail} size={15} />}
        <span className={`vc-worklog-text ${running ? 'vc-shimmer' : ''}`}>{text}</span>
        {running && sources.length ? <Spark size={13} /> : !running && ms > 1500 && <span className="vc-worklog-time">{formatDuration(ms)}</span>}
        <TI icon={IconChevronRight} size={14} className={`vc-chev ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <div className="vc-worklog-list">
          {items.map((i) => i.kind === 'text'
            ? <Markdown key={i.key} text={i.text} className="vc-worklog-note" />
            : i.tools.map((t) => <ToolCard key={t.id} tool={t} />))}
        </div>
      )}
    </div>
  )
}
