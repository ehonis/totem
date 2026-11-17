import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { compactBeforeSendTokens, compactionLabel, contextSnapshot, contextTooltip, contextValue, formatContextTokens, latestContext } from './context'
import type { ChatMessage, ChatThread } from './types'

const HOUR = 3_600_000
const reply = (patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: `a${Math.random()}`, role: 'assistant', content: 'ok', createdAt: 0, status: 'done', provider: 'claude', ...patch })
const ask = (content = 'hi', patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: `u${Math.random()}`, role: 'user', content, createdAt: 0, ...patch })
const thread = (messages: ChatMessage[], patch: Partial<ChatThread> = {}): ChatThread => ({ id: 't', kind: 'regular', provider: 'claude', messages, createdAt: 0, updatedAt: 0, ...patch })

describe('formatContextTokens (T3\'s formatContextWindowTokens)', () => {
  it('rounds the way T3 does', () => {
    expect(formatContextTokens(999)).toBe('999')
    expect(formatContextTokens(4_500)).toBe('4.5k')
    expect(formatContextTokens(4_000)).toBe('4k')
    expect(formatContextTokens(45_200)).toBe('45k')
    expect(formatContextTokens(999_499)).toBe('999k')
    expect(formatContextTokens(999_500)).toBe('1m')
    expect(formatContextTokens(1_000_000)).toBe('1m')
    expect(formatContextTokens(null)).toBe('0')
  })
})

describe('contextSnapshot', () => {
  it('is amber from 80% and red from 90%, with the value and tooltip T3 shows', () => {
    const s = contextSnapshot({ used: 45_200, max: 200_000, at: 1 })!
    expect(s.percent).toBe(23)
    expect(s.tone).toBe(null)
    expect(contextValue(s)).toBe('45k / 200k')
    expect(contextTooltip(s)).toEqual(['Context: 23% used', '45,200 of 200,000 tokens', 'Context compacts automatically when needed.'])
    expect(contextSnapshot({ used: 160_000, max: 200_000, at: 1 })!.tone).toBe('warning')
    expect(contextSnapshot({ used: 180_000, max: 200_000, at: 1 })!.tone).toBe('error')
  })
  it('names where Claude compacts, and shows tokens alone when the window is unknown', () => {
    const tick = contextSnapshot({ used: 50_000, max: 1_000_000, autoCompactAt: 117_000, at: 1 })!
    expect(tick.autoCompactAt).toBe(117_000)
    expect(contextTooltip(tick)[2]).toBe('Compacts automatically at about 117,000 tokens.')
    const bare = contextSnapshot({ used: 12_345, at: 1 })!
    expect(bare.percent).toBe(null)
    expect(contextValue(bare)).toBe('12k')
    expect(contextTooltip(bare)).toEqual(['Context: 12k tokens used', 'Context compacts automatically when needed.'])
  })
})

describe('latestContext', () => {
  it('belongs to the account that would answer', () => {
    const ms = [reply({ context: { used: 10, at: 1 } }), reply({ provider: 'codex', context: { used: 20, at: 2 } })]
    expect(latestContext(ms, 'claude')!.used).toBe(10)
    expect(latestContext(ms, 'codex')!.used).toBe(20)
    expect(latestContext(ms, 'cursor')).toBe(null)
  })
})

describe('compactBeforeSendTokens (T3\'s Compact idle threads → When you return)', () => {
  const now = 10 * HOUR
  const cold = () => thread([ask(), reply({ context: { used: 250_000, max: 1_000_000, cacheTtlMs: HOUR, at: now - HOUR } })])
  const base = { provider: 'claude', claude: true, setting: 'onReturn' as const, text: 'next', idle: true, now }
  it('offers to compact an idle Claude chat of 200k tokens whose cache expired', () => {
    expect(compactBeforeSendTokens({ ...base, thread: cold() })).toBe(250_000)
  })
  it('falls back to 70 minutes when the cache lifetime is unknown', () => {
    const t = thread([ask(), reply({ context: { used: 250_000, at: now - 60 * 60_000 } })])
    expect(compactBeforeSendTokens({ ...base, thread: t })).toBe(null)
    expect(compactBeforeSendTokens({ ...base, thread: t, now: now + 10 * 60_000 })).toBe(250_000)
  })
  it('stays out of the way otherwise', () => {
    expect(compactBeforeSendTokens({ ...base, thread: cold(), setting: 'off' })).toBe(null)
    expect(compactBeforeSendTokens({ ...base, thread: cold(), idle: false })).toBe(null)
    expect(compactBeforeSendTokens({ ...base, thread: cold(), claude: false })).toBe(null)
    expect(compactBeforeSendTokens({ ...base, thread: cold(), text: '/compact keep the plan' })).toBe(null)
    // A send that hands the chat to another account starts that one fresh.
    expect(compactBeforeSendTokens({ ...base, thread: cold(), provider: 'claude_work' })).toBe(null)
    expect(compactBeforeSendTokens({ ...base, thread: { ...cold(), queueHeld: true, queue: [{ id: 'q', text: 'x', createdAt: 0 }] } })).toBe(null)
    expect(compactBeforeSendTokens({ ...base, thread: { ...cold(), summary: true } })).toBe(null)
    const small = thread([ask(), reply({ context: { used: 199_999, cacheTtlMs: HOUR, at: 0 } })])
    expect(compactBeforeSendTokens({ ...base, thread: small })).toBe(null)
    const warm = thread([ask(), reply({ context: { used: 250_000, cacheTtlMs: HOUR, at: now - 10 * 60_000 } })])
    expect(compactBeforeSendTokens({ ...base, thread: warm })).toBe(null)
    const onlyCompactions = thread([ask('/compact', { command: 'compact' }), reply({ context: { used: 250_000, cacheTtlMs: HOUR, at: 0 } })])
    expect(compactBeforeSendTokens({ ...base, thread: onlyCompactions })).toBe(null)
    const asking = thread([ask(), reply({ parts: [{ type: 'questions', id: 'q', status: 'pending' } as any], context: { used: 250_000, cacheTtlMs: HOUR, at: 0 } })])
    expect(compactBeforeSendTokens({ ...base, thread: asking })).toBe(null)
  })
})

describe('compactionLabel (T3\'s timeline strings)', () => {
  it('says what happened', () => {
    expect(compactionLabel({ type: 'compaction', id: 'c', status: 'running', trigger: 'manual' }).text).toBe('Compacting context')
    expect(compactionLabel({ type: 'compaction', id: 'c', status: 'running', trigger: 'beforeCacheExpires' }).text).toBe('Compacting before the cache expires…')
    const done = compactionLabel({ type: 'compaction', id: 'c', status: 'done', trigger: 'auto', before: 412_000, after: 38_000 })
    expect(done.text).toBe('Context compacted')
    expect(done.tokens).toEqual({ before: '412k', after: '38k' })
    expect(compactionLabel({ type: 'compaction', id: 'c', status: 'done', trigger: 'onReturn' }).text).toBe('Context compacted before sending')
    expect(compactionLabel({ type: 'compaction', id: 'c', status: 'done', trigger: 'beforeCacheExpires' }).text).toBe('Auto-compacted before cache expiry')
    expect(compactionLabel({ type: 'compaction', id: 'c', status: 'failed', trigger: 'manual' }).failed).toBe(true)
    expect(compactionLabel({ type: 'compaction', id: 'c', status: 'stopped', trigger: 'manual' }).text).toBe('Context compaction stopped')
  })
})

describe('the app\'s copy', () => {
  it('is byte for byte the web\'s', () => {
    const here = resolve(__dirname)
    const web = readFileSync(join(here, 'context.ts'), 'utf8')
    const app = readFileSync(join(here, '../../../mobile/src/lib/chat/context.ts'), 'utf8')
    expect(app).toBe(web)
  })
})
