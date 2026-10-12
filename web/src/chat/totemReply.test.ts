import { describe, it, expect } from 'vitest'
import { foldTotemCalls, readTotemCall } from './totemReply'
import type { Part, ToolPart } from './types'

const call = (tool: 'ask' | 'wait', status: ToolPart['status'], input: object, output?: object | string): ToolPart => ({
  type: 'tool', id: Math.random().toString(36).slice(2), kind: 'mcp', title: tool, status, server: 'totems', tool,
  input: JSON.stringify(input, null, 2), output: typeof output === 'string' ? output : output ? JSON.stringify(output) : undefined,
})
const totem = { id: 'strava', name: 'Strava Coach', icon: 'bike' }

describe('a totem answering in a chat', () => {
  it('reads a finished ask as that totem saying its reply', () => {
    const a = readTotemCall(call('ask', 'done', { chat: 'c', totem: 'strava', message: 'How was my week?' }, { askId: 'ask-1', status: 'done', totem, reply: 'Three rides, 92 miles.' }))
    expect(a).toMatchObject({ status: 'done', name: 'Strava Coach', icon: 'bike', reply: 'Three rides, 92 miles.', question: 'How was my week?', totemId: 'strava' })
  })

  it('keeps a running ask as asking, with the totem id from its input', () => {
    expect(readTotemCall(call('ask', 'running', { chat: 'c', totem: 'strava', message: 'x' }))).toMatchObject({ status: 'asking', totemId: 'strava' })
  })

  it('reads a reply out of output the bridge clipped', () => {
    const clipped = `{"fetchedAt":"x","askId":"ask-1","status":"done","totem":{"id":"strava","name":"Strava Coach","icon":"bike"},"reply":"A long answer \\"quoted\\" that was cut`
    expect(readTotemCall(call('ask', 'done', { totem: 'strava' }, clipped))).toMatchObject({ status: 'done', name: 'Strava Coach', reply: 'A long answer "quoted" that was cut' })
  })

  it('folds the waits on a slow ask into the ask', () => {
    const parts: Part[] = [
      { type: 'text', text: 'Asking him.' },
      call('ask', 'done', { totem: 'strava', message: 'q' }, { askId: 'ask-1', status: 'working', totem }),
      call('wait', 'done', { askId: 'ask-1' }, { askId: 'ask-1', status: 'working', totem }),
      call('wait', 'done', { askId: 'ask-1' }, { askId: 'ask-1', status: 'done', totem, reply: 'Done now.' }),
    ]
    const { at, skip } = foldTotemCalls(parts)
    expect([...at.keys()]).toEqual([1])
    expect([...skip]).toEqual([2, 3])
    expect(at.get(1)).toMatchObject({ status: 'done', reply: 'Done now.', question: 'q', name: 'Strava Coach' })
  })

  it('shows a wait still running as working, and a wait for an earlier turn\'s ask on its own', () => {
    const live = foldTotemCalls([call('ask', 'done', { totem: 'strava' }, { askId: 'ask-1', status: 'working', totem }), call('wait', 'running', { askId: 'ask-1' })])
    expect(live.at.get(0)?.status).toBe('working')
    const orphan = foldTotemCalls([call('wait', 'done', { askId: 'ask-9' }, { askId: 'ask-9', status: 'done', totem, reply: 'Late answer.' })])
    expect(orphan.at.get(0)).toMatchObject({ status: 'done', reply: 'Late answer.' })
  })

  it('turns a failed call or an error status into an error', () => {
    expect(readTotemCall(call('ask', 'error', { totem: 'strava' }, 'no totem with id strava'))).toMatchObject({ status: 'error', error: 'no totem with id strava' })
    expect(readTotemCall(call('ask', 'done', { totem: 'strava' }, { askId: 'a', status: 'error', totem, error: 'Codex is signed out' }))).toMatchObject({ status: 'error', error: 'Codex is signed out' })
  })

  it('leaves other tools alone', () => {
    const other: ToolPart = { type: 'tool', id: 'x', kind: 'mcp', title: 'Looked up tasks', status: 'done', server: 'tasks', tool: 'get_tasks' }
    expect(foldTotemCalls([other]).at.size).toBe(0)
  })
})
