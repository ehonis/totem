import { beforeEach, describe, expect, it } from 'vitest'
import { draftFor, getState, threadChoice } from './store'
import type { ChatThread } from './types'

// threadChoice reads the store's module state; seed the parts it uses.
beforeEach(() => {
  const s = getState() as any
  s.providers = [
    { id: 'codex', name: 'Codex', driver: 'codex', supportsModelPicker: true },
    { id: 'claude', name: 'Claude', driver: 'claude', supportsModelPicker: true },
  ]
  s.defaultProvider = 'codex'
  s.defaultModel = null
  s.models = { codex: [{ id: 'gpt-6-luna' }, { id: 'gpt-6.1-sol' }], claude: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-opus-5-5' }] }
  s.projects = [
    { id: 'work', name: 'Work', provider: 'claude', modelSettings: { modelId: 'claude-opus-5-5', effort: 'high' } },
    // A folder with no model of its own follows Work.
    { id: 'clienta', name: 'Client A', parentId: 'work' },
    { id: 'own', name: 'Own', parentId: 'work', provider: 'codex', modelSettings: { modelId: 'gpt-6.1-sol' } },
    { id: 'bare', name: 'Bare' },
    { id: 'gone', name: 'Gone account', provider: 'opencode', modelSettings: { modelId: 'x' } },
  ]
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

  describe('project defaults', () => {
    const agentMade = (projectId: string, patch: Partial<ChatThread> = {}) => ({
      id: 't2', title: 'T1 ticket', createdAt: 0, updatedAt: 0, projectId,
      messages: [{ id: 'o', role: 'assistant', content: 'A ticket came in', createdAt: 0 }],
      ...patch,
    }) as ChatThread

    it('starts a new chat in a folder with no model of its own on its project\'s model', () => {
      const { provider, settings } = threadChoice(null, { projectId: 'clienta' })
      expect(provider).toBe('claude')
      expect(settings.modelId).toBe('claude-opus-5-5')
      expect(settings.effort).toBe('high')
    })

    it('starts a new chat in a folder with its own model on the folder\'s model', () => {
      const { provider, settings } = threadChoice(null, { projectId: 'own' })
      expect(provider).toBe('codex')
      expect(settings.modelId).toBe('gpt-6.1-sol')
    })

    it('starts a new chat in a project with no default, or on an account that is gone, on Settings → Providers', () => {
      expect(threadChoice(null, { projectId: 'bare' })).toMatchObject({ provider: 'codex', settings: { modelId: 'gpt-6-luna' } })
      expect(threadChoice(null, { projectId: 'gone' })).toMatchObject({ provider: 'codex', settings: { modelId: 'gpt-6-luna' } })
    })

    it('lets a model picked for the new chat win over the project\'s', () => {
      const { provider, settings } = threadChoice(null, { provider: 'codex', modelSettings: { modelId: 'gpt-6.1-sol' }, projectId: 'clienta' })
      expect(provider).toBe('codex')
      expect(settings.modelId).toBe('gpt-6.1-sol')
    })

    it('gives an agent-made chat that stored no model its folder\'s default, whatever was picked elsewhere', () => {
      const { provider, settings } = threadChoice(agentMade('clienta'), { provider: 'codex', modelSettings: { modelId: 'gpt-6.1-sol' } })
      expect(provider).toBe('claude')
      expect(settings.modelId).toBe('claude-opus-5-5')
    })

    it('keeps a chat\'s saved model over its project\'s and over a pick made in another chat', () => {
      const t = agentMade('clienta', { provider: 'claude', modelSettings: { modelId: 'claude-sonnet-5-5' } })
      const { provider, settings } = threadChoice(t, { provider: 'codex', modelSettings: { modelId: 'gpt-6.1-sol' } })
      expect(provider).toBe('claude')
      expect(settings.modelId).toBe('claude-sonnet-5-5')
    })

    it('does not carry a project\'s model onto another account', () => {
      const t = agentMade('clienta', { provider: 'codex' })
      expect(threadChoice(t).settings.modelId).toBe('gpt-6-luna')
    })
  })

  describe('a model picked in a draft', () => {
    const pick = { key: 'new:project:clienta', provider: 'codex', modelSettings: { modelId: 'gpt-6.1-sol' } as any }

    it('applies to the new chat in the place it was picked', () => {
      const draft = draftFor(pick, 'new:project:clienta', { open: false, projectId: 'clienta' })
      expect(threadChoice(null, draft)).toMatchObject({ provider: 'codex', settings: { modelId: 'gpt-6.1-sol' } })
    })

    it('does not follow him to a new chat in another place', () => {
      const draft = draftFor(pick, 'new:project:work', { open: false, projectId: 'work' })
      expect(draft).toEqual({ projectId: 'work' })
      expect(threadChoice(null, draft)).toMatchObject({ provider: 'claude', settings: { modelId: 'claude-opus-5-5' } })
    })

    it('is never passed for an open chat', () => {
      expect(draftFor(pick, 't2', { open: true, projectId: 'clienta' })).toEqual({})
    })
  })
})
