import { describe, it, expect } from 'vitest'
import { totemNavRows } from './totemNav'
import type { ChatThread } from './types'

const job = (id: string, extra: any = {}) => ({ id, name: id.toUpperCase(), enabled: true, ...extra })
const chat = (totemId: string, extra: Partial<ChatThread> = {}): ChatThread => ({ id: `totem-${totemId}`, totemId, kind: 'regular', messages: [], createdAt: 0, updatedAt: 0, ...extra })

describe('the Totems section of the chats panel', () => {
  it('puts the totem that ran last first, and never-run ones last by name', () => {
    const rows = totemNavRows([
      job('b'), job('old', { lastRun: { startedAt: 100, status: 'ok' } }), job('a'), job('new', { lastRun: { startedAt: 500, status: 'ok' } }),
    ], [])
    expect(rows.map((r) => r.job.id)).toEqual(['new', 'old', 'a', 'b'])
  })

  it('says what each is doing, strongest state first', () => {
    const rows = totemNavRows([
      job('run', { lastRun: { startedAt: 9, status: 'running' } }),
      job('talk', { lastRun: { startedAt: 8, status: 'error' } }),
      job('unread', { lastRun: { startedAt: 7, status: 'ok' } }),
      job('bad', { lastRun: { startedAt: 6, status: 'error' } }),
      job('off', { enabled: false, lastRun: { startedAt: 5, status: 'ok' } }),
      job('idle', { lastRun: { startedAt: 4, status: 'ok' } }),
    ], [chat('talk'), chat('unread', { needsReply: true })], { 'totem-talk': {} })
    expect(rows.map((r) => [r.job.id, r.state])).toEqual([
      ['run', 'running'], ['talk', 'running'], ['unread', 'unread'], ['bad', 'failed'], ['off', 'paused'], ['idle', 'idle'],
    ])
    expect(rows[2].thread?.id).toBe('totem-unread')
  })
})
