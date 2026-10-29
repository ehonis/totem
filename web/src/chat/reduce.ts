// Fold one stream event into an assistant message. The TypeScript twin of
// applyEvent in chat/turn.mjs — the bridge runs the same fold to persist the
// reply, so what the browser shows mid-stream is what the file will hold. Keep
// the two in step.
import type { AgentInfo, AgentStep, ChatMessage, ToolPart } from './types'

const MAX_AGENT_STEPS = 400
const AGENT_KEYS = ['provider', 'via', 'name', 'title', 'prompt', 'model', 'status', 'progress', 'summary', 'tokens', 'toolUses', 'log', 'startedAt', 'endedAt'] as const

/** Twin of foldAgent in chat/subagents.mjs: one `agent` event into a card's agent. */
export function foldAgent(current: AgentInfo | undefined, event: { agent?: Partial<AgentInfo>; step?: AgentStep }): AgentInfo {
  const next: AgentInfo = { status: 'running', steps: [], provider: '', ...(current || {}) } as AgentInfo
  const patch = event.agent || {}
  for (const k of AGENT_KEYS) {
    const v = patch[k]
    if (v !== undefined && v !== null && v !== '') (next as any)[k] = v
  }
  const step = event.step
  if (step?.id || step?.kind) {
    const steps = next.steps.slice()
    const at = step.id ? steps.findIndex((s) => s.id === step.id) : -1
    if (at >= 0) steps[at] = { ...steps[at], ...step }
    else if (step.kind) steps.push({ ...step, id: step.id || `s${steps.length}` })
    if (steps.length > MAX_AGENT_STEPS) {
      next.dropped = (next.dropped || 0) + steps.length - MAX_AGENT_STEPS
      steps.splice(0, steps.length - MAX_AGENT_STEPS)
    }
    next.steps = steps
  }
  return next
}

export function applyEvent(msg: ChatMessage, event: any, now = Date.now()): ChatMessage {
  const parts = (msg.parts || []).slice()
  const next: ChatMessage = { ...msg, parts }
  switch (event.type) {
    case 'delta': {
      if (!event.text) return msg
      const tail = parts[parts.length - 1]
      if (tail?.type === 'text') parts[parts.length - 1] = { ...tail, text: tail.text + event.text }
      else parts.push({ type: 'text', text: event.text })
      next.content = (msg.content || '') + event.text
      return next
    }
    case 'tool': {
      const t = event.tool || {}
      const at = t.id ? parts.findIndex((p) => p.type === 'tool' && p.id === t.id) : -1
      if (t.phase === 'end') {
        let i = at
        if (i < 0) {
          for (let j = parts.length - 1; j >= 0; j--) {
            const p = parts[j]
            if (p.type === 'tool' && p.status === 'running') { i = j; break }
          }
        }
        if (i < 0) return msg
        const p = parts[i] as ToolPart
        parts[i] = { ...p, status: t.status === 'error' ? 'error' : 'done', endedAt: now, ...(t.output ? { output: t.output } : {}), ...(!p.detail && t.detail ? { detail: t.detail } : {}) }
        return next
      }
      if (at >= 0) return msg
      parts.push({
        type: 'tool', id: t.id || `t${parts.length}`, kind: t.kind || 'tool', title: t.title || 'Tool call',
        detail: t.detail || '', status: 'running', startedAt: now,
        ...(t.server ? { server: t.server } : {}), ...(t.tool ? { tool: t.tool } : {}), ...(t.input ? { input: t.input } : {}),
        ...(t.app ? { app: t.app } : {}), ...(t.logo ? { logo: t.logo } : {}),
      })
      return next
    }
    case 'agent': {
      // Another agent this one started, folded into the card that started it.
      const i = event.toolId ? parts.findIndex((p) => p.type === 'tool' && p.id === event.toolId) : -1
      if (i < 0) return msg
      const p = parts[i] as ToolPart
      // An agent starts with its provider; anything else on a plain card is not one.
      if (!p.agent && !event.agent?.provider) return msg
      parts[i] = { ...p, agent: foldAgent(p.agent, event) }
      return next
    }
    case 'image':
      if (!event.uploadId) return msg
      parts.push({ type: 'image', uploadId: event.uploadId, alt: event.alt || '', ...(event.url ? { url: event.url } : {}) })
      return next
    case 'file':
      if (!event.file?.uploadId) return msg
      parts.push({ type: 'file', ...event.file })
      return next
    case 'questions': {
      // Questions the agent asked: added where they were asked, updated in place
      // when answered or dismissed.
      const q = event.questions || {}
      if (!q.id) return msg
      const at = parts.findIndex((p) => p.type === 'questions' && p.id === q.id)
      if (at >= 0) parts[at] = { ...parts[at], ...q }
      else parts.push({ type: 'questions', ...q })
      return next
    }
    case 'steer': {
      // The owner's words mid-reply, kept where they landed among the steps.
      const st = event.steer || {}
      if ((!st.text && !st.attachments?.length) || parts.some((p) => p.type === 'steer' && p.id === st.id)) return msg
      parts.push({ type: 'steer', id: st.id || `s${parts.length}`, text: st.text || '', via: st.via || 'live', createdAt: st.createdAt || now, ...(st.attachments?.length ? { attachments: st.attachments } : {}) })
      // What it says after the steer is a new paragraph in the copyable text too.
      if (msg.content) next.content = msg.content.replace(/\s*$/, '\n\n')
      return next
    }
    default:
      return msg
  }
}
