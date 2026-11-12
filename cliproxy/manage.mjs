// cliproxy/manage.mjs — what the CLIProxy tab can do to the proxy's logins.
//
// Every action names a login by its credential name, and the login is looked up
// in a fresh list before anything is sent: the auth index, provider, account id
// and organisation all come from the proxy, never from the request. Every upstream
// URL is a constant (cliproxy/grants.mjs, cliproxy/quota.mjs), and the client
// refuses any other. Credential files are never downloaded or uploaded here.
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { CliproxyError } from './client.mjs'
import { normalizeHistory } from './history.mjs'
import { CLAUDE_HEADERS, codexAccountId, codexHeaders as codexHeadersFor } from './quota.mjs'
import { classifyStatus, cooldownsOf, proxyAccountId, PROXY_PROVIDERS } from './source.mjs'
import {
  CLAIM_RESULTS,
  CODEX_CREDITS_CONSUME_URL,
  CODEX_CREDITS_URL,
  ORG_UUID_RE,
  RESET_GRANT_STATUS_URL,
  claimUrl,
  grantBlocker,
  parseCodexCredits,
  parseGrantStatus,
  pickGrant,
} from './grants.mjs'

const LOGIN_TTL_MS = 10 * 60_000
const CLAIM_RETRY_MS = 10 * 60_000
// Where each provider's sign-in lands: the browser's own localhost, which nothing
// answers, so the owner copies that address back.
export const CALLBACKS = Object.freeze({
  claude: { port: '54545', path: '/callback' },
  codex: { port: '1455', path: '/auth/callback' },
})

const fail = (status, message, code) => new CliproxyError(message, { status, code })
const str = (v) => (typeof v === 'string' ? v : '')
const int = (v) => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) ? n : null
}
const nameOf = (c) => str(c.name) || str(c.id)
const loginStamp = (c) => str(c.last_refresh) || str(c.modtime) || ''
const providerOf = (c) => str(c.provider) || str(c.type)
const emailOf = (c) => str(c.email) || str(c.account) || str(c.label) || null

/**
 * The sign-in address the owner pasted, checked against the sign-in Totem started:
 * the provider's own localhost port and path, and the same `state`. A bare
 * `code=…&state=…` is accepted too. Returns the address to hand the proxy.
 */
export function checkCallback(input, { provider, state }) {
  const expected = CALLBACKS[provider]
  if (!expected) throw fail(400, 'unknown provider')
  const raw = String(input || '').trim()
  if (!raw || raw.length > 4096) throw fail(400, 'Paste the address the sign-in ended on.')
  let url
  try {
    url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
      ? new URL(raw)
      : new URL(`http://localhost:${expected.port}${expected.path}?${raw.replace(/^[?#]/, '')}`)
  } catch {
    throw fail(400, 'That is not an address.')
  }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password) {
    throw fail(400, `That is not the sign-in's return address (it starts http://localhost:${expected.port}).`)
  }
  if (url.port !== expected.port || url.pathname !== expected.path) {
    throw fail(400, `That address is for another sign-in. ${provider === 'claude' ? 'Claude' : 'Codex'} returns to localhost:${expected.port}${expected.path}.`)
  }
  if (!url.searchParams.get('code')) throw fail(400, 'That address has no sign-in code in it.')
  if (url.searchParams.get('state') !== state) throw fail(400, 'That address belongs to a different sign-in. Start again.')
  return `http://localhost:${expected.port}${expected.path}${url.search}`
}

function createStateFile(file) {
  async function load() {
    if (!file) return { claims: {} }
    try {
      const data = JSON.parse(await readFile(file, 'utf8'))
      return { claims: data?.claims && typeof data.claims === 'object' ? data.claims : {} }
    } catch {
      return { claims: {} }
    }
  }
  async function save(data) {
    if (!file) return
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    await rename(tmp, file)
  }
  // Every change is load → change → save under one queue, so two logins' spends
  // running at once never save over each other's pending request id.
  let queue = Promise.resolve()
  function update(change) {
    const run = queue.then(async () => {
      const data = await load()
      const out = await change(data)
      await save(data)
      return out
    })
    queue = run.catch(() => {})
    return run
  }
  return { load, update }
}

export function createCliproxyManager({ client, snapshot = () => null, refresh = async () => {}, audit = async () => {}, stateFile = null, now = () => Date.now() }) {
  const logins = new Map() // state -> { provider, url, startedAt, before: Set<email>, submitted }
  const store = createStateFile(stateFile)
  // One spend per login at a time: two clicks must not race to two request ids.
  const spending = new Set()
  async function exclusive(key, fn) {
    if (spending.has(key)) throw fail(409, 'Already working on this login. Wait for it to finish.')
    spending.add(key)
    try { return await fn() } finally { spending.delete(key) }
  }

  async function list() {
    const body = await client.request('GET', '/credentials')
    return { files: Array.isArray(body?.files) ? body.files : [], at: now() }
  }

  async function find(name) {
    const wanted = str(name)
    if (!wanted || wanted.length > 300) throw fail(400, 'name is required')
    const { files, at } = await list()
    const cred = files.find((c) => nameOf(c) === wanted)
    if (!cred) throw fail(404, 'No such login in the proxy.')
    if (!PROXY_PROVIDERS.has(providerOf(cred))) throw fail(400, 'Totem manages Claude and Codex logins only.')
    return { cred, at }
  }

  async function history() {
    const fingerprint = client.fingerprint()
    let body
    try {
      body = await client.request('GET', '/quota/history', { query: { hours: 504 } })
    } catch (err) {
      if (err.status === 404) return { supported: false, samples: [] }
      throw err
    }
    const { files } = await list()
    if (fingerprint !== client.fingerprint()) throw fail(409, 'Proxy settings changed. Reload the graph.')
    return normalizeHistory(body, files, now())
  }

  const accountId = (cred) => proxyAccountId(providerOf(cred), nameOf(cred))
  const poke = (cred) => refresh(cred ? accountId(cred) : null).catch(() => {})

  /** Everything the tab shows. Quota comes from the poller's snapshot, so both agree. */
  async function overview({ retry = false } = {}) {
    if (!client.configured()) return { configured: false, url: null, accounts: [] }
    if (retry) client.forgetRefusal()
    const snap = snapshot() || {}
    const quota = new Map((snap.accounts || []).filter((a) => a.source === 'cliproxy').map((a) => [a.id, a]))
    let files
    let at
    try {
      ({ files, at } = await list())
    } catch (err) {
      // The last readings, in the same shape as a live row, so the tab can show them.
      const accounts = [...quota.values()].map((q) => ({
        ...q, name: q.label, stale: true, cooldowns: [], recent: [], successCount: 0, failedCount: 0,
        note: null, priority: null, weight: null, websockets: null, runtimeOnly: false,
      }))
      return { configured: true, url: client.baseUrl(), reachable: false, error: err.message, code: err.code || null, accounts, pools: snap.pools || [] }
    }
    const accounts = files.filter((c) => PROXY_PROVIDERS.has(providerOf(c)) && nameOf(c)).map((c) => {
      const q = quota.get(accountId(c)) || {}
      const status = classifyStatus(c)
      const recent = Array.isArray(c.recent_requests) ? c.recent_requests.slice(-20).map((b) => ({ success: Number(b?.success) || 0, failed: Number(b?.failed) || 0 })) : []
      return {
        ...q,
        id: accountId(c),
        name: nameOf(c),
        backend: providerOf(c),
        email: emailOf(c),
        displayName: q.displayName || str(c.note).trim() || emailOf(c) || nameOf(c),
        note: str(c.note) || null,
        priority: int(c.priority),
        weight: int(c.weight),
        websockets: providerOf(c) === 'codex' ? c.websockets === true : null,
        disabled: Boolean(c.disabled),
        runtimeOnly: c.runtime_only === true || c.runtime_only === 'true',
        statusReason: q.statusReason ?? status.reason,
        successCount: int(c.success) ?? 0,
        failedCount: int(c.failed) ?? 0,
        recent,
        cooldowns: cooldownsOf(c, at),
      }
    })
    return {
      configured: true,
      url: client.baseUrl(),
      reachable: true,
      accounts,
      pools: snap.pools || [],
      logins: [...logins.entries()].filter(([, l]) => now() - l.startedAt < LOGIN_TTL_MS).map(([state, l]) => ({ state, provider: l.provider, startedAt: l.startedAt, url: l.url, expiresAt: l.startedAt + LOGIN_TTL_MS, submitted: l.submitted })),
    }
  }

  async function setDisabled({ name, disabled }) {
    if (typeof disabled !== 'boolean') throw fail(400, 'disabled must be true or false')
    const { cred } = await find(name)
    await client.request('PATCH', '/credentials/status', { json: { name: nameOf(cred), disabled, auth_index: String(cred.auth_index ?? '') } })
    await audit(disabled ? 'cliproxy.disable' : 'cliproxy.enable', { account: emailOf(cred) })
    await poke(cred)
    return { ok: true }
  }

  /** The fields the list shows, so the editor never writes blind. */
  async function patchFields({ name, note, priority, weight, websockets }) {
    const { cred } = await find(name)
    const patch = {}
    if (note !== undefined) {
      if (typeof note !== 'string' || note.length > 200) throw fail(400, 'note must be text under 200 characters')
      patch.note = note.trim()
    }
    if (priority !== undefined) {
      if (priority !== null && (!Number.isInteger(priority) || Math.abs(priority) > 1000)) throw fail(400, 'priority must be a whole number')
      patch.priority = priority ?? 0
    }
    if (weight !== undefined) {
      if (weight !== null && (!Number.isInteger(weight) || weight < 0 || weight > 1_000_000)) throw fail(400, 'weight must be a whole number from 0 to 1,000,000')
      patch.weight = weight
    }
    if (websockets !== undefined) {
      if (providerOf(cred) !== 'codex') throw fail(400, 'websockets is a Codex setting')
      if (typeof websockets !== 'boolean') throw fail(400, 'websockets must be true or false')
      patch.websockets = websockets
    }
    if (!Object.keys(patch).length) throw fail(400, 'nothing to change')
    await client.request('PATCH', '/credentials/fields', { json: { name: nameOf(cred), ...patch } })
    await audit('cliproxy.fields', { account: emailOf(cred), fields: Object.keys(patch) })
    await poke(cred)
    return { ok: true }
  }

  /** Ask the proxy to refresh a login's token (the proxy owns it). Its reply may hold tokens: dropped. */
  async function refreshLogin({ name, all }) {
    if (all === true) {
      const body = await client.request('POST', '/credentials/refresh', { json: { all: true }, timeoutMs: 300_000 })
      const results = Array.isArray(body?.results) ? body.results : []
      await audit('cliproxy.refresh_all', { count: results.length })
      await poke(null)
      return {
        ok: true,
        results: results.filter((r) => r && typeof r.id === 'string').map((r) => ({
          name: r.id,
          ok: r.success === true,
          ...(r.success === true ? {} : { error: client.scrub(typeof r.error === 'string' ? r.error : 'failed') }),
        })),
      }
    }
    const { cred } = await find(name)
    if (cred.disabled) throw fail(409, 'Turn the login on first.')
    if (cred.runtime_only === true || cred.runtime_only === 'true') throw fail(409, 'This login is not a file the proxy can refresh.')
    await client.request('POST', '/credentials/refresh', { json: { name: nameOf(cred), auth_index: String(cred.auth_index ?? '') }, timeoutMs: 60_000 })
    await audit('cliproxy.refresh', { account: emailOf(cred) })
    await poke(cred)
    return { ok: true }
  }

  async function resetCooldown({ name }) {
    const { cred } = await find(name)
    if (!Array.isArray(cred.cooldowns) || !cred.cooldowns.length) throw fail(409, 'This login is not cooling down.')
    const body = await client.request('POST', '/routing/cooldown/reset', { json: { auth_index: String(cred.auth_index ?? '') } })
    await audit('cliproxy.cooldown_reset', { account: emailOf(cred) })
    await poke(cred)
    return { ok: true, models: Array.isArray(body?.models) ? body.models.filter((m) => typeof m === 'string').slice(0, 50) : [] }
  }

  async function remove({ name }) {
    const { cred } = await find(name)
    if (cred.runtime_only === true || cred.runtime_only === 'true') throw fail(409, 'This login is not a file the proxy can delete.')
    await client.request('DELETE', '/credentials', { json: { names: [nameOf(cred)] } })
    await audit('cliproxy.delete', { account: emailOf(cred) })
    await poke(null)
    return { ok: true }
  }

  async function models({ name }) {
    const { cred } = await find(name)
    const body = await client.request('GET', '/credentials/models', { query: { name: nameOf(cred) } })
    const list = Array.isArray(body?.models) ? body.models : []
    return { models: list.filter((m) => m && typeof m.id === 'string').slice(0, 200).map((m) => ({ id: m.id.slice(0, 120), name: str(m.display_name).slice(0, 120) || null })) }
  }

  // ---- signing in ----------------------------------------------------------

  function sweepLogins() {
    for (const [state, l] of logins) if (now() - l.startedAt >= LOGIN_TTL_MS) logins.delete(state)
  }

  async function startLogin({ provider }) {
    if (!CALLBACKS[provider]) throw fail(400, 'provider must be claude or codex')
    sweepLogins()
    // One sign-in at a time: an abandoned one is cancelled at the proxy.
    for (const [state] of logins) {
      await client.request('DELETE', '/oauth/session', { query: { state } }).catch(() => {})
      logins.delete(state)
    }
    const { files } = await list()
    const mine = files.filter((c) => providerOf(c) === provider)
    const before = new Set(mine.map(emailOf).filter(Boolean))
    // When each login's token was last written, to tell which one a re-sign-in replaced.
    const stamps = new Map(mine.map((c) => [nameOf(c), loginStamp(c)]))
    const body = await client.request('GET', '/oauth/auth-url', { query: { provider, is_webui: true } })
    const url = str(body?.url)
    const state = str(body?.state)
    if (!state || !/^https:\/\//.test(url)) throw fail(502, 'The proxy did not start a sign-in.')
    logins.set(state, { provider, url, startedAt: now(), before, stamps, submitted: false })
    return { state, url, provider, expiresAt: now() + LOGIN_TTL_MS, callback: `http://localhost:${CALLBACKS[provider].port}${CALLBACKS[provider].path}` }
  }

  function pending(state) {
    sweepLogins()
    const login = logins.get(str(state))
    if (!login) throw fail(404, 'That sign-in has ended. Start again.')
    return login
  }

  async function submitCallback({ state, url }) {
    const login = pending(state)
    if (login.submitted) throw fail(409, 'This sign-in already has its address.')
    const redirect = checkCallback(url, { provider: login.provider, state })
    login.submitted = true
    // The proxy finishes on its own from here; give it the full window to.
    login.startedAt = now()
    try {
      await client.request('POST', '/oauth/callback', { json: { provider: login.provider, redirect_url: redirect } })
    } catch (err) {
      login.submitted = false
      // The address holds the sign-in code: never let it into an error.
      throw fail(err.status || 502, 'The proxy did not accept that address.')
    }
    return { ok: true, expiresAt: login.startedAt + LOGIN_TTL_MS }
  }

  async function loginStatus({ state }) {
    const login = pending(state)
    const body = await client.request('GET', '/oauth/status', { query: { state } })
    const status = str(body?.status)
    if (status === 'wait' || !status) return { status: 'wait' }
    logins.delete(str(state))
    if (status === 'error') return { status: 'error', error: client.scrub(str(body?.error) || 'Sign-in failed') }
    const { files } = await list().catch(() => ({ files: [] }))
    const mine = files.filter((c) => providerOf(c) === login.provider)
    const added = mine.map(emailOf).filter((e) => e && !login.before.has(e))
    const emails = mine.map(emailOf).filter(Boolean)
    const dupes = emails.filter((e, i) => emails.indexOf(e) !== i)
    // No new email: the one login whose token was rewritten since the sign-in
    // started. `updated_at` moves on every request, so it cannot tell.
    const changed = mine.filter((c) => login.stamps.has(nameOf(c)) && login.stamps.get(nameOf(c)) !== loginStamp(c))
    const updated = added.length || changed.length !== 1 ? null : emailOf(changed[0])
    await audit('cliproxy.login', { provider: login.provider, account: added[0] || updated || null })
    await poke(null)
    return { status: 'ok', added: added[0] || null, updated: updated || null, duplicate: dupes[0] || null }
  }

  async function cancelLogin({ state }) {
    const key = str(state)
    if (!logins.has(key)) return { ok: true }
    logins.delete(key)
    await client.request('DELETE', '/oauth/session', { query: { state: key } }).catch(() => {})
    return { ok: true }
  }

  // ---- Claude reset grants -------------------------------------------------

  async function readGrants(cred) {
    const { statusCode, body } = await client.upstream(String(cred.auth_index), { url: RESET_GRANT_STATUS_URL, header: { ...CLAUDE_HEADERS }, timeoutMs: 12_000 })
    if (statusCode < 200 || statusCode >= 300) throw fail(502, `Anthropic answered ${statusCode || 'nothing'}`)
    const status = parseGrantStatus(body?.cedar_ember)
    if (!status) throw fail(502, 'Anthropic sent a reset-grant answer Totem does not understand.')
    return status
  }

  async function grants({ name }) {
    const { cred } = await find(name)
    if (providerOf(cred) !== 'claude') throw fail(400, 'Reset grants are a Claude feature.')
    const status = await readGrants(cred)
    const pick = pickGrant(status, now())
    const left = status.grants.reduce((sum, g) => sum + g.resetsLeft, 0)
    const claims = (await store.load()).claims
    const open = claims[nameOf(cred)]
    return {
      eligible: status.eligible,
      ineligibleReason: status.ineligibleReason,
      atLimit: status.atLimit,
      left,
      grantId: pick,
      blocker: pick ? null : status.grants[0] ? grantBlocker(status, status.nextGrantId || status.grants[0].id, now()) : 'no_grant',
      cooldownUntil: status.cooldownUntil,
      grants: status.grants.map((g) => ({ id: g.id, label: g.label, left: g.resetsLeft, total: g.resetsTotal, endsAt: g.endsAt, clears: g.clears })),
      pending: open && now() - open.at < CLAIM_RETRY_MS ? { grantId: open.grantId, at: open.at } : null,
    }
  }

  async function claimGrant({ name, grantId }) {
    return exclusive(`grant:${str(name)}`, () => claimGrantNow({ name, grantId }))
  }

  async function claimGrantNow({ name, grantId }) {
    const { cred } = await find(name)
    if (providerOf(cred) !== 'claude') throw fail(400, 'Reset grants are a Claude feature.')
    if (cred.disabled) throw fail(409, 'Turn the login on first.')
    const data = await store.load()
    const key = nameOf(cred)
    let open = data.claims[key]
    if (open && now() - open.at >= CLAIM_RETRY_MS) open = null
    // An unanswered claim is retried with the same grant and request id, so it
    // cannot be spent twice; a new one needs the grant to be usable right now.
    const authIndex = String(cred.auth_index ?? '')
    let org
    let grant
    let requestId
    if (open && (!grantId || grantId === open.grantId)) {
      ({ org, grantId: grant, requestId } = open)
    } else {
      const status = await readGrants(cred)
      grant = str(grantId) || pickGrant(status, now())
      const blocker = grant ? grantBlocker(status, grant, now()) : 'no_grant'
      if (blocker) throw fail(409, `This grant cannot be used now (${blocker.replace(/_/g, ' ')}).`)
      const profile = await client.upstream(authIndex, { url: 'https://api.anthropic.com/api/oauth/profile', header: { ...CLAUDE_HEADERS }, timeoutMs: 12_000 })
      org = str(profile.body?.organization?.uuid).toLowerCase()
      if (!ORG_UUID_RE.test(org)) throw fail(502, 'Could not read the account’s organisation.')
      requestId = randomUUID()
      const claim = { grantId: grant, requestId, org, at: now() }
      await store.update((d) => { d.claims[key] = claim })
    }
    let result = null
    try {
      const { statusCode, body } = await client.upstream(authIndex, {
        method: 'POST',
        url: claimUrl(org),
        header: { ...CLAUDE_HEADERS },
        data: { program: 'cedar_ember', grant_id: grant, request_id: requestId },
        timeoutMs: 25_000,
      })
      if (statusCode === 429) result = 'rate_limited'
      else if (statusCode === 401 || statusCode === 403) result = 'auth_error'
      else if (statusCode >= 200 && statusCode < 300 && CLAIM_RESULTS.includes(body?.result)) result = body.result
    } catch { /* may have been sent */ }
    if (!result) {
      await audit('cliproxy.grant_claim', { account: emailOf(cred), grant, result: 'unknown' })
      return { result: 'unknown', retryable: true }
    }
    // Only a reset or "already used" settles it. A refusal proves nothing was spent,
    // and the same request id is kept for ten minutes in case an earlier try landed.
    if (result === 'reset' || result === 'already_used') await store.update((d) => { delete d.claims[key] })
    await audit('cliproxy.grant_claim', { account: emailOf(cred), grant, result })
    if (result === 'reset') await poke(cred)
    return { result }
  }

  // ---- Codex reset credits -------------------------------------------------

  const codexHeaders = (cred) => codexHeadersFor(codexAccountId(cred), { Accept: 'application/json', 'OpenAI-Beta': 'codex-1', Originator: 'Codex Desktop' })

  async function credits({ name }) {
    const { cred } = await find(name)
    if (providerOf(cred) !== 'codex') throw fail(400, 'Reset credits are a Codex feature.')
    const { statusCode, body } = await client.upstream(String(cred.auth_index), { url: CODEX_CREDITS_URL, header: codexHeaders(cred), timeoutMs: 8000 })
    if (statusCode < 200 || statusCode >= 300) throw fail(502, `ChatGPT answered ${statusCode || 'nothing'}`)
    const parsed = parseCodexCredits(body, now())
    if (!parsed) throw fail(502, 'ChatGPT sent a reset-credit answer Totem does not understand.')
    return parsed
  }

  async function consumeCredit({ name }) {
    return exclusive(`credit:${str(name)}`, () => consumeCreditNow({ name }))
  }

  /**
   * Spend one reset credit. Like a grant claim, an attempt with no answer keeps
   * its redeem id for ten minutes and the next try sends the same one, so a
   * timeout followed by a second click cannot spend two credits.
   */
  async function consumeCreditNow({ name }) {
    const { cred } = await find(name)
    if (providerOf(cred) !== 'codex') throw fail(400, 'Reset credits are a Codex feature.')
    if (cred.disabled) throw fail(409, 'Turn the login on first.')
    const key = `credit:${nameOf(cred)}`
    let open = (await store.load()).claims[key]
    if (open && now() - open.at >= CLAIM_RETRY_MS) open = null
    const retrying = Boolean(open)
    if (!open) {
      const available = await credits({ name })
      if (!available.available) throw fail(409, 'No reset credits left on this login.')
      const fresh = { redeemId: randomUUID(), at: now() }
      await store.update((d) => { d.claims[key] = fresh })
      open = fresh
    }
    let statusCode = 0
    try {
      ({ statusCode } = await client.upstream(String(cred.auth_index), {
        method: 'POST',
        url: CODEX_CREDITS_CONSUME_URL,
        header: codexHeaders(cred),
        data: { redeem_request_id: open.redeemId },
        timeoutMs: 15_000,
      }))
    } catch { /* may have been sent */ }
    if (!statusCode || statusCode >= 500) {
      await audit('cliproxy.credit_consume', { account: emailOf(cred), result: 'unknown' })
      return { result: 'unknown', retryable: true }
    }
    const ok = statusCode >= 200 && statusCode < 300
    await audit('cliproxy.credit_consume', { account: emailOf(cred), result: ok ? 'reset' : `http ${statusCode}` })
    // A refusal of a retried id may mean the first try landed: keep the id, say so.
    if (!ok && retrying) throw fail(502, `ChatGPT refused the retry (${statusCode}). The first try may have gone through: check the usage before trying again.`)
    await store.update((d) => { delete d.claims[key] })
    if (!ok) throw fail(502, `ChatGPT refused it (${statusCode}). No credit was spent.`)
    await poke(cred)
    return { result: 'reset' }
  }

  return {
    overview, history, setDisabled, patchFields, refreshLogin, resetCooldown, remove, models,
    startLogin, submitCallback, loginStatus, cancelLogin,
    grants, claimGrant, credits, consumeCredit,
  }
}
