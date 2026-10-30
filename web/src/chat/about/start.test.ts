// The round trip: a card's context becomes a text upload, waits in pendingContext
// for the composer, and the chat opens on a new thread.
import { afterEach, describe, expect, it, vi } from 'vitest'

const uploaded: { blob: Blob; name: string; opts: unknown }[] = []
vi.mock('../api', () => ({
  uploadFile: vi.fn(async (blob: Blob, name: string, opts: unknown) => {
    uploaded.push({ blob, name, opts })
    return { id: 'u1', name, mime: 'text/markdown', size: blob.size, kind: 'text' }
  }),
}))
const openProject = vi.fn()
vi.mock('../store', () => ({ openProject: (id: string | null) => openProject(id) }))

const { startChatAbout, installChatAbout } = await import('./start')
const { takeContext, contextVersion } = await import('../pendingContext')

// jsdom's Blob has no text().
const readBlob = (b: Blob) => new Promise<string>((resolve) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result))
  r.readAsText(b)
})

afterEach(() => { uploaded.length = 0; openProject.mockClear(); takeContext() })

describe('startChatAbout', () => {
  const ctx = { place: 'goals' as const, title: 'Goal: Run 30 miles', lines: ['- Distance: 12 of 30 mi'] }

  it('uploads the context as text and queues it for a new chat', async () => {
    const nav = vi.fn()
    const uninstall = installChatAbout({ navigate: nav, onAuthError: vi.fn() })
    const before = contextVersion()
    await startChatAbout(ctx)
    uninstall()

    expect(uploaded).toHaveLength(1)
    expect(uploaded[0].name).toBe('goal-run-30-miles.md')
    expect(uploaded[0].opts).toEqual({ kind: 'text' })
    const text = await readBlob(uploaded[0].blob)
    expect(text).toContain('# Goal: Run 30 miles')
    expect(text).toContain('`web/src/goals/GoalCard.tsx`')

    expect(contextVersion()).toBe(before + 1)
    expect(takeContext()).toEqual([{ id: 'u1', name: 'goal-run-30-miles.md', mime: 'text/markdown', size: uploaded[0].blob.size, kind: 'text' }])
    expect(openProject).toHaveBeenCalledWith(null)
    expect(nav).toHaveBeenCalledWith('chat')
  })

  it('queues nothing when the upload fails', async () => {
    const { uploadFile } = await import('../api')
    vi.mocked(uploadFile).mockRejectedValueOnce(new Error('Upload failed'))
    const uninstall = installChatAbout({ navigate: vi.fn(), onAuthError: vi.fn() })
    await expect(startChatAbout(ctx)).rejects.toThrow('Upload failed')
    uninstall()
    expect(takeContext()).toEqual([])
    expect(openProject).not.toHaveBeenCalled()
  })

  it('fails loudly, uploading nothing, when App never installed it', async () => {
    await expect(startChatAbout(ctx)).rejects.toThrow(/not ready/)
    expect(uploaded).toHaveLength(0)
    expect(takeContext()).toEqual([])
  })
})
