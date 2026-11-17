// How full a chat's context window is, and when a send compacts it first.
// Ported from T3 Code (apps/web/src/lib/contextWindow.ts, packages/client-runtime/
// src/state/contextWindow.ts and the timeline's compaction labels); the bridge's
// half is chat/context.mjs. Copied byte for byte to mobile/src/lib/chat/context.ts.
import type { ChatMessage, ChatThread, CompactionPart, ContextUsage } from './types'

/** T3's COMPACT_COMMAND_PATTERN: `/compact`, optionally with instructions. */
export const COMPACT_COMMAND = /^\/compact(?:\s|$)/i
/** No Compact chip below this: Claude Code's own idle-compaction floor. */
export const COMPACTION_MIN_TOKENS = 200_000
/** A chat counts as gone cold after this when Claude never said how long its cache lasts. */
export const CACHE_TTL_FALLBACK_MS = 70 * 60_000

export type IdleCompaction = 'onReturn' | 'beforeCacheExpires' | 'off'

/** 45,200 → "45k", 4,500 → "4.5k", 1,000,000 → "1m" (T3's formatContextWindowTokens). */
export function formatContextTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '0'
  if (value < 1_000) return `${Math.round(value)}`
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  if (value < 999_500) return `${Math.round(value / 1_000)}k`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
}

export interface ContextSnapshot {
  used: number
  max: number | null
  /** 0–100, rounded; null when the window is unknown. */
  percent: number | null
  /** Where Claude compacts, when set below the window: the bar's tick. */
  autoCompactAt: number | null
  tone: 'error' | 'warning' | null
  at: number
}

/**
 * The newest reading for `provider` among the loaded messages, newest last. A
 * reading from another account belongs to that account's session: after a
 * switch it is not this one's (T3 #28581).
 */
export function latestContext(messages: ChatMessage[], provider: string | undefined): ContextUsage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant' || (provider && m.provider !== provider)) continue
    if (m.context && typeof m.context.used === 'number') return m.context
  }
  return null
}

export function contextSnapshot(usage: ContextUsage | null | undefined): ContextSnapshot | null {
  if (!usage || !Number.isFinite(usage.used)) return null
  const used = Math.max(0, usage.used)
  const max = usage.max && usage.max > 0 ? usage.max : null
  const percent = max ? Math.round(Math.min(100, Math.max(0, (used / max) * 100))) : null
  const autoCompactAt = usage.autoCompactAt && usage.autoCompactAt > 0 && (!max || usage.autoCompactAt < max) ? usage.autoCompactAt : null
  const tone = percent == null ? null : percent >= 90 ? 'error' : percent >= 80 ? 'warning' : null
  return { used, max, percent, autoCompactAt, tone, at: usage.at || 0 }
}

/** The meter's value: "45k / 1m", or the tokens alone when the window is unknown. */
export const contextValue = (s: ContextSnapshot) => (s.max ? `${formatContextTokens(s.used)} / ${formatContextTokens(s.max)}` : formatContextTokens(s.used))

/** The meter's accessible name. */
export const contextLabel = (s: ContextSnapshot) => (s.percent != null ? `${s.percent}% used` : `${formatContextTokens(s.used)} tokens used`)

/** T3's formatContextWindowCompactionMessage. */
export function compactionMessage(autoCompactAt: number | null | undefined): string {
  return autoCompactAt && autoCompactAt > 0
    ? `Compacts automatically at about ${autoCompactAt.toLocaleString('en-US')} tokens.`
    : 'Context compacts automatically when needed.'
}

/** The meter's tooltip, line by line (T3's thread details context row). */
export function contextTooltip(s: ContextSnapshot): string[] {
  const lines = [s.percent != null ? `Context: ${s.percent}% used` : `Context: ${formatContextTokens(s.used)} tokens used`]
  if (s.max) lines.push(`${Math.round(s.used).toLocaleString('en-US')} of ${s.max.toLocaleString('en-US')} tokens`)
  lines.push(compactionMessage(s.autoCompactAt))
  return lines
}

export const isCompactionTurn = (m: ChatMessage | undefined) => m?.role === 'user' && m.command === 'compact'

/**
 * The tokens a plain send into an idle chat compacts first (Compact idle threads
 * → When you return), or null when it sends as it is. T3's compactBeforeSendTokens:
 * a Claude chat of 200k tokens or more, idle past its prompt cache's lifetime,
 * with nothing waiting on the owner, the send not handing off to another
 * account, and the words not a `/compact` of their own.
 */
export function compactBeforeSendTokens(input: {
  thread: ChatThread | null | undefined
  /** The account the composer would send on, and whether it is a Claude one. */
  provider: string
  claude: boolean
  setting: IdleCompaction | undefined
  text: string
  idle: boolean
  now: number
}): number | null {
  const { thread } = input
  if (!thread || thread.summary || !input.claude || !input.idle) return null
  if ((input.setting ?? 'onReturn') === 'off') return null
  if (COMPACT_COMMAND.test(input.text.trim())) return null
  // A send that hands off to another account starts that one fresh.
  if (thread.provider && thread.provider !== input.provider) return null
  if (thread.queueHeld && thread.queue?.length) return null
  const messages = thread.messages || []
  if (!messages.some((m) => m.role === 'user' && !isCompactionTurn(m))) return null
  const last = messages[messages.length - 1]
  if (last?.role === 'assistant' && (last.parts || []).some((p) => (p.type === 'questions' || p.type === 'approval') && p.status === 'pending')) return null
  const ctx = latestContext(messages, input.provider)
  if (!ctx || ctx.used < COMPACTION_MIN_TOKENS || !ctx.at) return null
  return input.now - ctx.at >= (ctx.cacheTtlMs ?? CACHE_TTL_FALLBACK_MS) ? ctx.used : null
}

/** T3's compaction divider text. */
export function compactionLabel(p: CompactionPart): { text: string; tokens: { before: string; after: string } | null; failed: boolean; active: boolean } {
  if (p.status === 'failed') return { text: 'Context compaction failed', tokens: null, failed: true, active: false }
  if (p.status === 'stopped') return { text: 'Context compaction stopped', tokens: null, failed: false, active: false }
  if (p.status === 'running') {
    const text = p.trigger === 'beforeCacheExpires' ? 'Compacting before the cache expires…' : p.trigger === 'onReturn' ? 'Compacting…' : 'Compacting context'
    return { text, tokens: null, failed: false, active: true }
  }
  const text = p.trigger === 'beforeCacheExpires' ? 'Auto-compacted before cache expiry' : p.trigger === 'onReturn' ? 'Context compacted before sending' : 'Context compacted'
  const tokens = p.before != null && p.after != null ? { before: formatContextTokens(p.before), after: formatContextTokens(p.after) } : null
  return { text, tokens, failed: false, active: false }
}
