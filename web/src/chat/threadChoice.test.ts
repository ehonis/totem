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
    expect(settings.modelId).toBe('gpt-6.1-sol')
  })

  it('moves a chat saved on a retired preset to the model that last answered it', () => {
    const { settings } = threadChoice(thread({ modelSettings: { preset: 'auto', modelId: 'composer-2.5' } as any }))
    expect(settings.modelId).toBe('gpt-6.1-sol')
    expect(settings.preset).toBeUndefined()
  })

  it('starts a draft saved on a retired preset on the default model', () => {
    const { settings } = threadChoice(null, { provider: 'codex', modelSettings: { preset: 'thinking', modelId: 'composer-2.5' } as any })
    expect(settings.modelId).toBe('gpt-6-luna')
  })

  it('gives a brand-new chat the defaults', () => {
    const { settings } = threadChoice(null)
    expect(settings.modelId).toBe('gpt-6-luna')
  })
})
