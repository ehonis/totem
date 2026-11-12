// Every route whose success means "the owner approved this", and how much proof
// each one needs. bridge.mjs checks the table before dispatching, so a route
// added here is gated; a new approval route added only in bridge.mjs is not —
// add it here first (auth/approval-routes.test.mjs checks both lists agree).
//
// Risk:
//   high      Words or work leave the owner's own data in his name, or code runs:
//             with an approval code set, they need it.
//   low       Changes that stay in the owner's own stores, which an agent could
//             make directly anyway (tasks, goal metrics, a totem's instructions —
//             the bearer can PATCH /api/jobs). A signed-in session alone is
//             enough; the bearer alone is still refused.
//   per-item  Decided from the proposal once it is read (inboxApprovalRisk).
//
// Not here, on purpose: denying or revoking an MCP approval session
// (/api/approvals/deny, /revoke) only takes authority away, and the sign-in and
// approval-code routes in auth/http.mjs check the password themselves.

export const APPROVAL_ROUTES = Object.freeze([
  { method: 'POST', path: '/api/inbox/resolve', risk: 'per-item', what: 'accept, deny or save-as-draft an inbox proposal' },
  { method: 'POST', path: '/api/approvals/approve', risk: 'high', what: 'activate an MCP approval session (it can then accept commands)' },
  { method: 'POST', path: '/api/apple/send', risk: 'high', what: 'send an iMessage from the Messages tab' },
  { method: 'POST', path: '/api/totems/proposal', risk: 'low', what: 'accept or dismiss a totem change proposed in chat' },
  { method: 'POST', path: '/api/inbox/release', risk: 'low', what: 'show a proposal held after a denial, so it asks again' },
  // The run asking is an agent; the bearer alone must not let it answer itself.
  // Low, not high: it is the owner's own chat, answered with the chat open.
  { method: 'POST', path: '/api/chat/approvals', risk: 'low', what: 'approve or decline a tool call a Claude chat run is waiting on' },
  // The owner's own hands on a chat's browser: the run that opened it is an
  // agent, and with the bearer alone it could click through what it handed him
  // (a sign-in, a captcha). The panel's socket (browser/socket.mjs) asks the same.
  { method: 'POST', path: '/api/chat/browser/input', risk: 'low', what: "drive a chat's browser by hand (click, type, scroll)" },
  // recs/http.mjs decides as the owner (`via: 'dashboard'`): an agent must not
  // accept its own recommendations or grade their outcomes with the bearer alone.
  { method: 'POST', path: '/api/recs/:id/decision', pattern: /^\/api\/recs\/[^/]+\/(decision|outcome)$/, example: '/api/recs/no-such-rec/decision', risk: 'low', what: 'decide a recommendation or record its outcome' },
  // away/http.mjs: the owner's own edits to his trips and days off. An away day
  // holds back nudges, and agents only propose spans, so the bearer alone must not
  // write one. Accepting an agent's `away` proposal is /api/inbox/resolve, high risk.
  { method: 'POST', path: '/api/away', risk: 'low', what: 'add an away span' },
  { method: 'PATCH', path: '/api/away/:id', pattern: /^\/api\/away\/[^/]+$/, example: '/api/away/no-such-span', risk: 'low', what: 'change an away span' },
  { method: 'DELETE', path: '/api/away/:id', pattern: /^\/api\/away\/[^/]+$/, example: '/api/away/no-such-span', risk: 'low', what: 'remove an away span' },
  // cliproxy/http.mjs: the CLIProxy tab changes the subscription logins every agent
  // spends: switch one off, delete it, sign one in, reset a cooldown. The bearer
  // alone must not. Spending a vendor's reset grant or credit uses up something
  // scarce in the owner's name, so it is high.
  { method: 'POST', path: '/api/cliproxy/:change', pattern: /^\/api\/cliproxy\/(accounts\/(status|fields|refresh|cooldown|delete)|login|login\/callback|login\/cancel)$/, example: '/api/cliproxy/accounts/status', risk: 'low', what: 'change a CLIProxy login (switch, edit, refresh, cooldown, delete, sign in)' },
  { method: 'POST', path: '/api/cliproxy/:spend', pattern: /^\/api\/cliproxy\/(grants\/claim|credits\/consume)$/, example: '/api/cliproxy/grants/claim', risk: 'high', what: 'spend a Claude reset grant or a Codex reset credit' },
])

/**
 * The one spelling of a request's path that the gate and every handler see:
 * dot segments resolved, repeated slashes collapsed, no trailing slash, no query.
 * `/api/apple/send/` and `/api/apple//send` once reached a handler that trimmed
 * slashes itself while the gate compared the raw path, and sent with the bearer
 * alone.
 */
export function normalizeApiPath(url) {
  const raw = String(url || '/').split('?')[0].split('#')[0].replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  let path
  try { path = new URL(raw, 'http://x').pathname } catch { path = raw }
  path = path.replace(/\/{2,}/g, '/')
  return path.length > 1 ? path.replace(/\/+$/, '') || '/' : path
}

/** The gated route this request reaches, whatever spelling of its path it used. */
export function approvalRouteFor(method, path) {
  const normalized = normalizeApiPath(path)
  return APPROVAL_ROUTES.find((route) => route.method === method && (route.pattern ? route.pattern.test(normalized) : route.path === normalized)) || null
}

// Kinds whose accept stays in the owner's own stores. Everything else, including
// a kind this list has never heard of, is high risk.
// `linkedin`: accepting sends nothing anywhere; it records that the owner did it
// himself on LinkedIn (bridge.mjs still takes it only from the dashboard).
const LOW_RISK_KINDS = new Set(['todo', 'calendar', 'goal', 'linkedin'])

/**
 * How much proof one inbox decision needs. Denying is low: it loses nothing that
 * cannot be staged again. A task that syncs to GitHub or a shared sheet leaves the
 * owner's own data, so it is high like the connector kinds themselves.
 */
export function inboxApprovalRisk(item, action) {
  if (action === 'deny') return 'low'
  if (!item || !LOW_RISK_KINDS.has(item.kind)) return 'high'
  if (item.kind === 'todo' && item.meta?.sync && String(item.meta.sync).toLowerCase() !== 'local') return 'high'
  return 'low'
}
