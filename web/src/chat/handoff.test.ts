import { describe, it, expect } from 'vitest'
import { providerSwitches } from './handoff'
import type { ChatMessage } from './types'

let n = 0
const user = (): ChatMessage => ({ id: `u${n++}`, role: 'user', content: 'hi', createdAt: n })
const reply = (provider?: string): ChatMessage => ({ id: `a${n++}`, role: 'assistant', content: 'ok', createdAt: n, provider })

describe('providerSwitches', () => {
  it('marks the owner message that started each turn on a new account', () => {
    const u3 = user(), u4 = user()
    const s = providerSwitches([user(), reply('codex'), user(), reply('codex'), u3, reply('claude'), u4, reply('codex')])
    expect([...s]).toEqual([[u3.id, { from: 'codex', to: 'claude' }], [u4.id, { from: 'claude', to: 'codex' }]])
  })

  it('falls back to the reply when no owner message precedes it', () => {
    const b = reply('claude')
    expect([...providerSwitches([user(), reply('codex'), b])]).toEqual([[b.id, { from: 'codex', to: 'claude' }]])
  })

  it('ignores replies with no recorded provider', () => {
    expect(providerSwitches([user(), reply('codex'), user(), reply(undefined), user(), reply('codex')]).size).toBe(0)
  })

  it('has nothing to mark on a single-account chat', () => {
    expect(providerSwitches([user(), reply('claude')]).size).toBe(0)
    expect(providerSwitches([]).size).toBe(0)
  })
})
