// A set of the owner's Google accounts for one Google service (Gmail, Drive):
// labelled sign-ins ("personal", "side") over the Desktop OAuth client Calendar
// uses, each in its own 0600 token file, with one shared access-token refresh per
// account. The service supplies the scope it needs and how to read an account's
// address; everything about signing in, refreshing, renaming and revoking lives here.

import { readFileSync } from 'node:fs'
import { mkdir, writeFile, rename, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

export const LABEL_RE = /^[a-zA-Z0-9_-]{1,40}$/
const SESSION_TTL = 15 * 60 * 1000

export class GoogleError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

// "personal:18c2f…" → { account, id }. A bare id is fine with one account
// connected, or when `account` is passed alongside it.
export function splitRef(ref, account = null, accounts = []) {
  const s = String(ref ?? '').trim()
  if (!s) throw new GoogleError('missing id')
  const i = s.indexOf(':')
  if (i > 0 && accounts.includes(s.slice(0, i))) return { account: s.slice(0, i), id: s.slice(i + 1) }
  const acct = account || (accounts.length === 1 ? accounts[0] : null)
  if (!acct) throw new GoogleError(`"${s}" does not say which account — pass the id as returned (account:id) or add account`)
  return { account: acct, id: s }
}

// `name` is how errors name the service ("Gmail"). `describe(label)` reads an
// account's address and anything else listAccounts should show, through the
// service's own API. `extraScopes` are asked for in the same sign-in, `onConnected`
// gets that grant to hand on, and `grantInUse` says whether a refresh token still
// serves something else, in which case removing the account must not revoke it.
export function createGoogleAccounts({
  name, scope, tokensFile, loadClient, redirectUri, describe,
  fetchImpl = fetch, now = Date.now, extraScopes = [], onConnected = null, grantInUse = () => false, onForget = () => {},
} = {}) {
  const access = new Map()      // account -> { token, exp }
  const refreshing = new Map()  // account -> Promise<token>, one refresh in flight per account
  const sessions = new Map()    // state -> { label, createdAt }

  function client() {
    const raw = loadClient()
    return raw.installed || raw.web || raw
  }

  function configured() {
    try { return Boolean(client().client_id) } catch { return false }
  }

  function readTokens() {
    try { return JSON.parse(readFileSync(tokensFile, 'utf8')) } catch { return {} }
  }

  async function writeTokens(tokens) {
    await mkdir(dirname(tokensFile), { recursive: true })
    const tmp = `${tokensFile}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, tokensFile)
    await chmod(tokensFile, 0o600).catch(() => {})
  }

  const accountLabels = () => Object.keys(readTokens())

  function forget(account) {
    access.delete(account)
    onForget(account)
  }

  function requireAccount(account) {
    const labels = accountLabels()
    if (!labels.length) throw new GoogleError(`No ${name} account is connected. Add one in Totem: Settings → Connections → ${name}.`, 409)
    const key = account ? String(account).trim() : labels.length === 1 ? labels[0] : ''
    if (!key) throw new GoogleError(`Several ${name} accounts are connected (${labels.join(', ')}); say which with account.`)
    if (!labels.includes(key)) {
      // Accept the address as well as the label: "owner@…" is how people name an account.
      const tokens = readTokens()
      const byEmail = labels.find((l) => tokens[l]?.email && tokens[l].email.toLowerCase() === key.toLowerCase())
      if (byEmail) return byEmail
      throw new GoogleError(`No ${name} account "${key}". Connected: ${labels.join(', ')}.`)
    }
    return key
  }

  async function refresh(account) {
    const acct = readTokens()[account]
    if (!acct?.refresh_token) throw new GoogleError(`${name} account "${account}" has no refresh token; reconnect it.`, 409)
    const creds = client()
    const r = await fetchImpl(creds.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.client_id, client_secret: creds.client_secret,
        refresh_token: acct.refresh_token, grant_type: 'refresh_token',
      }),
    })
    if (!r.ok) {
      let reason = ''
      try { const j = JSON.parse(await r.text()); reason = j.error_description || j.error || '' } catch {}
      // invalid_grant every 7 days means the consent screen is still in Testing.
      throw new GoogleError(`${name} sign-in for "${account}" failed (HTTP ${r.status}${reason ? `: ${reason}` : ''}). Reconnect it in Settings → Connections.`, 409)
    }
    const data = await r.json()
    access.set(account, { token: data.access_token, exp: now() + (Number(data.expires_in) || 3600) * 1000 })
    return data.access_token
  }

  async function accessToken(account) {
    const cached = access.get(account)
    if (cached && cached.exp > now() + 60_000) return cached.token
    if (!refreshing.has(account)) {
      refreshing.set(account, refresh(account).finally(() => refreshing.delete(account)))
    }
    return refreshing.get(account)
  }

  async function listAccounts() {
    const tokens = readTokens()
    const accounts = await Promise.all(Object.keys(tokens).map(async (label) => {
      const out = { label, email: tokens[label]?.email || '', status: 'ok', error: '', connectedAt: tokens[label]?.connectedAt || null }
      try {
        const more = await describe(label)
        Object.assign(out, more, { email: more?.email || out.email })
      } catch (e) { out.status = 'error'; out.error = String(e?.message || e).slice(0, 160) }
      return out
    }))
    return { configured: configured(), accounts }
  }

  function startAuth({ label } = {}) {
    if (!configured()) throw new GoogleError(`Totem has no Google OAuth client yet. Set one up as for Calendar, then connect ${name}.`, 409)
    const key = String(label || '').trim()
    if (!LABEL_RE.test(key)) throw new GoogleError('label: letters, numbers, dash, underscore (max 40), no spaces')
    if (readTokens()[key]) throw new GoogleError(`"${key}" is already connected — pick a different label, or remove it first`)
    const creds = client()
    const state = randomBytes(24).toString('base64url')
    for (const [k, v] of sessions) if (now() - v.createdAt > SESSION_TTL) sessions.delete(k)
    sessions.set(state, { label: key, createdAt: now() })
    const url = new URL(creds.auth_uri || 'https://accounts.google.com/o/oauth2/auth')
    url.searchParams.set('client_id', creds.client_id)
    url.searchParams.set('redirect_uri', redirectUri())
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', [scope, ...extraScopes].join(' '))
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
    url.searchParams.set('state', state)
    return { ok: true, authUrl: url.toString(), label: key }
  }

  // The unauthenticated callback's handler. The unguessable `state` is the guard.
  async function completeAuth(query) {
    const state = query.get('state') || ''
    const code = query.get('code') || ''
    const err = query.get('error') || ''
    const sess = sessions.get(state)
    if (err) return { ok: false, message: `Authorization was denied (${err}).` }
    if (!sess || now() - sess.createdAt > SESSION_TTL) return { ok: false, message: 'This sign-in link expired or was already used. Start again from the dashboard.' }
    if (!code) return { ok: false, message: 'The callback had no authorization code.' }
    const creds = client()
    const r = await fetchImpl(creds.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri(),
        client_id: creds.client_id, client_secret: creds.client_secret,
      }).toString(),
    })
    const txt = await r.text()
    let tok = null
    try { tok = JSON.parse(txt) } catch {}
    if (!r.ok || !tok?.access_token) return { ok: false, message: `Token exchange failed (HTTP ${r.status}). ${txt.slice(0, 200)}` }
    if (!tok.refresh_token) return { ok: false, message: 'Google returned no refresh token. Remove Totem at myaccount.google.com/permissions, then try again.' }
    // Unticking the service's box on Google's consent screen still "succeeds".
    if (tok.scope && !String(tok.scope).split(/\s+/).includes(scope)) {
      return { ok: false, message: `Google did not grant ${name} access (the checkbox on the consent screen was left unticked). Try again and allow it.` }
    }
    sessions.delete(state)
    access.set(sess.label, { token: tok.access_token, exp: now() + (Number(tok.expires_in) || 3600) * 1000 })
    // Runs on the access token just cached, before the account is on disk.
    const email = (await describe(sess.label).catch(() => null))?.email || ''
    const tokens = readTokens()
    tokens[sess.label] = { refresh_token: tok.refresh_token, scope: tok.scope || scope, email, connectedAt: new Date(now()).toISOString() }
    await writeTokens(tokens)
    let also = ''
    if (onConnected) also = (await onConnected({ label: sess.label, email, token: tok })) || ''
    return { ok: true, message: `${name} "${sess.label}"${email ? ` (${email})` : ''} connected.${also} You can close this tab and return to Totem.` }
  }

  async function removeAccount({ label } = {}) {
    const key = String(label || '').trim()
    const tokens = readTokens()
    if (!tokens[key]) throw new GoogleError(`No ${name} account "${key}"`)
    const refreshToken = tokens[key].refresh_token
    delete tokens[key]
    await writeTokens(tokens)
    forget(key)
    // Best effort: also revoke the grant at Google, so removing it here means it is gone,
    // unless the same grant still serves something else.
    if (!grantInUse(refreshToken)) fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, { method: 'POST' }).catch(() => {})
    return listAccounts()
  }

  async function renameAccount({ from, to } = {}) {
    const oldLabel = String(from || '').trim()
    const newLabel = String(to || '').trim()
    if (!LABEL_RE.test(newLabel)) throw new GoogleError('label: letters, numbers, dash, underscore (max 40), no spaces')
    const tokens = readTokens()
    if (!tokens[oldLabel]) throw new GoogleError(`No ${name} account "${oldLabel}"`)
    if (oldLabel === newLabel) return listAccounts()
    if (tokens[newLabel]) throw new GoogleError(`"${newLabel}" already exists`)
    tokens[newLabel] = tokens[oldLabel]
    delete tokens[oldLabel]
    await writeTokens(tokens)
    forget(oldLabel)
    return listAccounts()
  }

  return {
    configured, readTokens, accountLabels, requireAccount, accessToken, forget,
    listAccounts, startAuth, completeAuth, removeAccount, renameAccount,
  }
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
