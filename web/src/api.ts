// Thin client for the bridge API. Same origin as the served app, Bearer-authed
// with the BRIDGE_SECRET the user pastes once (kept in localStorage).

import type {
  ConnectorHealth, Todo, TodoExternalLink, TodoOutcome, TodoPatch, TodoPreferences,
  TodoQuery, TodoStatus,
} from './todos/types'
import type {
  Goal, GoalMetricPatch, GoalOptions, GoalPeriod, GoalPeriodQuery, GoalPeriodShortcut, GoalReview, NewGoalInput, NewMetricInput,
} from './goals/types'
import type { AgentProvider, JournalEntry, JournalPayload, JournalSettings } from './journal/types'
import type { TotemList } from './lists/types'

const KEY = 'bridge_secret'

export const getSecret = () => localStorage.getItem(KEY) || ''
export const setSecret = (s: string) => localStorage.setItem(KEY, s)
export const clearSecret = () => localStorage.removeItem(KEY)

// The signed-in browser carries a session cookie, so there is usually no header.
// The secret only exists for a browser that unlocked with BRIDGE_SECRET instead.
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const secret = getSecret()
  return secret ? { Authorization: `Bearer ${secret}`, ...extra } : { ...extra }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

class AuthError extends ApiError {
  constructor(_message = 'unauthorized') { super('unauthorized', 401, 'UNAUTHORIZED') }
}
export { AuthError }

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const extra = init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {}
  // The server refuses a cookie-authenticated body that is not JSON (CSRF guard).
  if (typeof init.body === 'string' && !Object.keys(extra).some((k) => k.toLowerCase() === 'content-type')) {
    extra['content-type'] = 'application/json'
  }
  const response = await fetch(path, { ...init, headers: authHeaders(extra) })
  const body = await response.json().catch(() => ({}))
  if (response.status === 401) throw new AuthError()
  if (!response.ok) {
    const error = body?.error
    throw new ApiError(
      typeof error === 'object' ? error?.message ?? response.statusText : error || response.statusText || `HTTP ${response.status}`,
      response.status,
      typeof error === 'object' ? error?.code ?? 'HTTP_ERROR' : 'HTTP_ERROR',
      typeof error === 'object' ? error?.details ?? {} : {},
    )
  }
  return body as T
}

async function getJSON<T = any>(url: string): Promise<T> { return api<T>(url) }

export const getTodos = () => getJSON('/api/todos')
// Whether the bridge has the terminal panel switched on (TERMINAL_ENABLED). The
// app asks before showing the toggle, so a bridge without it simply has no button.
export const getTerminalStatus = () => getJSON('/api/terminal/status')
export const getCalendar = (days = 7) => getJSON(`/api/calendar?days=${days}`)
export const getCalendarRange = (start: string, end: string) =>
  getJSON(`/api/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`)
export async function updateCalendarEvent(event: any) {
  const r = await fetch('/api/calendar/event', {
    method: 'PATCH',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(event),
  })
  if (r.status === 401) throw new AuthError('unauthorized')
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
  return r.json()
}
// Google Calendar accounts: the saved Google logins (each tags its own events).
// listed with their resolved email; rename/remove edit the local token store;
// startCalendarAccountAuth returns { authUrl } to open Google's consent screen.
export const getCalendarAccounts = () => getJSON('/api/calendar/accounts') // { accounts: [...] }
export const renameCalendarAccount = (from: string, to: string) => sendJSON('/api/calendar/accounts/rename', 'POST', { from, to })
export const removeCalendarAccount = (label: string) => sendJSON('/api/calendar/accounts/remove', 'POST', { label })
export const startCalendarAccountAuth = (label: string) => sendJSON('/api/calendar/accounts/auth', 'POST', { label })

export const getBrain = () => getJSON('/api/brain')

// Search across notes, journal, chats, tasks, goals, lists and project/totem memory.
export interface SearchHit {
  id: string
  kind: string
  title: string
  titleMarked?: string
  snippet?: string
  date: string | null
  target: Record<string, any> | null
}
export interface SearchResponse { query: string; results: SearchHit[]; counts: Record<string, number>; total: number; loose: boolean; tookMs: number }
export const searchEverything = (q: string, kinds: string[] = [], limit = 40) =>
  getJSON<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}${kinds.length ? `&kinds=${kinds.join(',')}` : ''}`)
export const getSearchDoc = (id: string) => getJSON<SearchHit & { body: string; location: string }>(`/api/search/doc?id=${encodeURIComponent(id)}`)
/** A result saved as a text attachment, ready for the chat composer. */
export const searchResultAsContext = (id: string) => sendJSON('/api/search/context', 'POST', { id })
export const getUsage = () => getJSON('/api/usage')
export const getConnections = () => getJSON('/api/connections')

// Studio state: system-workflow toggles/run-times and built-in data connections
// (weather, news). Backed by the bridge (data/studio-state.json), not localStorage,
// so a toggle here actually changes what the scheduler runs. Each mutation returns
// the refreshed studio payload { workflows, dataConnections }.
export const getStudio = () => getJSON('/api/studio')
export const setStudioWorkflow = (id: string, patch: any) => sendJSON('/api/studio/workflow', 'POST', { id, ...patch })
export const setStudioConnection = (id: string, patch: any) => sendJSON('/api/studio/connection', 'POST', { id, ...patch })
export const getMcpSettings = ({ verify = false } = {}) => getJSON(verify ? '/api/mcp?verify=1' : '/api/mcp')

// ---- skills ----------------------------------------------------------------
// Every prompt Totem runs, as an editable record backed by a Markdown file on
// the bridge (data/skills/<id>/SKILL.md). Skills used to be a hardcoded array in
// studio.ts plus a localStorage bag the server never saw, which meant the ones
// that shipped could not be edited and the ones you wrote could not be run.
//
// Nothing here is read-only: a skill that shipped with Totem is patched, deleted
// and reset through exactly the same calls as one you wrote. `reset` re-copies the
// shipped default and is what makes editing a built-in safe to try.
export const getSkills = () => getJSON('/api/skills')
export const createSkill = (skill: any) => sendJSON('/api/skills', 'POST', skill)
export const updateSkill = (id: string, patch: any) => sendJSON('/api/skills', 'PATCH', { id, ...patch })
export const deleteSkill = (id: string) => sendJSON('/api/skills', 'DELETE', { id })
export const resetSkill = (id: string) => sendJSON('/api/skills/reset', 'POST', { id })
// The prompt a skill produces right now, with {{variables}} filled from live
// state. Pass `body` to preview an unsaved edit before committing it.
// Ask an AI to rewrite a skill's instructions. Returns { before, after, ... } and
// saves nothing — the editor shows a diff and applying it only fills the textarea.
export const reviseSkill = (input: {
  id: string; instruction: string; body?: string
  provider: string; model?: string; reasoning?: string
}) => sendJSON('/api/skills/revise', 'POST', input)
// Which providers/models a revision may run on, with each model's reasoning
// levels and the provider's live login state.
export const getSkillReviseModels = () => getJSON('/api/skills/revise-models')
export const previewSkill = (id: string, body?: string) =>
  sendJSON('/api/skills/preview', 'POST', body === undefined ? { id } : { id, body })

// ---- jobs ------------------------------------------------------------------
// Scheduled work: the defaults Totem ships with plus anything you author. One
// payload carries the jobs, live per-AI health, recent runs, and notifications,
// because the Jobs view and the Overview tile both need all four and polling
// four endpoints would just be four chances to disagree with each other.
//
// Every mutation returns the refreshed payload, so the UI never renders a toggle
// state the scheduler doesn't actually hold — the bug that made a job look
// enabled while it silently never ran.
export const getJobs = ({ recheck = false } = {}) => getJSON(recheck ? '/api/jobs?recheck=1' : '/api/jobs')
export const createJob = (job: any) => sendJSON('/api/jobs', 'POST', job)
export const updateJob = (id: string, patch: any) => sendJSON('/api/jobs', 'PATCH', { id, ...patch })
export const deleteJob = (id: string) => sendJSON('/api/jobs', 'DELETE', { id })
// Put back a default you deleted. Deleting a built-in is allowed and is remembered
// across restarts, so this is the only way one comes back.
export const restoreJob = (id: string) => sendJSON('/api/jobs/restore', 'POST', { id })
// Runs immediately without consuming the next scheduled slot.
export const runJobNow = (id: string) => sendJSON('/api/jobs/run', 'POST', { id })
export const getJobRuns = (id?: string, limit = 50) =>
  getJSON(`/api/jobs/runs?limit=${limit}${id ? `&id=${encodeURIComponent(id)}` : ''}`)

// Is each AI actually logged in right now? `recheck` bypasses the server's cache
// and re-runs each CLI's status command.
export const getProviderHealth = ({ recheck = false } = {}) =>
  getJSON(recheck ? '/api/providers/health?recheck=1' : '/api/providers/health')

export const getNotifications = () => getJSON('/api/notifications')
export const markNotificationsRead = (ids?: string[]) => sendJSON('/api/notifications/read', 'POST', ids ? { ids } : {})
export const getAssistantUsage = () => getJSON('/api/assistant-usage')
// Productivity activity: every todo/habit/calendar object created or completed
// through Totem — the real "how much am I using this" signal, beyond AI requests.
export const getProductivity = () => getJSON('/api/productivity')
export const getChatModels = (provider?: string) =>
  getJSON(provider ? `/api/chat-models?provider=${encodeURIComponent(provider)}` : '/api/chat-models')
export const getNote = (path: string) => getJSON(`/api/brain/note?path=${encodeURIComponent(path)}`)

// Inbox: confirm-able yes/no proposals (today, journal-mined action items).
export const getInbox = () => getJSON('/api/inbox') // { items: [...] }
// Open count only, for the sidebar badge. Separate from getInbox because that one
// builds a preview per item (reads staged files, checks provider health) and this
// runs on a poll. -> { open: number, byKind: Record<string, number> }
export const getInboxCount = () => getJSON('/api/inbox/count')
// action is 'accept' (creates the task/event) or 'deny' (skips it).
export const resolveInboxItem = (id: string, action: string) => sendJSON('/api/inbox/resolve', 'POST', { id, action })

// ---- Audit trail, captured output, pending approvals ------------------------
// The Logs tab is the answer to "did that actually happen, and who asked for it".
// Approvals live here rather than in Inbox because approving is a decision about
// letting an AI act, not about the proposal itself.
export const getActionLogs = (params: Record<string, string | number> = {}) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) q.set(k, String(v))
  return getJSON(`/api/logs${q.toString() ? `?${q}` : ''}`)
}
export const getActionLogSummary = (hours = 24) => getJSON(`/api/logs/summary?hours=${hours}`)

// Live runs. `since` is a chunk cursor: pass back the previous lastSeq and you
// get only new output, so tailing a long process costs one small response per
// poll rather than the whole transcript each time.
export const getRuns = () => getJSON('/api/runs')
export const getRun = (id: string, since = 0) =>
  getJSON(`/api/runs/${encodeURIComponent(id)}?since=${since}`)
export const stopRun = (id: string) => sendJSON(`/api/runs/${encodeURIComponent(id)}/stop`, 'POST', {})
export const getOutputs = (limit = 50) => getJSON(`/api/outputs?limit=${limit}`)
export const getOutput = (id: string) => getJSON(`/api/outputs/${encodeURIComponent(id)}`)
export const getApprovals = (status = '') => getJSON(`/api/approvals${status ? `?status=${status}` : ''}`)
export const approveApprovalSession = (approvalSessionId: string) =>
  sendJSON('/api/approvals/approve', 'POST', { approvalSessionId })
export const denyApprovalSession = (approvalSessionId: string, reason = '') =>
  sendJSON('/api/approvals/deny', 'POST', { approvalSessionId, reason })
export const revokeApprovalSession = (approvalSessionId: string, reason = '') =>
  sendJSON('/api/approvals/revoke', 'POST', { approvalSessionId, reason })

// Update any of { defaultProvider, defaultModel, enabledProviders, models,
// streaming, instances }; returns the refreshed connections payload. `instances`
// patches one account's own settings (display name, accent, paths, environment).
export async function setProviderConfig(patch: any) {
  const r = await fetch('/api/providers/config', {
    method: 'PUT',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(patch),
  })
  if (r.status === 401) throw new AuthError('unauthorized')
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
  return r.json()
}

// Accounts: `claude` and `codex` can hold several logins on one box, each with
// its own config directory. Both return the refreshed connections payload.
export const addProviderInstance = (patch: any) => sendJSON('/api/providers/instances', 'POST', patch)
export const removeProviderInstance = (id: string) => sendJSON('/api/providers/instances/remove', 'POST', { id })

export const syncMcpProviders = (providers: any) => sendJSON('/api/mcp/sync', 'POST', { providers })
// Flip between 'gateway' (one aggregator server per provider) and 'direct' (every
// app server synced into every provider). Returns the refreshed MCP settings.
export const setMcpMode = (mode: string) => sendJSON('/api/mcp/mode', 'POST', { mode })
// Live gateway health: which downstream apps connected and how many tools each
// exposes. Spawns the gateway in --status mode, so it's slower than the page load.
export const getGatewayStatus = ({ force = false } = {}) =>
  getJSON(`/api/mcp/gateway/status${force ? '?force=1' : ''}`)
// Begin OAuth for a remote connection at the gateway. Returns { ok, authUrl,
// redirectHost, redirectPort } on success, or { ok:false, code:'needs-client-
// credentials', redirectUri } when the service needs a manually-registered app.
export const startGatewayOAuth = (id: string, creds: any = {}) => sendJSON('/api/mcp/gateway/oauth/start', 'POST', { id, ...creds })
// Forget the gateway's stored tokens for a connection (sign it out).
export const resetGatewayOAuth = (id: string) => sendJSON('/api/mcp/gateway/oauth/reset', 'POST', { id })
export const runMcpAction = ({ provider, id, action }: { provider: string; id: string; action: string }) => sendJSON('/api/mcp/action', 'POST', { provider, id, action })
export const relayMcpCallback = (callbackUrl: string) => sendJSON('/api/mcp/relay-callback', 'POST', { callbackUrl })

// Static catalog of enable-once productivity connections. Cheap (manifest read
// only) so the Connections tab can render the gallery without touching a CLI.
export const getMcpCatalog = () => getJSON('/api/mcp/catalog')
// Per-connection provider status, fetched lazily when a connection row is
// expanded so the page itself loads instantly. verify=1 runs the live CLI probes.
export const getMcpConnectionStatus = (id: string, { verify = true } = {}) =>
  getJSON(`/api/mcp/connection?id=${encodeURIComponent(id)}&verify=${verify ? 1 : 0}`)
// Enable a catalog connection (id + collected secret/field values) or a fully
// custom MCP server ({ custom: { id, name, transport, url|command, args, env, headers } }).
export const addMcpConnection = (body: any) => sendJSON('/api/mcp/add', 'POST', body)
export const toggleMcpConnection = (id: string, enabled: boolean) => sendJSON('/api/mcp/toggle', 'POST', { id, enabled })
export const removeMcpConnection = (id: string) => sendJSON('/api/mcp/remove', 'POST', { id })

// Cross-device chat history, persisted by the bridge.
export const getThreads = () => getJSON('/api/threads') // { threads: [...] }

export async function putThread(thread: any) {
  const r = await fetch(`/api/threads/${encodeURIComponent(thread.id)}`, {
    method: 'PUT',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(thread),
  })
  if (r.status === 401) throw new AuthError('unauthorized')
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
  return r.json()
}

export async function deleteThread(id: string) {
  const r = await fetch(`/api/threads/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (r.status === 401) throw new AuthError('unauthorized')
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
  return r.json()
}

// Shared helper for the JSON-body todo mutations below.
async function sendJSON(url: string, method: string, body: any) {
  return api<any>(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// In-house habit tracker (data/habits.json on the bridge). Every mutation
// returns the same full payload as getHabits — { habits, entries, today,
// palette } — so callers just replace their state with the response.
export const getHabits = (days = 371) => getJSON(`/api/habits?days=${days}`)
export const createHabit = (fields: any) => sendJSON('/api/habits', 'POST', fields)
// Persist the desktop check-in order. ids must contain every active habit once.
export const reorderHabits = (ids: string[]) => sendJSON('/api/habits/reorder', 'POST', { ids })
export const updateHabit = (id: string, fields: any) => sendJSON('/api/habits', 'PATCH', { id, ...fields })
export const deleteHabit = (id: string) => sendJSON('/api/habits', 'DELETE', { id })
// Log one habit-day:
// { id, date?, delta? | count?, note?, value?, parts?, stats?, window?, complete? }.
// delta increments (tap), count sets absolutely (undo / edit), note replaces the
// day's note, value/parts carry the habit's metric, complete ticks the day off.
// stats are standalone readings (merged key by key, like parts); window is a
// { start, end } local "YYYY-MM-DDTHH:MM" span, replaced whole. Passing only
// stats/window leaves value and parts untouched.
export const logHabit = (fields: any) => sendJSON('/api/habits/log', 'POST', fields)
// Run the WHOOP sleep + recovery sync now instead of waiting for its scheduled slot.
// `days` may be 1–90; scheduled runs keep their small default window.
// Resolves to { updated, enriched, skipped, errors, checked, habits } — `enriched`
// being nights whose value was left alone but whose window/readings were filled
// in, and `habits` the same refreshed payload every other habit mutation returns.
export const syncSleep = (opts: { days?: number; force?: boolean } = {}) =>
  sendJSON('/api/habits/sync-sleep', 'POST', opts)
// Is WHOOP configured (client id/secret present) and connected (refresh token)?
export const getWhoopStatus = () => getJSON('/api/habits/whoop/status')
// Start the WHOOP OAuth flow; returns { authUrl } for the app to open.
export const connectWhoop = () => sendJSON('/api/habits/whoop/connect', 'POST', {})

// ---- Strava ------------------------------------------------------------------
// The bridge holds the token; the dashboard only ever sees status and totals.
// Everything else Strava offers is reached by the agents (strava/cli.mjs, the
// gateway's strava__* tools) and by external MCP clients (totem_strava_*).
export const getStravaStatus = () => getJSON('/api/strava/status')
export const connectStrava = () => sendJSON('/api/strava/connect', 'POST', {})
export const disconnectStrava = () => sendJSON('/api/strava/disconnect', 'POST', {})
// Incremental by default; full walks history backwards in bounded pages and is
// resumable — the response's `complete` says whether there is more.
export const syncStrava = (opts: { full?: boolean; pages?: number } = {}) => sendJSON('/api/strava/sync', 'POST', opts)
// Strava's own trailing-4-week / year-to-date / all-time totals per sport.
export const getStravaStats = () => getJSON('/api/strava/stats')
export const getStravaGear = () => getJSON('/api/strava/gear')

// Live rate-limit windows for every Claude/Codex/Cursor profile on the box.
// The poller pushes updates over `/api/ai-usage/stream`; this GET is the
// snapshot the stream starts from, and `refresh=true` forces a credential
// refresh + re-poll (the Re-poll button) rather than waiting for the next cycle.
export const getAiUsage = (refresh = false) => getJSON(`/api/ai-usage${refresh ? '?refresh=1' : ''}`)

// Which AI profiles get polled, what they're called, and the subscription
// overrides (plan / price / renewal) behind the Usage cards. The PUT takes a
// partial patch — { pollIntervalSeconds, autoDiscover, accountNames, hidden,
// providers, addAccount, removeAccount } — and returns the refreshed settings.
export const getAiUsageConfig = () => getJSON('/api/ai-usage/config')
export const setAiUsageConfig = (patch: any) => sendJSON('/api/ai-usage/config', 'PUT', patch)

// Every GitHub repo the user can reach (owned + collaborations + org membership),
// most-recently-pushed first — the affiliation the GitHub "Repositories" page hides.
// Backed by a cached `gh` fetch on the bridge; refresh=true forces a live refetch.
// Returns { generatedAt, viewer, repos, cached, ageMs }.
export const getGithubRepos = (refresh = false) => getJSON(`/api/github/repos${refresh ? '?refresh=1' : ''}`)

export const closeTodo = (id: string) => sendJSON('/api/todos/close', 'POST', { id })

// ---- Local-first todo board -------------------------------------------------
// These canonical routes expose the SQLite model directly. The compatibility
// methods above stay temporarily while Overview migrates during the cutover.
function todoQueryString(query: TodoQuery = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== '' && value !== null && value !== undefined) params.set(key, String(value))
  }
  return params.toString() ? `?${params}` : ''
}

export const getTodoBoard = (query: TodoQuery = {}) =>
  getJSON<{ todos: Todo[] }>(`/api/todos/board${todoQueryString(query)}`)
export const getTodo = (id: string) =>
  getJSON<{ todo: Todo }>(`/api/todos/${encodeURIComponent(id)}`)
export const createBoardTodo = (fields: TodoPatch & { title: string; syncTarget?: 'local' | 'github' | 'sheet'; repo?: string }) =>
  sendJSON('/api/todos', 'POST', fields) as Promise<{ todo: Todo }>
export const updateBoardTodo = (id: string, fields: TodoPatch) =>
  sendJSON(`/api/todos/${encodeURIComponent(id)}`, 'PATCH', fields) as Promise<{ todo: Todo }>
export const moveBoardTodo = (id: string, status: TodoStatus, outcome?: TodoOutcome) =>
  sendJSON(`/api/todos/${encodeURIComponent(id)}/move`, 'POST', { status, outcome }) as Promise<{ todo: Todo }>
export const reorderBoardTodos = (status: TodoStatus, orderedIds: string[]) =>
  sendJSON('/api/todos/reorder', 'POST', { status, orderedIds }) as Promise<{ todos: Todo[] }>
export const bulkBoardTodos = (ids: string[], operation: string, value?: unknown) =>
  sendJSON('/api/todos/bulk', 'POST', { ids, operation, ...(value === undefined ? {} : { value }) }) as Promise<{ todos: Todo[] }>
export const archiveBoardTodo = (id: string) => todoAction(id, 'archive')
export const unarchiveBoardTodo = (id: string) => todoAction(id, 'unarchive')
export const deleteBoardTodo = (id: string) => todoAction(id, 'delete')
export const restoreBoardTodo = (id: string) => todoAction(id, 'restore')
export const refreshBoardTodo = (id: string) => todoAction(id, 'refresh')
export const addTodoNote = (id: string, body: string) =>
  sendJSON(`/api/todos/${encodeURIComponent(id)}/notes`, 'POST', { body }) as Promise<{ note: Todo['notes'][number] }>
export const linkRelatedTodo = (id: string, relatedId: string) =>
  sendJSON(`/api/todos/${encodeURIComponent(id)}/relations`, 'POST', { relatedId }) as Promise<{ todo: Todo }>
export const unlinkRelatedTodo = (id: string, relatedId: string) =>
  sendJSON(`/api/todos/${encodeURIComponent(id)}/unlink-relation`, 'POST', { relatedId }) as Promise<{ todo: Todo }>
export const attachTodoExternalLink = (id: string, link: Partial<TodoExternalLink>) =>
  sendJSON(`/api/todos/${encodeURIComponent(id)}/external-links`, 'POST', link) as Promise<{ todo: Todo }>
export const detachTodoExternalLink = (id: string, connector: 'github' | 'sheet') =>
  api<{ todo: Todo }>(`/api/todos/${encodeURIComponent(id)}/external-links/${encodeURIComponent(connector)}`, { method: 'DELETE' })
export const shareBoardTodo = (id: string, target: 'github' | 'sheet', options: Record<string, unknown> = {}) =>
  sendJSON(`/api/todos/${encodeURIComponent(id)}/share`, 'POST', { target, ...options }) as Promise<{ todo: Todo }>
export const getTodoPreferences = () => getJSON<{ preferences: TodoPreferences }>('/api/todos/preferences')
export const updateTodoPreferences = (patch: Partial<TodoPreferences>) =>
  sendJSON('/api/todos/preferences', 'PATCH', patch) as Promise<{ preferences: TodoPreferences }>
export const purgeDeletedTodos = (olderThan: string) => sendJSON('/api/todos/purge', 'POST', { olderThan }) as Promise<{ purged: number; backup: string }>
export const getSheetTodoConnector = () =>
  getJSON<{ health: ConnectorHealth; settings: Record<string, unknown> }>('/api/todos/connectors/sheet')
export const refreshSheetTodoConnector = () =>
  sendJSON('/api/todos/connectors/sheet/refresh', 'POST', {}) as Promise<{ result: unknown }>
export const bootstrapSheetTodoConnector = (confirmSheetId: string) =>
  sendJSON('/api/todos/connectors/sheet/bootstrap', 'POST', { confirmSheetId }) as Promise<{ result: unknown }>
export interface GithubTodoIssue { id: string; title: string; identifier?: string; repo?: string; number?: number; url?: string; state?: string }
export const getGithubTodoConnector = () =>
  getJSON<{ health: Record<string, unknown>; settings: { trackAssigned: boolean; watchedRepos: string[]; watermark: string | null } }>('/api/todos/connectors/github')
export const searchGithubTodoIssues = (query: string, selectedRepo = '') =>
  getJSON<{ issues: GithubTodoIssue[] }>(`/api/todos/connectors/github/search?q=${encodeURIComponent(query)}${selectedRepo ? `&repo=${encodeURIComponent(selectedRepo)}` : ''}`)
export const linkGithubTodoIssue = (issueId: string) =>
  sendJSON('/api/todos/connectors/github/link', 'POST', { issueId }) as Promise<{ todo: Todo }>
export const refreshGithubTodoConnector = () =>
  sendJSON('/api/todos/connectors/github/refresh', 'POST', {}) as Promise<{ result: unknown }>
export const updateGithubTodoSettings = (patch: { trackAssigned?: boolean; watchedRepos?: string[] }) =>
  sendJSON('/api/todos/connectors/github/settings', 'PATCH', patch) as Promise<{ settings: Record<string, unknown> }>
export const publishTodoFirstNote = (id: string) =>
  sendJSON(`/api/todos/${encodeURIComponent(id)}/publish-description`, 'POST', {}) as Promise<{ todo: Todo }>

function todoAction(id: string, action: string) {
  return sendJSON(`/api/todos/${encodeURIComponent(id)}/${action}`, 'POST', {}) as Promise<{ todo: Todo }>
}

interface ChatStreamArgs {
  text: string
  history?: any[]
  model?: string | null
  provider?: string | null
}

interface ChatStreamHandlers {
  onDelta?: (text: any) => void
  onActivity?: (text: any) => void
  onTool?: (tool: any) => void
  onDone?: (text: any) => void
  onError?: (err: any) => void
}

// Stream a chat turn. Calls handlers as Server-Sent Events arrive.
// `history` is prior [{role, content}] turns so the agent has thread context.
// Returns an AbortController so the caller can cancel.
export function chatStream({ text, history = [], model = null, provider = null }: ChatStreamArgs, { onDelta, onActivity, onTool, onDone, onError }: ChatStreamHandlers = {}) {
  const controller = new AbortController()
  ;(async () => {
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ text, history, model, provider }),
        signal: controller.signal,
      })
      if (r.status === 401) { onError?.(new AuthError('unauthorized')); return }
      if (!r.ok || !r.body) {
        // e.g. 409 AI_NOT_CONFIGURED: the server's message says what to do.
        const body = await r.json().catch(() => null)
        const message = typeof body?.error === 'object' ? body.error.message : body?.error
        onError?.(new Error(message || `HTTP ${r.status}`))
        return
      }
      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const chunks = buf.split('\n\n')
        buf = chunks.pop() // keep trailing partial
        for (const chunk of chunks) {
          const line = chunk.split('\n').find((l) => l.startsWith('data:'))
          if (!line) continue
          let evt
          try { evt = JSON.parse(line.slice(5).trim()) } catch { continue }
          if (evt.type === 'delta') onDelta?.(evt.text)
          else if (evt.type === 'activity') onActivity?.(evt.text)
          else if (evt.type === 'tool') onTool?.(evt.tool)
          else if (evt.type === 'done') onDone?.(evt.text)
          else if (evt.type === 'error') onError?.(new Error(evt.text))
        }
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') onError?.(e)
    }
  })()
  return controller
}

// Goals (goals/http.mjs). Every mutation answers with the whole goal, so the view
// re-renders from the server's shape rather than patching its own copy — the same
// contract the todo routes use, and the reason a rolled-up total can never drift from
// what the metrics underneath it actually say.
// The resolved window comes back beside the goals, so an empty week still has a name
// and a pair of dates to step from.
export const getGoals = (period?: GoalPeriodQuery) =>
  getJSON<{ goals: Goal[]; period: GoalPeriod | null }>(
    !period ? '/api/goals'
      : typeof period === 'string' ? `/api/goals?period=${period}`
        : `/api/goals?type=${period.type}&start=${period.start}`,
  )
export const getGoal = (id: string) => getJSON<{ goal: Goal }>(`/api/goals/${encodeURIComponent(id)}`)
export const getGoalOptions = () => getJSON<GoalOptions>('/api/goals/options')
export const getGoalReview = (period: GoalPeriodShortcut = 'this_week') =>
  getJSON<GoalReview>(`/api/goals/review?period=${period}`)
export const searchGoals = (query: string) =>
  getJSON<{ goals: Goal[] }>(`/api/goals/search?q=${encodeURIComponent(query)}`)

export const createGoal = (goal: NewGoalInput) =>
  sendJSON('/api/goals', 'POST', goal) as Promise<{ goal: Goal; reimported: boolean }>
export const updateGoal = (id: string, patch: { title?: string; notes?: string; position?: number; abandoned?: boolean }) =>
  sendJSON(`/api/goals/${encodeURIComponent(id)}`, 'PATCH', patch) as Promise<{ goal: Goal }>
export const deleteGoal = (id: string) =>
  sendJSON(`/api/goals/${encodeURIComponent(id)}`, 'DELETE', {}) as Promise<{ deleted: boolean }>
/** Explicit, never inferred from a full bar — see goals/progress.mjs. */
export const setGoalComplete = (id: string, complete: boolean) =>
  sendJSON(`/api/goals/${encodeURIComponent(id)}/complete`, 'POST', { complete }) as Promise<{ goal: Goal }>
export const postponeGoal = (id: string) =>
  sendJSON(`/api/goals/${encodeURIComponent(id)}/postpone`, 'POST', {}) as Promise<{ goal: Goal; from: Goal['period']; to: Goal['period'] }>
export const addGoalStep = (id: string, step: { title?: string; notes?: string }) =>
  sendJSON(`/api/goals/${encodeURIComponent(id)}/steps`, 'POST', step) as Promise<{ goal: Goal }>
export const addGoalMetric = (goalId: string, metric: NewMetricInput & { rollsUpToMetricId?: string }) =>
  sendJSON(`/api/goals/${encodeURIComponent(goalId)}/metrics`, 'POST', metric) as Promise<{ goal: Goal }>
export const logGoalMetric = (id: string, patch: { value?: number; delta?: number }) =>
  sendJSON('/api/goals/metrics', 'PATCH', { id, ...patch }) as Promise<{ goal: Goal }>
/**
 * Change what a metric *is* — its name, unit, target, or where its number comes from.
 *
 * Same route as `logGoalMetric`, because to the server both are one patch; kept apart
 * here because logging is a number going up and this is the definition changing, and a
 * caller that meant one and typed the other should not typecheck.
 */
export const updateGoalMetric = (id: string, patch: GoalMetricPatch) =>
  sendJSON('/api/goals/metrics', 'PATCH', { id, ...patch }) as Promise<{ goal: Goal; discardedValue: number }>
export const deleteGoalMetric = (id: string) =>
  sendJSON('/api/goals/metrics', 'DELETE', { id }) as Promise<{ goal: Goal }>
export const linkGoal = (goalId: string, link: { kind: 'todo' | 'url'; todoId?: string; url?: string; label?: string }) =>
  sendJSON(`/api/goals/${encodeURIComponent(goalId)}/links`, 'POST', link) as Promise<{ goal: Goal }>
export const unlinkGoal = (id: string) =>
  sendJSON('/api/goals/links', 'DELETE', { id }) as Promise<{ goal: Goal }>

// ---- Lists (lists/http.mjs) ------------------------------------------------
export const getLists = () => getJSON<{ lists: TotemList[] }>('/api/lists')
export const getList = (id: string) => getJSON<{ list: TotemList }>(`/api/lists/${encodeURIComponent(id)}`)
export const createList = (input: { title: string; items?: Array<string | { text: string; checked?: boolean }>; todoIds?: string[] }) =>
  sendJSON('/api/lists', 'POST', input) as Promise<{ list: TotemList }>
export const updateList = (id: string, patch: { title?: string; position?: number }) =>
  sendJSON(`/api/lists/${encodeURIComponent(id)}`, 'PATCH', patch) as Promise<{ list: TotemList }>
export const deleteList = (id: string) =>
  sendJSON(`/api/lists/${encodeURIComponent(id)}`, 'DELETE', {}) as Promise<{ deleted: boolean }>
export const addListItems = (listId: string, items: Array<{ text: string; checked?: boolean }>) =>
  sendJSON(`/api/lists/${encodeURIComponent(listId)}/items`, 'POST', { items }) as Promise<{ list: TotemList }>
export const updateListItem = (itemId: string, patch: { text?: string; checked?: boolean; position?: number }) =>
  sendJSON(`/api/lists/items/${encodeURIComponent(itemId)}`, 'PATCH', patch) as Promise<{ list: TotemList }>
export const deleteListItem = (itemId: string) =>
  sendJSON(`/api/lists/items/${encodeURIComponent(itemId)}`, 'DELETE', {}) as Promise<{ list: TotemList }>
export const linkListTodo = (listId: string, todoId: string) =>
  sendJSON(`/api/lists/${encodeURIComponent(listId)}/todos/${encodeURIComponent(todoId)}`, 'POST', {}) as Promise<{ list: TotemList }>
export const unlinkListTodo = (listId: string, todoId: string) =>
  api<{ list: TotemList }>(`/api/lists/${encodeURIComponent(listId)}/todos/${encodeURIComponent(todoId)}`, { method: 'DELETE' })

// ---- Voice journal (Productivity → Journal) ---------------------------------
// A recording is posted as its own bytes with the facts in the query string; the
// bridge transcribes it and, after the grace period, digests it into the brain.
export const getJournal = () => getJSON<JournalPayload>('/api/journal')
export const getJournalEntry = (id: string) => getJSON<{ entry: JournalEntry }>(`/api/journal/entries/${encodeURIComponent(id)}`)
export async function uploadJournalAudio(blob: Blob, { recordedAt, durationSec }: { recordedAt: string; durationSec: number }) {
  const q = new URLSearchParams({ recordedAt, duration: String(durationSec), mime: blob.type || 'application/octet-stream' })
  return api<{ ok: true; entry: JournalEntry }>(`/api/journal/entries?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  })
}
export const createJournalText = (text: string, recordedAt?: string) =>
  sendJSON('/api/journal/entries', 'POST', { text, recordedAt }) as Promise<{ ok: true; entry: JournalEntry }>
export const skipJournalIngest = (id: string) => sendJSON(`/api/journal/entries/${encodeURIComponent(id)}/skip`, 'POST', {}) as Promise<{ entry: JournalEntry }>
export const ingestJournalNow = (id: string) => sendJSON(`/api/journal/entries/${encodeURIComponent(id)}/ingest`, 'POST', {}) as Promise<{ entry: JournalEntry }>
export const retryJournalTranscription = (id: string) => sendJSON(`/api/journal/entries/${encodeURIComponent(id)}/retry`, 'POST', {}) as Promise<{ entry: JournalEntry }>
export const updateJournalEntry = (id: string, patch: { title?: string; transcript?: string }) =>
  sendJSON(`/api/journal/entries/${encodeURIComponent(id)}`, 'PATCH', patch) as Promise<{ entry: JournalEntry }>
export const deleteJournalEntry = (id: string) => sendJSON(`/api/journal/entries/${encodeURIComponent(id)}`, 'DELETE', {})
export const updateJournalSettings = (patch: Partial<JournalSettings>) =>
  sendJSON('/api/journal/settings', 'PATCH', patch) as Promise<{ settings: JournalSettings }>
export const keepJournalAudio = (id: string, keep: boolean) =>
  sendJSON(`/api/journal/entries/${encodeURIComponent(id)}/${keep ? 'keep-audio' : 'unkeep-audio'}`, 'POST', {}) as Promise<{ entry: JournalEntry }>
export const deleteJournalAudio = (id: string) =>
  api<{ ok: true; entry: JournalEntry }>(`/api/journal/entries/${encodeURIComponent(id)}/audio`, { method: 'DELETE' })

/**
 * The recording's bytes as an object URL.
 *
 * Fetched rather than pointed at with `<audio src>`: every API route is bearer
 * authed and an audio element cannot send the header. The caller owns the URL and
 * must revoke it.
 */
export async function journalAudioUrl(id: string): Promise<string> {
  const response = await fetch(`/api/journal/entries/${encodeURIComponent(id)}/audio`, { headers: authHeaders() })
  if (response.status === 401) throw new AuthError()
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new ApiError(body?.error?.message || 'That recording could not be loaded.', response.status, body?.error?.code || 'NO_AUDIO')
  }
  return URL.createObjectURL(await response.blob())
}

/** Every agent this box can run, with its live model catalog. */
export const getAgentModels = () => getJSON<{ providers: AgentProvider[]; defaultProvider: string }>('/api/agent-models')

// ---- Sign-in (auth/owner.mjs) ------------------------------------------------
// These work before anyone is signed in. The session lives in an httpOnly cookie
// the browser sends by itself; a saved BRIDGE_SECRET still rides along as a bearer
// header for installs that were set up that way.

export interface AuthStatus {
  mode: 'password' | 'proxy'
  setupRequired: boolean
  authenticated: boolean
  via: 'bearer' | 'session' | 'proxy' | null
}

export const getAuthStatus = () => api<AuthStatus>('/api/auth/status')
export const checkSetupToken = (token: string) =>
  api<{ valid: boolean; setupRequired: boolean }>('/api/auth/setup/check', { method: 'POST', body: JSON.stringify({ token }) })
export const setupOwner = (token: string, password: string) =>
  api<{ ok: true }>('/api/auth/setup', { method: 'POST', body: JSON.stringify({ token, password }) })
export const login = (password: string) =>
  api<{ ok: true }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) })
export const logout = () => api<{ ok: true }>('/api/auth/logout', { method: 'POST' })
export const changePassword = (current: string, next: string) =>
  api<{ ok: true }>('/api/auth/password', { method: 'POST', body: JSON.stringify({ current, next }) })

// ---- Install-level settings --------------------------------------------------

/** Optional links to sibling apps; null means "not configured, hide it". */
export interface AppConfig {
  publicUrl: string | null
  ownerName: string | null
  bushido: { url: string; hosts: string[] } | null
}
let appConfigPromise: Promise<AppConfig> | null = null
export function getAppConfig(): Promise<AppConfig> {
  appConfigPromise ??= api<AppConfig>('/api/app/config').catch((e) => { appConfigPromise = null; throw e })
  return appConfigPromise
}

// ---- Settings -> AI ------------------------------------------------------------

export interface AiKeyState {
  name: string
  label: string
  /** Which providers read it. */
  providers: string[]
  /** Where the active value comes from; the value itself never leaves the server. */
  source: 'env' | 'settings' | null
  masked: string | null
}
export interface AiProviderState {
  id: string
  label: string
  driver: string
  state: string
  fix: string | null
  installed: boolean
  loggedIn: boolean | null
  detail: string
  keyNames: string[]
}
export interface AiSettings {
  configured: boolean
  defaultProvider: string
  defaultModel: string | null
  envBackend: string
  providers: AiProviderState[]
  keys: AiKeyState[]
}
export const getAiSettings = () => api<AiSettings>('/api/ai/settings')
/** `keys`: name → new value, or null to remove the stored one. */
export const saveAiSettings = (patch: { defaultProvider?: string; defaultModel?: string | null; keys?: Record<string, string | null> }) =>
  api<AiSettings>('/api/ai/settings', { method: 'PUT', body: JSON.stringify(patch) })
export const testAi = (provider?: string) =>
  api<{ ok: boolean; provider: string; ms: number; reply?: string; error?: string }>('/api/ai/test', { method: 'POST', body: JSON.stringify({ provider }) })

// ---- Settings -> Integrations -------------------------------------------------

export interface IntegrationField {
  name: string
  label: string
  secret: boolean
  source: 'env' | 'settings' | null
  /** Masked for secrets, the value itself otherwise. */
  masked: string | null
}
export interface IntegrationInfo {
  id: 'whoop' | 'strava' | 'sheet'
  label: string
  configured: boolean
  console: string
  /** null for integrations without an OAuth redirect (the task sheet). */
  redirectUri: string | null
  restartRequired?: boolean
  docs?: string
  credentialsFile?: { name: string; state: 'unset' | 'found' | 'missing' }
  redirectFromEnv: boolean
  callbackDomain?: string
  fields: IntegrationField[]
}
export interface IntegrationsPayload {
  publicUrl: IntegrationField
  integrations: IntegrationInfo[]
}
export const getIntegrations = () => api<IntegrationsPayload>('/api/integrations')
export const saveIntegrations = (values: Record<string, string | null>) =>
  api<IntegrationsPayload>('/api/integrations', { method: 'PUT', body: JSON.stringify({ values }) })

// ---- Venture tags (Settings -> Tasks) -----------------------------------------
export const getVentureTags = () => api<{ ventureTags: { name: string; color: string | null }[] }>('/api/todos/venture-tags')
export const saveVentureTagList = (ventureTags: { name: string; color: string | null; previousName?: string }[]) =>
  api<{ ventureTags: { name: string; color: string | null }[] }>('/api/todos/venture-tags', { method: 'PUT', body: JSON.stringify({ ventureTags }) })
