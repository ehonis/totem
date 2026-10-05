import { beforeEach, describe, expect, it } from 'vitest'
import { getState, threadChoice } from './store'
import type { ChatThread } from './types'

// threadChoice reads the store's module state; seed the parts it uses.
beforeEach(() => {
  const s = getState() as any
  s.providers = [{ id: 'codex', name: 'Codex', driver: 'codex', supportsModelPicker: true }]
  s.defaultProvider = 'codex'
  s.defaultModel = null
  s.models = { codex: [{ id: 'gpt-6-luna' }, { id: 'gpt-6.1-sol' }] }
  s.prefs = { ...(s.prefs || {}), defaultPreset: 'auto', defaultLevel: 2 }
})

function thread(patch: Partial<ChatThread>): ChatThread {
  return {
    id: 't1', title: '', createdAt: 0, updatedAt: 0, provider: 'codex',
    messages: [
      { id: 'u', role: 'user', content: 'hi', createdAt: 0 },
      { id: 'a', role: 'assistant', content: 'ok', createdAt: 1, provider: 'codex', model: 'gpt-6.1-sol' },
    ],
    ...patch,
  } as ChatThread
}

describe('threadChoice', () => {
  it('keeps a chat with no saved settings on the model that last answered it', () => {
    const { provider, settings } = threadChoice(thread({ modelSettings: undefined }))
    expect(provider).toBe('codex')
    expect(settings.preset).toBe('manual')
    expect(settings.modelId).toBe('gpt-6.1-sol')
  })

  it('leaves a chat that chose Auto on Auto', () => {
    const { settings } = threadChoice(thread({ modelSettings: { preset: 'auto', modelId: 'gpt-6-luna' } }))
    expect(settings.preset).toBe('auto')
  })

  it('gives a brand-new chat the defaults', () => {
    const { settings } = threadChoice(null)
    expect(settings.preset).toBe('auto')
    expect(settings.modelId).toBe('gpt-6-luna')
  })
})
