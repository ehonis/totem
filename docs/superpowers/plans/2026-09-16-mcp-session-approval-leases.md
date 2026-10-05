# MCP Session Approval Leases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-use MCP proposal approvals with revocable conversation leases that remain active until one hour of inactivity.

**Architecture:** `logs/approvals.mjs` remains the persistence and concurrency boundary but stores versioned reusable leases and exposes request/approve/authorize/revoke operations. `bridge.mjs` carries the explicit random lease identifier through MCP tools, dashboard routes, instructions, metadata, and audit rows; the Logs UI distinguishes pending leases from active leases and can revoke them.

**Tech Stack:** Node.js ESM, `node:test`, JSON persistence, MCP Streamable HTTP tool schemas, React/TypeScript, Node's TypeScript test runner.

**Spec:** `docs/superpowers/specs/2026-09-16-mcp-session-approval-leases-design.md`

## Global Constraints

- An approved lease expires after exactly 60 minutes without an authorized inbox resolution; each authorized resolution resets that deadline.
- Continuous authorized use has no absolute lifetime cap.
- The random `approvalSessionId`, not `Mcp-Session-Id`, is the conversation boundary.
- Requester-facing results never expose the one-time code.
- Existing command refusal rules remain authoritative.
- Legacy single-use rows stay readable as audit history but cannot authorize new actions.
- Ordinary immediate MCP writes remain outside this gate.
- Preserve all pre-existing staged and unstaged worktree changes. Because `bridge.mjs`, `AGENTS.md`, and web files are already dirty, do not create implementation commits that would absorb unrelated work; use focused diffs and tests as checkpoints.

---

### Task 1: Reusable approval lease store

**Files:**
- Modify: `logs/approvals.test.mjs`
- Modify: `logs/approvals.mjs`

**Interfaces:**
- Produces: `request({ explanation, why, requestedBy }) -> PublicLease`
- Produces: `approve({ approvalSessionId, code? }) -> PublicLease`
- Produces: `deny({ approvalSessionId, code?, reason? }) -> PublicLease`
- Produces: `revoke({ approvalSessionId, reason? }) -> PublicLease`
- Produces: `authorize({ approvalSessionId, code?, requestedBy }) -> PublicLease`
- Produces: `status({ approvalSessionId }) -> PublicLease | null`
- Preserves: `list({ status?, limit? }) -> { grants, pending, active }`

- [x] **Step 1: Replace the single-use tests with failing lease lifecycle tests**

```js
test('one approved lease authorizes repeatedly and slides one hour from every use', async () => {
  let clock = 1_000_000
  const { store } = await freshStore({ ttlMs: 60 * 60_000, now: () => clock })
  const lease = await store.request({ explanation: WHAT, why: WHY, requestedBy: 'chatgpt' })
  await store.approve({ approvalSessionId: lease.approvalSessionId })

  clock += 50 * 60_000
  const first = await store.authorize({ approvalSessionId: lease.approvalSessionId, requestedBy: 'chatgpt' })
  assert.equal(first.useCount, 1)
  assert.equal(first.expiresAt, new Date(clock + 60 * 60_000).toISOString())

  clock += 50 * 60_000
  const second = await store.authorize({ approvalSessionId: lease.approvalSessionId, requestedBy: 'chatgpt' })
  assert.equal(second.useCount, 2)
})
```

Add separate tests proving pending requests are inert, codes stay private, code-on-first-use approves, inactivity expires, revocation blocks permanently, denial blocks, requester mismatch blocks, concurrent uses all succeed with an exact use count, legacy rows cannot authorize, and persistence retains timestamps/use count.

- [x] **Step 2: Run the store tests and verify RED**

Run: `node --test logs/approvals.test.mjs`

Expected: failures because `approvalSessionId`, `authorize()`, and `revoke()` do not exist and current grants become `used` after one consume.

- [x] **Step 3: Implement the versioned lease state machine**

Store new rows with this shape:

```js
{
  schemaVersion: 2,
  id,
  kind: 'session',
  code,
  status: 'pending',
  explanation,
  why,
  requestedBy,
  requestedAt,
  expiresAt: requestedAt + ttlMs,
  decidedAt: null,
  lastUsedAt: null,
  useCount: 0,
  denyReason: null,
  revokeReason: null,
}
```

`authorize()` must run under `withLock`, require a schema-version-2 row and matching normalized requester, permit a matching code to change `pending` to `approved`, reject every non-approved terminal status, increment `useCount`, set `lastUsedAt`, and set `expiresAt = now() + ttlMs` before returning.

- [x] **Step 4: Run the store tests and verify GREEN**

Run: `node --test logs/approvals.test.mjs`

Expected: all approval tests pass with no warnings.

- [x] **Step 5: Inspect the focused diff without committing unrelated work**

Run: `git diff --check -- logs/approvals.mjs logs/approvals.test.mjs && git diff -- logs/approvals.mjs logs/approvals.test.mjs`

Expected: only the new lease state machine and its tests.

### Task 2: MCP and authenticated HTTP contract

**Files:**
- Create: `logs/approval-controller.mjs`
- Create: `logs/approval-controller.test.mjs`
- Modify: `bridge.mjs`

**Interfaces:**
- Consumes: the Task 1 store API.
- Produces: `createApprovalController({ approvals, readInboxItems, resolveInboxItem, actionLog, actorForSession })`.
- Produces: `totem_request_approval({ explanation, why }) -> { approvalSessionId, status, expiresAt, ... }`
- Produces: `totem_check_approval({ approvalSessionId }) -> PublicLease | { status: 'none' }`
- Produces: `totem_resolve_inbox({ id, action, approvalSessionId, code? })`
- Produces: `POST /api/approvals/revoke { approvalSessionId, reason? }`

- [x] **Step 1: Write failing controller behavior tests**

Build the controller around a real temporary approval store and specific in-memory inbox/action-log fakes. Prove one approved lease resolves two different proposal IDs, the use count becomes two, a missing/pending/revoked lease never calls `resolveInboxItem`, code-on-first-use resolves successfully, and revoke prevents later resolution.

```js
const first = await controller.resolveInbox(
  { id: 'P1', action: 'accept', approvalSessionId: lease.approvalSessionId },
  { client: 'ChatGPT' },
)
const second = await controller.resolveInbox(
  { id: 'P2', action: 'accept', approvalSessionId: lease.approvalSessionId },
  { client: 'ChatGPT' },
)
assert.equal(first.ok, true)
assert.equal(second.ok, true)
assert.equal((await store.status({ approvalSessionId: lease.approvalSessionId })).useCount, 2)
```

- [x] **Step 2: Run the contract tests and verify RED**

Run: `node --test logs/approval-controller.test.mjs`

Expected: module-not-found failure because the controller does not exist.

- [x] **Step 3: Implement the approval controller and make its tests GREEN**

The controller owns request/check/resolve plus dashboard approve/deny/revoke orchestration and audit logging. It delegates state transitions to the store, reads an inbox item only to enrich the request/result, authorizes before calling `resolveInboxItem`, and returns structured blocked results instead of throwing authorization failures.

Run: `node --test logs/approval-controller.test.mjs`

Expected: all controller tests pass with no warnings.

- [x] **Step 4: Update MCP instructions, tools, metadata, and handlers**

Change the approval flow so request no longer takes an inbox ID, check takes `approvalSessionId`, and resolve requires both the proposal ID and `approvalSessionId`. Authorize before calling `resolveInboxItem`, pass the MCP actor into `authorize`, return the lease ID as `approvalSessionId`, and attach it to the inbox audit detail. Update all single-use/per-item/15-minute copy and metadata enums to the reusable statuses. Bump `MCP_SERVER_INFO.version` to `2.4.0`.

- [x] **Step 5: Add the authenticated revoke route**

The route accepts `{ approvalSessionId, reason }` and calls the controller's revoke method, which records `approval.revoke` with the lease ID as target and correlation ID. Update approve/deny routes to accept `approvalSessionId` and call their controller methods.

- [x] **Step 6: Verify the bridge contract GREEN**

Run: `node --test logs/approvals.test.mjs logs/approval-controller.test.mjs && node --check bridge.mjs`

Expected: approval tests pass and the bridge parses successfully.

- [x] **Step 7: Inspect the focused diff without committing unrelated work**

Run: `git diff --check -- logs/approval-controller.mjs logs/approval-controller.test.mjs bridge.mjs && git diff -- logs/approval-controller.mjs logs/approval-controller.test.mjs bridge.mjs`

Expected: approval-related hunks coexist cleanly with the user's prior bridge changes.

### Task 3: Logs dashboard lease controls

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/components/LogsView.tsx`
- Create: `web/src/components/approvalLeases.ts`
- Create: `web/src/components/approvalLeases.test.ts`
- Modify: `web/src/styles.css`

**Interfaces:**
- Produces: `revokeApprovalSession(approvalSessionId, reason?)` in `api.ts`.
- Produces: `partitionApprovalLeases(grants) -> { pending, active, decided }` in `approvalLeases.ts`.
- Consumes: lease fields `approvalSessionId`, `status`, `useCount`, `lastUsedAt`, `expiresAt`, `revokeReason`.

- [x] **Step 1: Write failing pure UI state tests**

```ts
test('separates active reusable leases from pending and historical rows', () => {
  const rows = [
    { approvalSessionId: 'p', status: 'pending' },
    { approvalSessionId: 'a', status: 'approved', useCount: 3 },
    { approvalSessionId: 'r', status: 'revoked' },
  ]
  const result = partitionApprovalLeases(rows as any)
  assert.deepEqual(result.pending.map((x) => x.approvalSessionId), ['p'])
  assert.deepEqual(result.active.map((x) => x.approvalSessionId), ['a'])
  assert.deepEqual(result.decided.map((x) => x.approvalSessionId), ['r'])
})
```

- [x] **Step 2: Run the UI unit test and verify RED**

Run: `cd web && node --experimental-strip-types --test src/components/approvalLeases.test.ts`

Expected: module-not-found failure because `approvalLeases.ts` does not exist.

- [x] **Step 3: Implement the pure partition helper and API method**

Create the helper with `pending`, `approved`, and terminal status partitions. Add `revokeApprovalSession()` using `POST /api/approvals/revoke` and change approve/deny calls to send `approvalSessionId`.

- [x] **Step 4: Render pending and active lease cards**

Update `Grant` to the lease fields. Pending cards retain Approve/Deny and the out-of-band code. Active cards show `useCount`, `lastUsedAt`, the sliding time left, and a Revoke button; they never show a code. Empty copy must say approval lasts until one hour of inactivity rather than single-use/15 minutes.

- [x] **Step 5: Run UI tests and type/build verification**

Run: `cd web && npm run test:unit && npm run build`

Expected: all component tests pass and Vite completes without TypeScript/build errors.

- [x] **Step 6: Inspect the focused UI diff without committing unrelated work**

Run: `git diff --check -- web/src/api.ts web/src/components/LogsView.tsx web/src/components/approvalLeases.ts web/src/components/approvalLeases.test.ts web/src/styles.css`

Expected: lease controls only, with existing unrelated web work preserved.

### Task 4: Documentation and full verification

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/logs.md`
- Modify: `docs/totem-mcp-server.md`
- Modify: `docs/superpowers/plans/2026-09-16-mcp-session-approval-leases.md`

**Interfaces:**
- Documents the exact Task 1–3 behavior and operational recovery path.

- [x] **Step 1: Update maintained documentation**

Replace every description of single-use, target-pinned, 15-minute approvals with the explicit `approvalSessionId`, one-hour sliding inactivity, manual revocation, legacy-row behavior, and per-action audit logging. Update the AGENTS component table and Status / roadmap entry in the same change.

- [x] **Step 2: Search for stale claims**

Run: `rg -n "single-use|single use|15 minutes|15-minute|pinned to one|exact id|same target|grant used|status.*used" AGENTS.md docs/logs.md docs/totem-mcp-server.md bridge.mjs web/src/components/LogsView.tsx logs/approvals.mjs`

Expected: no stale approval claims; unrelated uses such as single-use approval codes must be contextually correct.

- [x] **Step 3: Run focused and repository verification**

Run: `node --test logs/approvals.test.mjs`

Run: `npm test`

Run: `cd web && npm test && npm run build`

Run: `node --check bridge.mjs && git diff --check`

Expected: all suites pass, the web build succeeds, bridge syntax is valid, and no whitespace errors are introduced.

- [x] **Step 4: Mark this plan complete and report dirty-tree boundaries**

Check every completed step in this file. Report the tests run, files changed, the spec commit, and that implementation remains uncommitted where files overlapped pre-existing user work. Do not stage or commit unrelated changes.
