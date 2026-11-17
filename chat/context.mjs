// chat/context.mjs — how full a chat's context window is, and compacting it.
//
// Ported from T3 Code (pingdotgg/t3code, main of 2026-11-16): the same sources,
// thresholds and idle-compaction rules, mapped onto Totem's CLI runs.
//
//   Context fill is the LAST request's prompt plus its output, never a reply's
//   billed total (chat/stats.mjs sums every request of a turn, which says nothing
//   about how full the window is):
//     Claude Code  each top-level `assistant` event's message.usage:
//                  input + cache_creation + cache_read + output
//     Codex        the rollout file's `token_count` events (`codex exec --json`
//                  only reports the turn's total): last_token_usage.total_tokens
//                  over model_context_window
//     OpenCode     the last step_finish: input + cache.read + cache.write + output
//     Cursor       its CLI reports no context fill, so no meter
//
//   Compaction is the CLI's own: Claude Code and Codex compact a session
//   themselves when it fills. Totem shows it (a divider in the reply), drops the
//   meter to what is left, and adds T3's two extras for Claude:
//     - `/compact` sent as a message compacts the chat's session on demand;
//     - idle compaction (Settings → Chat › Compact idle threads): a chat of
//       200k tokens or more whose prompt cache has expired offers "Compact and
//       send" (onReturn, the default), or compacts itself two minutes before the
//       cache expires (beforeCacheExpires), or never (off).

/** A message that is a compaction command: `/compact`, optionally with instructions (T3's COMPACT_COMMAND_PATTERN). */
export const COMPACT_COMMAND = /^\/compact(?:\s|$)/i
export const isCompactCommand = (text) => COMPACT_COMMAND.test(String(text || '').trim())

/** T3's words for a provider that cannot compact on demand. */
export const COMPACT_UNSUPPORTED = 'This provider does not support /compact. Start a new thread to continue with a fresh context.'

/**
 * Context size below which neither the Compact chip nor idle compaction runs:
 * Claude Code's own idleCompaction default (it will not go below 100k). Under it
 * a cold re-read is cheap, so compacting mostly loses context for little saving.
 */
export const COMPACTION_MIN_TOKENS = 200_000
/** Idle compaction starts this long before the prompt cache expires, while it is still warm. */
export const IDLE_COMPACT_LEAD_MS = 2 * 60_000
/** When the cache lifetime is unknown, how long before a chat counts as gone cold (T3). */
export const CACHE_TTL_FALLBACK_MS = 70 * 60_000
/**
 * Claude compacts this many tokens short of its auto-compact window: Claude Code
 * 2.1.305 reports a 150,000 window as a 117,000 threshold, for every model (T3).
 */
export const CLAUDE_AUTO_COMPACT_RESERVE_TOKENS = 33_000

export const IDLE_COMPACTION_MODES = ['onReturn', 'beforeCacheExpires', 'off']
export const DEFAULT_IDLE_COMPACTION = 'onReturn'

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
const has = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * Settings → Chat › Auto-compact after: empty (Claude's default) or a whole
 * number from 100,000 to 1,000,000, the same rule as T3's setting. Returns the
 * stored string, '' for empty, or null when the value is not allowed.
 */
export function normalizeAutoCompactWindow(raw) {
  const s = String(raw ?? '').replace(/[,_\s]/g, '')
  if (!s) return ''
  return /^(?:[1-9]\d{5}|1000000)$/.test(s) ? s : null
}

const truthy = (v) => v !== undefined && ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase())

/**
 * The auto-compact window a Claude run uses, as T3's resolveAutoCompactWindow
 * reads it: none when compaction is off (DISABLE_COMPACT, DISABLE_AUTO_COMPACT,
 * autoCompactEnabled:false), else Totem's setting, else the env's
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW, else the account's settings.json
 * (modelSettings[model].autoCompactWindow, then autoCompactWindow). '' = Claude's
 * own default, which reports no threshold.
 */
export function claudeAutoCompactWindow({ setting = '', env = {}, settings = null, model = '' } = {}) {
  if (truthy(env.DISABLE_COMPACT) || truthy(env.DISABLE_AUTO_COMPACT)) return ''
  if (settings && settings.autoCompactEnabled === false) return ''
  const own = normalizeAutoCompactWindow(setting)
  if (own) return own
  const valid = (v) => (Number.isInteger(Number(v)) && Number(v) >= 100_000 && Number(v) <= 1_000_000 ? String(Number(v)) : '')
  const fromEnv = env.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== undefined ? valid(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) : ''
  if (fromEnv) return fromEnv
  if (settings && typeof settings === 'object') {
    const bare = String(model || '').replace(/\[1m\]$/i, '')
    const per = settings.modelSettings?.[bare]?.autoCompactWindow
    if (per === 'auto') return ''
    return valid(per) || valid(settings.autoCompactWindow)
  }
  return ''
}

/** Where Claude compacts, for the meter's tick: the window less its reserve, only when set below the model's window. */
export function claudeAutoCompactThreshold(window, maxTokens) {
  const w = Number(window)
  return w > 0 && (!maxTokens || w < maxTokens) ? w - CLAUDE_AUTO_COMPACT_RESERVE_TOKENS : null
}

// T3 Code's Claude catalog (apps/server/src/provider/model-manifest.json): the
// window Claude Code compacts against, per model. A [1m] suffix picks the 1M
// window on the two models that offer both.
const CLAUDE_WINDOWS = [
  [/^(?:claude-)?(?:fable|opus|sonnet|haiku)$/i, 1_000_000],
  [/^claude-fable-5(?:-\d+)?$/i, 1_000_000],
  [/^claude-opus-5(?:-\d+)?$/i, 1_000_000],
  [/^claude-opus-4-[78]$/i, 1_000_000],
  [/^claude-sonnet-5(?:-\d+)?$/i, 1_000_000],
  [/^claude-haiku-5-5$/i, 1_000_000],
  [/^claude-(?:opus-4-5|haiku-4-5)(?:-\d{8})?$/i, 200_000],
]

/**
 * A Claude model's context window: the catalog first, then the window Claude
 * Code itself reported for it (`result.modelUsage[model].contextWindow`), else
 * null (tokens shown, no bar).
 */
export function claudeContextWindow(model, reported = null) {
  const id = String(model || '').trim()
  if (/^claude-(?:opus|sonnet)-4-6(?:-\d{8})?(\[1m\])?$/i.test(id)) return /\[1m\]$/i.test(id) ? 1_000_000 : 200_000
  const bare = id.replace(/\[1m\]$/i, '')
  for (const [re, size] of CLAUDE_WINDOWS) if (re.test(bare)) return size
  return has(reported) && reported > 0 ? reported : null
}

/** The window Claude Code reported in a `result` event, by model id. */
export function reportedClaudeWindows(event) {
  const out = {}
  const mu = event?.type === 'result' ? event.modelUsage : null
  if (!mu || typeof mu !== 'object') return out
  for (const [id, u] of Object.entries(mu)) if (has(u?.contextWindow) && u.contextWindow > 0) out[id] = u.contextWindow
  return out
}

/** How long Claude's prompt cache lasts for the request that wrote it, or undefined. */
export function claudeCacheTtlMs(cacheCreation) {
  if (!cacheCreation || typeof cacheCreation !== 'object') return undefined
  if (num(cacheCreation.ephemeral_1h_input_tokens) > 0) return 60 * 60_000
  if (num(cacheCreation.ephemeral_5m_input_tokens) > 0) return 5 * 60_000
  return undefined
}

/**
 * One Claude request's usage as context fill, or null for a placeholder (no
 * input: not a measurement). `requestedAt` is when the request started
 * (`message_start`): the cache lifetime runs from there, not from the reply's end.
 */
export function claudeContextUsage(usage, { maxTokens = null, autoCompactWindow = '', requestedAt = 0, at = Date.now() } = {}) {
  if (!usage || typeof usage !== 'object' || !has(usage.input_tokens)) return null
  const input = num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens)
  if (input <= 0) return null
  const output = num(usage.output_tokens)
  const ttl = claudeCacheTtlMs(usage.cache_creation)
  const threshold = claudeAutoCompactThreshold(autoCompactWindow, maxTokens)
  return {
    used: input + output,
    ...(maxTokens ? { max: maxTokens } : {}),
    input,
    cached: num(usage.cache_read_input_tokens),
    output,
    ...(threshold ? { autoCompactAt: threshold } : {}),
    ...(ttl ? { cacheTtlMs: ttl } : {}),
    ...(ttl && requestedAt ? { cacheExpiresAt: requestedAt + ttl } : {}),
    at,
  }
}

/** Codex's `token_count` rollout record as context fill: the last request, never the session total. */
export function codexContextUsage(record, at = Date.now()) {
  const p = record?.type === 'event_msg' ? record.payload : null
  if (p?.type !== 'token_count' || !p.info) return null
  const last = p.info.last_token_usage
  if (!last || !has(last.total_tokens)) return null
  const max = num(p.info.model_context_window)
  return {
    used: last.total_tokens,
    ...(max ? { max } : {}),
    input: num(last.input_tokens),
    cached: num(last.cached_input_tokens),
    output: num(last.output_tokens),
    at,
  }
}

/**
 * Does this Codex rollout record say the session was compacted? Codex 0.167 and
 * later write a top-level `compacted` record (and a `ContextCompaction` item);
 * 0.142–0.144 wrote an `event_msg` of type `context_compacted` beside it. One
 * compaction can produce several of these, so the caller keeps one per moment.
 */
export function codexCompacted(record) {
  if (record?.type === 'compacted') return true
  const p = record?.type === 'event_msg' ? record.payload : null
  return p?.type === 'context_compacted' || (p?.type === 'item_completed' && p.item?.type === 'ContextCompaction')
}

/** OpenCode's step_finish as context fill: the step's prompt plus output is what the next request starts from. */
export function opencodeContextUsage(event, at = Date.now()) {
  const t = event?.type === 'step_finish' ? event.part?.tokens : null
  if (!t || typeof t !== 'object') return null
  const input = num(t.input) + num(t.cache?.read) + num(t.cache?.write)
  if (input <= 0) return null
  const output = num(t.output)
  return { used: input + output, input, cached: num(t.cache?.read), output, at }
}

const USAGE_KEYS = ['used', 'max', 'input', 'cached', 'output', 'autoCompactAt', 'cacheTtlMs', 'cacheExpiresAt', 'at']

/** A message's saved context reading, cleaned; null when it holds nothing usable. */
export function normalizeContextUsage(raw) {
  if (!raw || typeof raw !== 'object' || !has(raw.used)) return null
  const out = {}
  for (const k of USAGE_KEYS) if (has(raw[k])) out[k] = Math.round(raw[k])
  return out
}

const COMPACTION_STATUSES = new Set(['running', 'done', 'failed', 'stopped'])
const COMPACTION_REASONS = new Set(['manual', 'auto', 'onReturn', 'beforeCacheExpires'])

/** A `compaction` part, cleaned for the thread file. */
export function normalizeCompactionPart(p) {
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id) return null
  const out = {
    type: 'compaction',
    id: p.id.slice(0, 80),
    status: COMPACTION_STATUSES.has(p.status) ? p.status : 'done',
    trigger: COMPACTION_REASONS.has(p.trigger) ? p.trigger : 'auto',
  }
  for (const k of ['before', 'after', 'startedAt', 'endedAt']) if (has(p[k])) out[k] = Math.round(p[k])
  if (typeof p.reason === 'string' && p.reason) out.reason = p.reason.slice(0, 300)
  return out
}

/**
 * What one Claude `system` event says about compaction: `status: compacting`
 * opens it, `compact_boundary` closes it with the tokens before and after, and a
 * status line with `compact_result: 'failed'` ends it as failed. Null otherwise.
 */
export function claudeCompactionEvent(event) {
  if (event?.type !== 'system') return null
  if (event.subtype === 'status' && event.status === 'compacting') return { status: 'running' }
  if (event.subtype === 'compact_boundary') {
    const m = event.compact_metadata || {}
    return {
      status: 'done',
      trigger: m.trigger === 'manual' ? 'manual' : 'auto',
      ...(has(m.pre_tokens) ? { before: m.pre_tokens } : {}),
      ...(has(m.post_tokens) ? { after: m.post_tokens } : {}),
    }
  }
  if (event.subtype === 'status' && event.compact_result && event.compact_result !== 'success') {
    return { status: 'failed', ...(event.compact_error ? { reason: String(event.compact_error) } : {}) }
  }
  return null
}

/** The newest context reading for `provider` among `messages` (newest last), or null. */
export function latestContext(messages, provider) {
  for (let i = (messages?.length || 0) - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'assistant' || (provider && m.provider !== provider)) continue
    if (m.context) return m.context
  }
  return null
}

/** Is the user message at `i` a compaction turn (`/compact`, no attachments), whose reply is only its divider? */
export const isCompactionMessage = (m) => m?.role === 'user' && m.command === 'compact'

/**
 * Should an idle Claude chat compact itself now (Compact idle threads → Before
 * the cache expires)? T3's idleCompactionWindow over Totem's thread: returns
 * { startMs, endMs } for the window ending when the last request's cache
 * expires, or null when it should not.
 */
export function idleCompactionWindow(thread, { driverOf = (p) => p, now = Date.now(), running = false } = {}) {
  if (!thread || running) return null
  if (thread.kind === 'temporary' || thread.totemId) return null
  if (thread.settledOverride === 'settled' || thread.settledAt) return null
  if (Number(thread.snoozedUntil) > now) return null
  if (thread.queue?.length || thread.queueHeld) return null
  const messages = thread.messages || []
  const last = messages[messages.length - 1]
  const user = messages[messages.length - 2]
  if (last?.role !== 'assistant' || last.status !== 'done' || user?.role !== 'user') return null
  // Never compact a compaction, so one idle spell compacts at most once.
  if (isCompactionMessage(user)) return null
  // Something still waits on the owner in that reply: compaction would swallow it.
  if ((last.parts || []).some((p) => (p.type === 'questions' || p.type === 'approval') && p.status === 'pending')) return null
  const provider = thread.provider
  if (!provider || driverOf(provider) !== 'claude' || last.provider !== provider) return null
  const session = thread.sessions?.[provider]
  if (!session?.id || session.through !== messages.length) return null
  const ctx = last.context
  if (!ctx || num(ctx.used) < COMPACTION_MIN_TOKENS) return null
  // A request served fully from cache reports no lifetime: unknown, so skip.
  const endMs = num(ctx.cacheExpiresAt)
  if (!endMs || now >= endMs) return null
  return { startMs: endMs - IDLE_COMPACT_LEAD_MS, endMs }
}
