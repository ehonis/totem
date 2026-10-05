// logs/approvals.mjs — reusable conversation leases an MCP model cannot approve.
//
// The requester receives a random approvalSessionId but never the one-time code.
// The owner activates the lease out of band. Once active, the same conversation may
// authorize multiple inbox actions; every authorized use slides the inactivity
// deadline forward. The lease remains auditable and can be revoked immediately.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID, randomInt, timingSafeEqual } from 'node:crypto'

export const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'expired', 'revoked']

const SCHEMA_VERSION = 2
const DEFAULT_TTL_MS = 60 * 60 * 1000
const MAX_PENDING = 10
const MAX_KEEP = 200

const makeCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0')
const actorKey = (value) => String(value || 'unknown').trim().toLowerCase()

function codeMatches(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8')
  const y = Buffer.from(String(b ?? ''), 'utf8')
  if (x.length !== y.length || x.length === 0) return false
  return timingSafeEqual(x, y)
}

function iso(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null
}

export function createApprovalStore({ file, ttlMs = DEFAULT_TTL_MS, log = () => {}, now = Date.now, onRequest = null } = {}) {
  if (!file) throw new Error('createApprovalStore needs a file')
  let queue = Promise.resolve()

  function withLock(fn) {
    const next = queue.then(fn)
    queue = next.then(() => {}, () => {})
    return next
  }

  async function readAll() {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      return Array.isArray(parsed?.grants) ? parsed.grants : []
    } catch { return [] }
  }

  async function writeAll(grants) {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify({ grants: grants.slice(-MAX_KEEP), updatedAt: new Date(now()).toISOString() }, null, 2))
    await rename(tmp, file)
  }

  const isLease = (row) => row?.schemaVersion === SCHEMA_VERSION && row?.kind === 'session'

  function expire(grants) {
    const at = now()
    let changed = false
    for (const lease of grants) {
      if (isLease(lease) && (lease.status === 'pending' || lease.status === 'approved') && lease.expiresAt <= at) {
        lease.status = 'expired'
        changed = true
      } else if (!isLease(lease) && lease.status === 'pending' && lease.expiresAt <= at) {
        lease.status = 'expired'
        changed = true
      }
    }
    return changed
  }

  const publicView = (lease) => ({
    approvalSessionId: lease.id,
    kind: lease.kind,
    status: lease.status,
    explanation: lease.explanation,
    why: lease.why,
    requestedBy: lease.requestedBy,
    requestedAt: iso(lease.requestedAt),
    expiresAt: iso(lease.expiresAt),
    useCount: Number(lease.useCount || 0),
    ...(lease.target ? { target: lease.target } : {}),
    ...(lease.decidedAt ? { decidedAt: iso(lease.decidedAt) } : {}),
    ...(lease.lastUsedAt ? { lastUsedAt: iso(lease.lastUsedAt) } : {}),
    ...(lease.denyReason ? { denyReason: lease.denyReason } : {}),
    ...(lease.revokeReason ? { revokeReason: lease.revokeReason } : {}),
    ...(!isLease(lease) ? { legacy: true } : {}),
  })

  const ownerView = (lease) => ({
    ...publicView(lease),
    code: isLease(lease) && lease.status === 'pending' ? lease.code : null,
  })

  async function request({ explanation, why, requestedBy = 'unknown' }) {
    const what = String(explanation || '').trim()
    const reason = String(why || '').trim()
    const requester = actorKey(requestedBy)
    if (what.length < 8) throw new Error('explanation is required: say plainly what this session may do')
    if (reason.length < 8) throw new Error('why is required: say why this session needs approval')

    return withLock(async () => {
      const grants = await readAll()
      expire(grants)
      const existing = grants.find((lease) => (
        isLease(lease)
        && lease.status === 'pending'
        && actorKey(lease.requestedBy) === requester
        && lease.explanation === what.slice(0, 2000)
        && lease.why === reason.slice(0, 2000)
      ))
      if (existing) {
        await writeAll(grants)
        return { ...publicView(existing), reused: true }
      }

      const pending = grants.filter((lease) => isLease(lease) && lease.status === 'pending').length
      if (pending >= MAX_PENDING) throw new Error(`too many approvals already waiting (${pending}) — clear them in the dashboard first`)

      const requestedAt = now()
      const lease = {
        schemaVersion: SCHEMA_VERSION,
        id: randomUUID(),
        kind: 'session',
        code: makeCode(),
        status: 'pending',
        explanation: what.slice(0, 2000),
        why: reason.slice(0, 2000),
        requestedBy: requester.slice(0, 64),
        requestedAt,
        expiresAt: requestedAt + ttlMs,
        decidedAt: null,
        lastUsedAt: null,
        useCount: 0,
        denyReason: null,
        revokeReason: null,
      }
      grants.push(lease)
      await writeAll(grants)
      log(`approval session ${lease.id.slice(0, 8)} requested by ${lease.requestedBy}`)
      try { await onRequest?.(ownerView(lease)) } catch (error) { log(`approval notify failed: ${error?.message || error}`) }
      return publicView(lease)
    })
  }

  async function approve({ approvalSessionId = null, grantId = null, code = null } = {}) {
    const id = approvalSessionId || grantId
    return withLock(async () => {
      const grants = await readAll()
      expire(grants)
      const lease = grants.find((row) => (
        isLease(row)
        && row.status === 'pending'
        && ((id && row.id === id) || (code && codeMatches(row.code, code)))
      ))
      if (!lease) { await writeAll(grants); throw new Error('no pending approval matches that session id or code') }
      lease.status = 'approved'
      lease.decidedAt = now()
      lease.expiresAt = now() + ttlMs
      await writeAll(grants)
      log(`approval session ${lease.id.slice(0, 8)} approved`)
      return publicView(lease)
    })
  }

  async function deny({ approvalSessionId = null, grantId = null, code = null, reason = '' } = {}) {
    const id = approvalSessionId || grantId
    return withLock(async () => {
      const grants = await readAll()
      expire(grants)
      const lease = grants.find((row) => (
        isLease(row)
        && row.status === 'pending'
        && ((id && row.id === id) || (code && codeMatches(row.code, code)))
      ))
      if (!lease) { await writeAll(grants); throw new Error('no pending approval matches that session id or code') }
      lease.status = 'denied'
      lease.decidedAt = now()
      lease.denyReason = String(reason || '').slice(0, 500) || null
      await writeAll(grants)
      log(`approval session ${lease.id.slice(0, 8)} denied`)
      return publicView(lease)
    })
  }

  async function revoke({ approvalSessionId, reason = '' } = {}) {
    return withLock(async () => {
      const grants = await readAll()
      expire(grants)
      const lease = grants.find((row) => isLease(row) && row.id === approvalSessionId && row.status === 'approved')
      if (!lease) { await writeAll(grants); throw new Error('no active approval session matches that id') }
      lease.status = 'revoked'
      lease.decidedAt = now()
      lease.revokeReason = String(reason || '').slice(0, 500) || null
      await writeAll(grants)
      log(`approval session ${lease.id.slice(0, 8)} revoked`)
      return publicView(lease)
    })
  }

  async function authorize({ approvalSessionId, code = null, requestedBy = 'unknown' } = {}) {
    const requester = actorKey(requestedBy)
    return withLock(async () => {
      const grants = await readAll()
      expire(grants)
      const lease = grants.find((row) => row.id === approvalSessionId)
      if (!lease) { await writeAll(grants); throw new Error('no approval session exists for that id — call totem_request_approval first') }
      if (!isLease(lease)) { await writeAll(grants); throw new Error('that legacy approval cannot authorize a session — request a new approval session') }
      if (actorKey(lease.requestedBy) !== requester) {
        await writeAll(grants)
        throw new Error(`that approval session belongs to ${lease.requestedBy}, not ${requester}`)
      }

      if (lease.status === 'pending' && code && codeMatches(lease.code, code)) {
        lease.status = 'approved'
        lease.decidedAt = now()
      }
      if (lease.status === 'pending') { await writeAll(grants); throw new Error(`still waiting on the owner's approval for session ${lease.id}`) }
      if (lease.status === 'denied') { await writeAll(grants); throw new Error(`The owner denied this session${lease.denyReason ? `: ${lease.denyReason}` : ''} — do not retry it`) }
      if (lease.status === 'revoked') { await writeAll(grants); throw new Error(`The owner revoked this session${lease.revokeReason ? `: ${lease.revokeReason}` : ''} — request a new one if more work is needed`) }
      if (lease.status === 'expired') { await writeAll(grants); throw new Error('that approval session expired after one hour of inactivity — request a new one') }
      if (lease.status !== 'approved') { await writeAll(grants); throw new Error(`approval session is not active (${lease.status})`) }

      lease.useCount = Number(lease.useCount || 0) + 1
      lease.lastUsedAt = now()
      lease.expiresAt = now() + ttlMs
      await writeAll(grants)
      log(`approval session ${lease.id.slice(0, 8)} authorized use ${lease.useCount}`)
      return publicView(lease)
    })
  }

  async function list({ status = null, limit = 50 } = {}) {
    return withLock(async () => {
      const grants = await readAll()
      if (expire(grants)) await writeAll(grants)
      const rows = grants
        .filter((lease) => !status || lease.status === status)
        .sort((a, b) => b.requestedAt - a.requestedAt)
        .slice(0, limit)
        .map(ownerView)
      return {
        grants: rows,
        pending: grants.filter((lease) => isLease(lease) && lease.status === 'pending').length,
        active: grants.filter((lease) => isLease(lease) && lease.status === 'approved').length,
      }
    })
  }

  async function status({ approvalSessionId = null, grantId = null } = {}) {
    const id = approvalSessionId || grantId
    return withLock(async () => {
      const grants = await readAll()
      if (expire(grants)) await writeAll(grants)
      const lease = grants.find((row) => row.id === id)
      return lease ? publicView(lease) : null
    })
  }

  return { file, request, approve, deny, revoke, authorize, list, status }
}
