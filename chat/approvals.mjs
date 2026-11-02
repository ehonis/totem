// chat/approvals.mjs — a tool call waiting on the owner's yes or no.
//
// T3 Code's approvals for Claude Code. A chat run starts `claude -p` with
// `--permission-prompt-tool stdio`, so a tool call Claude's permission mode would
// ask about arrives on stdout as a `can_use_tool` control request instead of being
// refused (a print-mode run cannot ask on its own). The request becomes an
// `approval` part on the reply, the run's clock is held, and the owner's decision
// goes back on stdin as the control response: the call runs, or the agent hears
// why not and carries on. Even Full access (bypassPermissions) forwards the asks
// it will not skip: ask rules, connector tools that require a person, safety checks.
//
// Decisions, as T3 offers them:
//   accept            run this call
//   acceptForSession  run it, and allow calls like it for the rest of this chat
//                     (saved on the thread, passed as --allowedTools on later runs)
//   decline           refuse it; the owner's words, if any, tell the agent why
//   cancel            refuse it and stop the turn
//
// A request lives only as long as the CLI process that asked: once the run ends
// (Stop, a bridge restart), there is nothing left to answer, so a pending part is
// marked expired rather than kept answerable like a question.

export const APPROVAL_DECISIONS = ['accept', 'acceptForSession', 'decline', 'cancel']
export const APPROVAL_STATUSES = ['pending', 'approved', 'declined', 'cancelled', 'expired']

const STATUS_FOR = { accept: 'approved', acceptForSession: 'approved', decline: 'declined', cancel: 'cancelled' }
export const statusForDecision = (decision) => STATUS_FOR[decision] || 'declined'

// The CLI's own prompt renderer can leave terminal escapes in its reason.
// eslint-disable-next-line no-control-regex
const stripVt = (s) => String(s || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').trim()
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')

/**
 * The part shown in the reply for one `can_use_tool` request. `describe` is the
 * chat's tool describer (chat/tools.mjs chatToolFromClaude), so the request reads
 * like the tool card it becomes once it runs.
 */
export function approvalPart(request, { id, describe, now = Date.now() }) {
  const r = request || {}
  const tool = str(r.tool_name, 200) || 'tool'
  const look = describe ? describe({ id: r.tool_use_id, name: tool, input: r.input || {} }) : {}
  const reason = stripVt(r.decision_reason || r.description || '')
  const title = str(look.title || r.title || r.display_name || tool, 200)
  return {
    id,
    tool,
    title,
    detail: str(look.detail || '', 600),
    ...(look.app ? { app: str(look.app, 80) } : {}),
    ...(look.logo ? { logo: look.logo } : {}),
    ...(reason && reason !== title ? { reason: reason.slice(0, 1000) } : {}),
    ...(r.blocked_path ? { path: str(r.blocked_path, 600) } : {}),
    ...(look.input ? { input: str(look.input, 4000) } : r.input ? { input: JSON.stringify(r.input, null, 2).slice(0, 4000) } : {}),
    ...(r.tool_use_id ? { toolUseId: str(r.tool_use_id, 160) } : {}),
    ...(r.agent_id ? { subagent: true } : {}),
    // "Always allow" is not offered when Claude says a standing grant must not be made.
    ...(r.suppress_always_allow_rule ? { once: true } : {}),
    status: 'pending',
    askedAt: now,
  }
}

/** A permission rule as Claude Code writes it: `Tool` or `Tool(content)`. */
export function ruleString(rule) {
  const name = typeof rule?.toolName === 'string' ? rule.toolName.trim() : ''
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(name)) return ''
  const content = typeof rule.ruleContent === 'string' ? rule.ruleContent.trim() : ''
  return content ? `${name}(${content.slice(0, 500)})` : name
}

/**
 * The allow rules "Always allow in this chat" grants: Claude's own suggestions
 * when it made any (`Bash(npm test:*)`), otherwise the tool by name.
 */
export function sessionRules(toolName, suggestions) {
  const rules = (Array.isArray(suggestions) ? suggestions : [])
    .filter((s) => s?.type === 'addRules' && s.behavior === 'allow')
    .flatMap((s) => (Array.isArray(s.rules) ? s.rules : []).map(ruleString))
    .filter(Boolean)
  if (rules.length) return [...new Set(rules)]
  const own = ruleString({ toolName })
  return own ? [own] : []
}

/**
 * Claude's permission updates for "Always allow" in the running process. The
 * mode stays the composer's (no setMode); everything lasts this session only.
 */
export function sessionUpdates(toolName, suggestions) {
  const kept = (Array.isArray(suggestions) ? suggestions : [])
    .filter((s) => s && typeof s === 'object' && s.type !== 'setMode')
    .map((s) => ({ ...s, destination: 'session' }))
  if (kept.some((s) => s.type === 'addRules')) return kept
  return [...kept, { type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }]
}

/** The control response's body for a decision (the SDK's PermissionResult). */
export function permissionResult(request, { decision, feedback = '' }) {
  const r = request || {}
  const toolUse = typeof r.tool_use_id === 'string' && r.tool_use_id ? { toolUseID: r.tool_use_id } : {}
  if (decision === 'accept' || decision === 'acceptForSession') {
    return {
      behavior: 'allow',
      updatedInput: r.input && typeof r.input === 'object' ? r.input : {},
      ...toolUse,
      ...(decision === 'acceptForSession' && !r.suppress_always_allow_rule ? { updatedPermissions: sessionUpdates(r.tool_name, r.permission_suggestions) } : {}),
    }
  }
  const words = String(feedback || '').trim()
  return {
    behavior: 'deny',
    message: words
      ? `The owner declined this tool call and said: ${words}`
      : decision === 'cancel' ? 'The owner cancelled this tool call and stopped the turn.' : 'The owner declined this tool call. Do not retry it; carry on without it, or ask how they want to proceed.',
    ...toolUse,
    ...(decision === 'cancel' ? { interrupt: true } : {}),
  }
}

/** The owner's decision from a request body, checked. Throws a 400-shaped error. */
export function normalizeDecision(body) {
  const decision = body?.decision
  if (!APPROVAL_DECISIONS.includes(decision)) throw Object.assign(new Error('decision must be accept, acceptForSession, decline or cancel'), { status: 400 })
  const feedback = decision === 'decline' && typeof body.feedback === 'string' ? body.feedback.trim().slice(0, 8000) : ''
  return { decision, ...(feedback ? { feedback } : {}) }
}

/** A thread's saved "Always allow" rules, merged with new ones, deduplicated and capped. */
export function mergeAllowedTools(existing, added, max = 200) {
  const list = [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(added) ? added : [])]
    .filter((r) => typeof r === 'string' && r.trim())
    .map((r) => r.trim().slice(0, 720))
  return [...new Set(list)].slice(-max)
}

/** Requests waiting on the owner, by part id. `decide` hands one its decision; false when none waits. */
export function createApprovalWaits() {
  const waits = new Map() // id -> { threadId, settle }
  return {
    /** Resolves { decision, feedback? }, or { gone: true } when `signal` aborts first. */
    wait(id, threadId, signal) {
      return new Promise((resolve) => {
        const settle = (v) => { if (waits.get(id)?.settle === settle) waits.delete(id); signal?.removeEventListener?.('abort', onAbort); resolve(v) }
        const onAbort = () => settle({ gone: true })
        waits.set(id, { threadId, settle })
        if (signal?.aborted) onAbort()
        else signal?.addEventListener?.('abort', onAbort, { once: true })
      })
    },
    decide(id, decision) {
      const w = waits.get(id)
      if (!w) return false
      w.settle(decision)
      return true
    },
    live: (id) => waits.has(id),
    /** Part ids waiting in a chat. */
    pending: (threadId) => [...waits].filter(([, w]) => w.threadId === threadId).map(([id]) => id),
  }
}
