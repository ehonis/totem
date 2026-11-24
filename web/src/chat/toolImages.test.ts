import { describe, it, expect } from 'vitest'
import { applyEvent } from './reduce'
import type { ChatMessage, ToolPart } from './types'

// The client twin of chat/turn.mjs's fold (the app runs a byte copy of reduce.ts).
const reply = (): ChatMessage => ({ id: 'm1', role: 'assistant', content: '', createdAt: 0, parts: [] })

describe('a picture a tool returned', () => {
  it('goes on that call\'s card, not in the reply', () => {
    let m = applyEvent(reply(), { type: 'tool', tool: { id: 'r1', phase: 'start', title: 'Read', kind: 'read' } })
    m = applyEvent(m, { type: 'tool_image', toolId: 'r1', uploadId: 'up1', url: '/api/chat/uploads/up1?sig=s' })
    expect(m.parts.map((p) => p.type)).toEqual(['tool'])
    expect((m.parts[0] as ToolPart).images).toEqual([{ uploadId: 'up1', url: '/api/chat/uploads/up1?sig=s' }])
  })

  it('is dropped when the call is not in this reply, and stops at the cap', () => {
    let m = applyEvent(reply(), { type: 'tool_image', toolId: 'gone', uploadId: 'up1' })
    expect(m.parts).toEqual([])
    m = applyEvent(m, { type: 'tool', tool: { id: 'r1', phase: 'start', title: 'Read', kind: 'read' } })
    for (let i = 0; i < 25; i++) m = applyEvent(m, { type: 'tool_image', toolId: 'r1', uploadId: `up${i}` })
    expect((m.parts[0] as ToolPart).images).toHaveLength(20)
  })

  it('leaves an image with no call (one the CLI made) in the reply', () => {
    const m = applyEvent(reply(), { type: 'image', uploadId: 'gen1' })
    expect(m.parts).toEqual([{ type: 'image', uploadId: 'gen1', alt: '' }])
  })
})
