// Adapter-neutral orchestration for MCP approval leases and dashboard decisions.
// The store owns authority; this layer owns actor binding, inbox resolution, and
// the durable audit entries that explain why a proposed action did or did not run.

/**
 * The sentence an MCP client should relay to the owner. `tellOwner` is the field;
 * `tellEthan` carries the same value as a deprecated alias for clients written
 * against the older name, and will be removed in a future major version.
 */
export function tellOwner(message) {
  return { tellOwner: message, tellEthan: message }
}

export function createApprovalController({
  approvals,
  resolveInboxItem,
  actionLog,
  actorForSession = (session) => session?.client || 'unknown',
} = {}) {
  if (!approvals) throw new Error('createApprovalController needs approvals')
  if (typeof resolveInboxItem !== 'function') throw new Error('createApprovalController needs resolveInboxItem')
  if (!actionLog?.record) throw new Error('createApprovalController needs actionLog')

  async function requestSession(args = {}, session = {}) {
    const lease = await approvals.request({
      explanation: args.explanation,
      why: args.why,
      requestedBy: actorForSession(session),
    })
    return {
      ...lease,
      ...tellOwner('Approve this conversation in Totem → Logs, or read me the 6-digit code from the notification.'),
    }
  }

  async function checkSession({ approvalSessionId } = {}) {
    const lease = await approvals.status({ approvalSessionId: String(approvalSessionId || '') })
    return lease || { status: 'none', hint: 'no approval session exists for that id' }
  }

  async function resolveInbox(args = {}, session = {}) {
    const id = String(args.id || '')
    const action = args.action === 'deny' ? 'deny' : 'accept'
    const approvalSessionId = String(args.approvalSessionId || '')
    const actor = actorForSession(session)
    let lease
    try {
      lease = await approvals.authorize({
        approvalSessionId,
        code: args.code || null,
        requestedBy: actor,
      })
    } catch (error) {
      actionLog.record({
        action: `inbox.${action}`,
        actor,
        channel: 'mcp',
        target: id,
        status: 'denied',
        summary: `blocked: ${actor} tried to ${action} ${id} without an active approval session`,
        error: error?.message || String(error),
        correlationId: id,
        detail: { approvalSessionId: approvalSessionId || null },
      })
      return { ok: false, blocked: true, error: error?.message || String(error) }
    }

    const result = await resolveInboxItem({
      id,
      action,
      actor,
      approvedVia: `session:${lease.approvalSessionId}`,
    })
    return {
      ...result,
      approvedBy: 'ethan',
      approvalSessionId: lease.approvalSessionId,
      approvalUseCount: lease.useCount,
      ...tellOwner(`${action === 'accept' ? 'Accepted' : 'Denied'} ${id}: ${result.note}`),
    }
  }

  async function approveSession({ approvalSessionId, code = null } = {}) {
    const lease = await approvals.approve({ approvalSessionId, code })
    actionLog.record({
      action: 'approval.approve',
      actor: 'ethan',
      target: lease.approvalSessionId,
      status: 'ok',
      summary: `approved session: ${lease.explanation}`,
      why: lease.why,
      correlationId: lease.approvalSessionId,
    })
    return lease
  }

  async function denySession({ approvalSessionId, code = null, reason = '' } = {}) {
    const lease = await approvals.deny({ approvalSessionId, code, reason })
    actionLog.record({
      action: 'approval.deny',
      actor: 'ethan',
      target: lease.approvalSessionId,
      status: 'denied',
      summary: `denied session: ${lease.explanation}`,
      why: lease.denyReason || lease.why,
      correlationId: lease.approvalSessionId,
    })
    return lease
  }

  async function revokeSession({ approvalSessionId, reason = '' } = {}) {
    const lease = await approvals.revoke({ approvalSessionId, reason })
    actionLog.record({
      action: 'approval.revoke',
      actor: 'ethan',
      target: lease.approvalSessionId,
      status: 'denied',
      summary: `revoked session: ${lease.explanation}`,
      why: lease.revokeReason || lease.why,
      correlationId: lease.approvalSessionId,
    })
    return lease
  }

  return {
    requestSession,
    checkSession,
    resolveInbox,
    approveSession,
    denySession,
    revokeSession,
  }
}
