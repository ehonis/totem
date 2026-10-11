// Token usage for one chat reply, read from the agent CLI's own stream so the
// reply's stats panel shows what the model reported rather than an estimate.
//
// Each CLI reports it differently (captured 2026-10-07):
//   Claude Code  {type:'result', usage:{input_tokens, cache_creation_input_tokens,
//                cache_read_input_tokens, output_tokens, output_tokens_details:{thinking_tokens}},
//                total_cost_usd, duration_api_ms, ttft_ms}         one per turn
//   Cursor       {type:'result', usage:{inputTokens, outputTokens, cacheReadTokens,
//                cacheWriteTokens}, duration_api_ms}                one per run
//   Codex        {type:'turn.completed', usage:{input_tokens, cached_input_tokens,
//                output_tokens, reasoning_output_tokens}}           one per turn
//   OpenCode     {type:'step_finish', part:{tokens:{input, output, reasoning,
//                cache:{read, write}}, cost}}                       one per step
//
// Normalised: `input` is every prompt token (cached or not), `cached` the part
// read from cache, `output` every generated token, `reasoning` the part of it
// spent thinking. A field the CLI did not report stays absent, never zero.

const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/** The usage one stream event carries, or null. */
export function usageFromEvent(event) {
  if (!event || typeof event !== 'object') return null
  const u = event.usage
  if (event.type === 'result' && u && typeof u === 'object') {
    if ('input_tokens' in u || 'output_tokens' in u) {
      return {
        input: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens),
        cached: n(u.cache_read_input_tokens),
        output: n(u.output_tokens),
        ...(u.output_tokens_details?.thinking_tokens != null ? { reasoning: n(u.output_tokens_details.thinking_tokens) } : {}),
        ...(event.total_cost_usd != null ? { costUsd: n(event.total_cost_usd) } : {}),
        ...(event.duration_api_ms != null ? { apiMs: n(event.duration_api_ms) } : {}),
      }
    }
    return {
      input: n(u.inputTokens) + n(u.cacheReadTokens) + n(u.cacheWriteTokens),
      cached: n(u.cacheReadTokens),
      output: n(u.outputTokens),
      ...(event.duration_api_ms != null ? { apiMs: n(event.duration_api_ms) } : {}),
    }
  }
  if (event.type === 'turn.completed' && u && typeof u === 'object') {
    return {
      input: n(u.input_tokens),
      cached: n(u.cached_input_tokens),
      output: n(u.output_tokens),
      ...(u.reasoning_output_tokens != null ? { reasoning: n(u.reasoning_output_tokens) } : {}),
    }
  }
  const t = event.type === 'step_finish' ? event.part?.tokens : null
  if (t && typeof t === 'object') {
    return {
      input: n(t.input) + n(t.cache?.read) + n(t.cache?.write),
      cached: n(t.cache?.read),
      output: n(t.output) + n(t.reasoning),
      ...(t.reasoning != null ? { reasoning: n(t.reasoning) } : {}),
      ...(event.part.cost != null ? { costUsd: n(event.part.cost) } : {}),
    }
  }
  return null
}

/** Sum two usages; either may be null. */
export function addUsage(a, b) {
  if (!b) return a || null
  if (!a) return { ...b }
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] || 0) + v
  return out
}

/** A running total over a stream's events. */
export function usageTally() {
  let total = null
  return {
    add(event) { total = addUsage(total, usageFromEvent(event)) },
    get() { return total },
  }
}

/**
 * What a reply keeps: the totals plus time to first token, and output speed
 * over the time the model was generating (the API time when the CLI reports it,
 * else the whole run after the first token, which includes tool waits).
 */
export function replyStats({ usage, startedAt, firstTokenAt, endedAt, tools = 0 }) {
  const out = {}
  if (firstTokenAt && startedAt && firstTokenAt >= startedAt) out.ttftMs = firstTokenAt - startedAt
  if (usage) {
    for (const k of ['input', 'cached', 'output', 'reasoning', 'apiMs']) if (usage[k] != null) out[k] = Math.round(usage[k])
    if (usage.costUsd != null) out.costUsd = Math.round(usage.costUsd * 1e6) / 1e6
    const genMs = usage.apiMs || (firstTokenAt && endedAt ? endedAt - firstTokenAt : 0)
    if (usage.output && genMs >= 200) out.tps = Math.round((usage.output / (genMs / 1000)) * 10) / 10
  }
  if (tools) out.tools = tools
  return Object.keys(out).length ? out : null
}
