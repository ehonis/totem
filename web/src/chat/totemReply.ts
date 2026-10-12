import type { Part, ToolPart } from './types'

// A totem answering in a chat arrives as the host's totems__ask tool call (and,
// for a slow one, totems__wait calls with its askId; bridge "Totems in a chat").
// The chat shows each ask as one message from that totem instead of a tool row.

export interface TotemAnswer {
  askId?: string
  totemId?: string
  name?: string
  icon?: string
  /** asking: the call is running; working: it outlived one call and is still going. */
  status: 'asking' | 'working' | 'done' | 'error'
  question?: string
  reply?: string
  error?: string
}

export const isTotemCall = (p: Part): p is ToolPart =>
  p.type === 'tool' && p.server === 'totems' && (p.tool === 'ask' || p.tool === 'wait')

function parse(text?: string): any {
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

/** A string field out of JSON that may have been clipped (the bridge caps tool output). */
function field(text: string | undefined, name: string): string | undefined {
  const m = text ? new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(text) : null
  if (!m) return undefined
  try { return JSON.parse(`"${m[1]}"`) } catch { return m[1] }
}

/** What one ask or wait call says. */
export function readTotemCall(p: ToolPart): TotemAnswer {
  const input = parse(p.input) || {}
  const out = p.status === 'done' ? parse(p.output) : null
  const base: TotemAnswer = {
    askId: out?.askId || input.askId || field(p.output, 'askId') || field(p.input, 'askId'),
    totemId: out?.totem?.id || input.totem || field(p.input, 'totem'),
    name: out?.totem?.name || field(p.output, 'name'),
    icon: out?.totem?.icon || field(p.output, 'icon'),
    question: typeof input.message === 'string' ? input.message : field(p.input, 'message'),
    status: p.tool === 'wait' ? 'working' : 'asking',
  }
  if (p.status === 'running') return base
  if (p.status === 'error') return { ...base, status: 'error', error: p.output || 'The call failed' }
  const status = out?.status || field(p.output, 'status')
  if (status === 'done') return { ...base, status: 'done', reply: out?.reply ?? field(p.output, 'reply') ?? '' }
  if (status === 'error') return { ...base, status: 'error', error: out?.error || field(p.output, 'error') || 'No answer' }
  if (status === 'working') return { ...base, status: 'working' }
  // Not the bridge's shape (an old bridge, a tool error as text): say what came back.
  return { ...base, status: 'error', error: p.output || 'No answer' }
}

/**
 * Fold a reply's ask and wait calls into one answer per ask. `at` places each
 * answer at its ask's index; `skip` is every call drawn as part of another.
 */
export function foldTotemCalls(parts: Part[]): { at: Map<number, TotemAnswer>; skip: Set<number> } {
  const at = new Map<number, TotemAnswer>()
  const skip = new Set<number>()
  const byAsk = new Map<string, number>()
  parts.forEach((p, i) => {
    if (!isTotemCall(p)) return
    const a = readTotemCall(p)
    const home = a.askId ? byAsk.get(a.askId) : undefined
    if (p.tool === 'wait' && home !== undefined) {
      const prev = at.get(home)!
      // A wait that is still running keeps the ask "working", not "asking".
      at.set(home, { ...prev, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)), name: prev.name || a.name, icon: prev.icon || a.icon, question: prev.question || a.question, totemId: prev.totemId || a.totemId })
      skip.add(i)
      return
    }
    at.set(i, a)
    if (a.askId) byAsk.set(a.askId, i)
  })
  return { at, skip }
}
