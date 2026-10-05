// Fold one stream event into an assistant message. The TypeScript twin of
// applyEvent in chat/turn.mjs — the bridge runs the same fold to persist the
// reply, so what the browser shows mid-stream is what the file will hold. Keep
// the two in step.
import type { ChatMessage, ToolPart } from './types'

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
      })
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
    case 'steer': {
      // The owner's words mid-reply, kept where they landed among the steps.
      const st = event.steer || {}
      if (!st.text || parts.some((p) => p.type === 'steer' && p.id === st.id)) return msg
      parts.push({ type: 'steer', id: st.id || `s${parts.length}`, text: st.text, via: st.via || 'live', createdAt: st.createdAt || now })
      // What it says after the steer is a new paragraph in the copyable text too.
      if (msg.content) next.content = msg.content.replace(/\s*$/, '\n\n')
      return next
    }
    default:
      return msg
  }
}
