import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useChat, showAgents, focusAgent } from './store'
import type { AgentInfo, AgentStep, ChatThread, ToolPart } from './types'
import { TI, ProviderLogo, toolApp, toolIcon, formatDuration, agentName } from './ui'
import { IconX, IconCheck, IconChevronRight, IconBrain, IconRobot } from './icons'
import Spark from './Spark'
import Markdown from '../components/Markdown'

// The agents a chat's agent handed work to, beside the thread the way T3 Code
// shows a thread's sub-agents: one row per agent with its status, model, time
// and what it is doing right now. Past T3, a row opens into that agent's own log:
// what it thought, what it said and every tool it called, live while it runs.
// The bridge fills `part.agent` from the parent's stream or the child CLI's own
// session file (chat/subagents.mjs); this panel only reads the thread.

export interface AgentEntry { toolId: string; agent: AgentInfo; part: ToolPart }

function collect(thread?: ChatThread): AgentEntry[] {
  const out: AgentEntry[] = []
  for (const m of thread?.messages || []) {
    for (const p of m.parts || []) if (p.type === 'tool' && p.agent) out.push({ toolId: p.id, agent: p.agent, part: p })
  }
  return out
}

export function useThreadAgents(threadId: string | null) {
  const thread = useChat((s) => (threadId ? s.threads.find((t) => t.id === threadId) : undefined))
  return useMemo(() => collect(thread), [thread])
}

const STATUS: Record<AgentInfo['status'], string> = { running: 'Working', done: 'Done', error: 'Failed', stopped: 'Stopped' }

/** Re-render every second while something is running, for the elapsed clocks. */
function useTick(on: boolean) {
  const [, setT] = useState(0)
  useEffect(() => {
    if (!on) return
    const id = setInterval(() => setT((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [on])
}

const elapsedOf = (a: AgentInfo) => (a.startedAt ? (a.endedAt || Date.now()) - a.startedAt : 0)
const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const firstLine = (s?: string) => (s || '').split('\n').map((l) => l.trim()).find(Boolean) || ''

/** What it is doing right now, in one line. */
export function agentNow(a: AgentInfo) {
  const last = a.steps[a.steps.length - 1]
  if (last?.kind === 'tool') return [last.title, last.detail].filter(Boolean).join(' · ')
  if (last?.kind === 'thinking') return 'Thinking'
  if (last?.kind === 'text') return firstLine(last.text)
  return a.progress || 'Starting'
}

export const agentHeading = (a: AgentInfo) => (a.via === 'cli' ? `Asked ${agentName(a.provider)}` : `${agentName(a.provider)} sub-agent${a.name && a.name !== 'general-purpose' ? ` · ${a.name}` : ''}`)

export default function AgentsPanel({ threadId }: { threadId: string | null }) {
  const open = useChat((s) => s.agentsOpen)
  const focus = useChat((s) => s.agentFocus)
  const agents = useThreadAgents(threadId)
  const running = agents.filter((e) => e.agent.status === 'running').length
  useTick(open && running > 0)
  const body = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') showAgents(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Unchosen, the panel opens the agent working now (or the latest one); '' means
  // the owner folded them all.
  const shown = focus === '' ? null
    : agents.find((e) => e.toolId === focus) || [...agents].reverse().find((e) => e.agent.status === 'running') || agents[agents.length - 1] || null
  const shownSteps = shown?.agent.steps.length || 0

  // A live log stays pinned to its newest step unless the owner scrolled up to read.
  useLayoutEffect(() => {
    const el = body.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [shownSteps, shown?.toolId, shown?.agent.status])

  if (!open || !threadId) return null
  const done = agents.length - running
  return (
    <aside className="vc vc-artifact vc-agents" aria-label="Agents">
      <header className="vc-art-head">
        <div className="vc-agents-title">
          <TI icon={IconRobot} size={18} />
          <span>Agents</span>
          {agents.length > 0 && (
            <span className="vc-agents-count">{[running ? `${running} working` : '', done ? `${done} finished` : ''].filter(Boolean).join(' · ')}</span>
          )}
        </div>
        <div className="vc-art-actions">
          <button type="button" className="vc-icon-btn" onClick={() => showAgents(false)} aria-label="Hide" title="Hide">
            <TI icon={IconX} size={17} />
          </button>
        </div>
      </header>
      <div
        className="vc-art-body vc-agents-body"
        ref={body}
        onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}
      >
        {!agents.length ? (
          <div className="vc-agents-empty">
            <TI icon={IconRobot} size={26} />
            <p className="vc-agents-empty-title">No agents yet</p>
            <p>When this chat hands work to another agent, such as a Claude sub-agent or Codex run from a command, it shows up here with its status and its own log.</p>
          </div>
        ) : agents.map((e) => (
          <AgentRow key={e.toolId} entry={e} open={shown?.toolId === e.toolId} onToggle={() => focusAgent(shown?.toolId === e.toolId ? '' : e.toolId)} />
        ))}
      </div>
    </aside>
  )
}

function AgentRow({ entry, open, onToggle }: { entry: AgentEntry; open: boolean; onToggle: () => void }) {
  const a = entry.agent
  const ms = elapsedOf(a)
  const meta = [
    agentHeading(a),
    a.model,
    ms >= 1000 ? formatDuration(ms) : '',
    a.tokens ? `${compact(a.tokens)} tokens` : '',
    a.steps.length ? `${a.steps.length + (a.dropped || 0)} step${a.steps.length === 1 ? '' : 's'}` : a.toolUses ? `${a.toolUses} tool use${a.toolUses === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ')
  return (
    <div className={`vc-agent ${a.status} ${open ? 'open' : ''}`}>
      <button type="button" className="vc-agent-head" onClick={onToggle} aria-expanded={open}>
        <ProviderLogo driver={a.provider} name={agentName(a.provider)} size={20} />
        <span className="vc-agent-main">
          <span className="vc-agent-title">{a.title || firstLine(a.prompt) || agentHeading(a)}</span>
          <span className="vc-agent-meta">{meta}</span>
          {a.status === 'running' && <span className="vc-agent-now vc-shimmer">{agentNow(a)}</span>}
        </span>
        <span className={`vc-agent-status ${a.status}`}><i />{STATUS[a.status]}</span>
        <TI icon={IconChevronRight} size={14} className={`vc-chev ${open ? 'open' : ''}`} />
      </button>
      {open && <AgentLog agent={a} />}
    </div>
  )
}

function AgentLog({ agent: a }: { agent: AgentInfo }) {
  const running = a.status === 'running'
  const lastText = [...a.steps].reverse().find((s) => s.kind === 'text')?.text?.trim()
  const showResult = !running && a.summary && a.summary.trim() !== lastText
  const name = agentName(a.provider)
  return (
    <div className="vc-agent-log">
      {a.prompt && (
        <details className="vc-agent-prompt">
          <summary>What it was asked</summary>
          <pre>{a.prompt}</pre>
        </details>
      )}
      {!!a.dropped && <p className="vc-agent-note">{a.dropped} earlier step{a.dropped === 1 ? '' : 's'} not kept.</p>}
      {a.steps.map((s) => <StepRow key={s.id} step={s} />)}
      {running && !a.steps.length && (
        <p className="vc-agent-note"><Spark size={13} />{a.log === 'none' ? `${name} is working. Its steps aren't visible from here; what it hands back appears when it finishes.` : `Waiting for ${name}'s first step…`}</p>
      )}
      {a.log === 'none' && !running && !a.steps.length && (
        <p className="vc-agent-note">{a.via === 'cli' && (a.provider === 'codex' || a.provider === 'claude') ? `${name}'s own log wasn't found, so only what it printed is shown.` : `${name} keeps no log Totem can read, so only what it printed is shown.`}</p>
      )}
      {showResult && (
        <div className="vc-agent-result">
          <div className="vc-tool-io-label">{a.status === 'error' ? 'Error' : 'Handed back'}</div>
          <Markdown text={a.summary!} />
        </div>
      )}
    </div>
  )
}

function StepRow({ step }: { step: AgentStep }) {
  const [open, setOpen] = useState(false)
  if (step.kind === 'thinking') {
    return (
      <button type="button" className={`vc-astep thinking ${open ? 'open' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <TI icon={IconBrain} size={14} />
        <span>{step.text}</span>
      </button>
    )
  }
  if (step.kind === 'text') return <div className="vc-astep text"><Markdown text={step.text || ''} /></div>
  const hasBody = !!(step.input || step.output)
  const app = toolApp(step.server)
  const ms = step.endedAt && step.at ? step.endedAt - step.at : 0
  return (
    <div className={`vc-tool vc-astep-tool ${step.status || 'done'}`}>
      <button type="button" className="vc-tool-head" onClick={() => hasBody && setOpen((o) => !o)} aria-expanded={open} disabled={!hasBody}>
        <span className="vc-tool-icon"><TI icon={toolIcon(step.tool || 'tool', step.server, step.detail)} size={14} /></span>
        <span className="vc-tool-title">{step.title || 'Tool call'}</span>
        {app && <span className="vc-tool-app">{app.label}</span>}
        {step.detail && <span className="vc-tool-detail">{step.detail}</span>}
        <span className="vc-tool-state">
          {step.status === 'running' ? <Spark size={12} />
            : step.status === 'error' ? <TI icon={IconX} size={13} />
              : ms >= 1500 ? formatDuration(ms) : <TI icon={IconCheck} size={13} />}
        </span>
        {hasBody && <TI icon={IconChevronRight} size={13} className={`vc-chev ${open ? 'open' : ''}`} />}
      </button>
      {open && (
        <div className="vc-tool-body">
          {step.input && <div className="vc-tool-io"><div className="vc-tool-io-label">{step.tool === 'command' ? 'Command' : 'Input'}</div><pre>{step.input}</pre></div>}
          {step.output && <div className="vc-tool-io"><div className="vc-tool-io-label">{step.status === 'error' ? 'Error' : 'Result'}</div><pre>{step.output}</pre></div>}
        </div>
      )}
    </div>
  )
}

/** In the reply: the call that started an agent, always in view. Opens the panel on it. */
export function AgentCard({ tool }: { tool: ToolPart }) {
  const a = tool.agent!
  const running = a.status === 'running'
  useTick(running)
  const ms = elapsedOf(a)
  return (
    <div className={`vc-agent-card ${a.status}`}>
      <button type="button" className="vc-agent-card-head" onClick={() => showAgents(true, tool.id)} title="Open in the Agents panel">
        <ProviderLogo driver={a.provider} name={agentName(a.provider)} size={16} />
        <span className="vc-agent-card-name">{agentHeading(a)}</span>
        <span className={`vc-agent-card-text ${running ? 'vc-shimmer' : ''}`}>{running ? agentNow(a) : a.title || firstLine(a.prompt) || tool.title}</span>
        <span className="vc-agent-card-state">
          {running ? <Spark size={13} /> : a.status === 'error' ? <TI icon={IconX} size={14} /> : <TI icon={IconCheck} size={14} />}
          {ms >= 1500 && <span>{formatDuration(ms)}</span>}
        </span>
        <span className="vc-agent-card-open">{running ? 'Watch' : 'View'}</span>
      </button>
    </div>
  )
}

/** The header chip that brings the panel back. */
export function AgentsChip({ threadId }: { threadId: string | null }) {
  const agents = useThreadAgents(threadId)
  const open = useChat((s) => s.agentsOpen)
  if (!agents.length || open) return null
  const running = agents.filter((e) => e.agent.status === 'running').length
  return (
    <button type="button" className={`vc-agents-chip ${running ? 'live' : ''}`} onClick={() => showAgents(true)} title="Agents this chat started">
      <TI icon={IconRobot} size={15} />
      <span>{running ? `${running} working` : `${agents.length} agent${agents.length === 1 ? '' : 's'}`}</span>
    </button>
  )
}
