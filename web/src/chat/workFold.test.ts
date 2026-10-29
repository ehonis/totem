import { describe, it, expect } from 'vitest'
import { foldWork, workSources, summarizeWork } from './workFold'
import type { ToolPart } from './types'

const tool = (id: string, extra: Partial<ToolPart> = {}): ToolPart => ({ type: 'tool', id, kind: 'mcp', title: `Did ${id}`, status: 'done', ...extra })
const text = (key: string) => ({ kind: 'text' as const, text: key, key })
const tools = (key: string, ...t: ToolPart[]) => ({ kind: 'tools' as const, tools: t, key })

describe('foldWork', () => {
  it('folds the narration and calls before the answer, and leaves the answer out', () => {
    const out = foldWork([text('Let me look.'), tools('w1', tool('a')), text('Now the calendar.'), tools('w2', tool('b')), text('Here it is.')])
    expect(out.map((b) => b.kind)).toEqual(['work', 'text'])
    const work = out[0] as Extract<(typeof out)[number], { kind: 'work' }>
    expect(work.items.map((i) => i.key)).toEqual(['Let me look.', 'w1', 'Now the calendar.', 'w2'])
    expect((out[1] as { text: string }).text).toBe('Here it is.')
  })

  it('keeps what the owner acts on outside the fold, in place', () => {
    const out = foldWork([tools('w1', tool('a')), { kind: 'proposal', key: 'p' }, tools('w2', tool('b')), text('done')])
    expect(out.map((b) => b.kind)).toEqual(['work', 'proposal', 'text'])
  })

  it('leaves a reply with no calls alone', () => {
    const list = [text('hi')]
    expect(foldWork(list)).toBe(list)
  })

  it('keeps what the agent says in sight while it works, each run of calls one step', () => {
    const list = [text('Let me look.'), tools('w1', tool('a')), text('Now the calendar.'), tools('w2', tool('b', { status: 'running' }))]
    const out = foldWork(list, false)
    expect(out.map((b) => b.kind)).toEqual(['text', 'work', 'text', 'work'])
    expect((out[1] as Extract<(typeof out)[number], { kind: 'work' }>).items.map((i) => i.key)).toEqual(['w1'])
    // A new key once it settles, so the fold mounts closed.
    expect(out[1].key).not.toBe(foldWork([...list, text('Here it is.')])[0].key)
  })

  it('folds the lead-in to a sub-agent with the calls before it', () => {
    const out = foldWork([text('Checking.'), tools('w1', tool('a')), text('Handing off.'), { kind: 'agent', key: 'a1' }, text('Result.')])
    expect(out.map((b) => b.kind)).toEqual(['work', 'agent', 'text'])
  })
})

describe('workSources', () => {
  it('names each connector once, in first-use order, with its logo', () => {
    const s = workSources([
      tool('a', { server: 'microsoft_365', app: 'Microsoft 365' }),
      tool('b', { server: 'tasks' }),
      tool('c', { server: 'microsoft_365', app: 'Microsoft 365', logo: 'https://example.com/m365.png' }),
      tool('d', { kind: 'command' }),
    ])
    expect(s.map((x) => x.label)).toEqual(['Microsoft 365', 'Tasks'])
    expect(s[0].logo).toBe('https://example.com/m365.png')
  })
})

describe('summarizeWork', () => {
  it('says what was used', () => {
    const t = [tool('a', { server: 'microsoft_365', app: 'Microsoft 365' }), tool('b', { server: 'gmail' }), tool('c', { server: 'tasks' })]
    expect(summarizeWork(t, false).text).toBe('Used Microsoft 365, Mail and 1 more · 3 steps')
  })

  it('shows the running call while live', () => {
    const r = summarizeWork([tool('a'), tool('b', { status: 'running', detail: 'inbox' })], true)
    expect(r).toEqual({ text: 'Did b · inbox', running: true })
  })
})
