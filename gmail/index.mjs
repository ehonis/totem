// Gmail for the owner's Google accounts: search, read, labels, archive, trash and
// drafts for agents, plus sending, which only the dashboard's inbox reaches.
//
// Accounts are labelled like Calendar's ("personal", "side") and kept in their
// own 0600 token file, apart from Calendar's, because a Gmail grant is a much
// bigger key: gmail.modify reads every message and could send as the owner.
// Google has no scope that allows drafts but not sending, so the limit lives
// here: `send` and `sendDraft` exist on this object for the inbox's accept path
// and are never exposed as a tool (see docs/gmail.md).
//
// The OAuth client is the same Desktop client Calendar uses (GOOGLE_OAUTH_CREDENTIALS);
// the Gmail API has to be enabled on its Google Cloud project.

import { readFileSync } from 'node:fs'
import { mkdir, writeFile, rename, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  buildMessage, toBase64Url, headerMap, readPayload, parseAddressList, validEmail, replySubject,
} from './mime.mjs'

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
export const LABEL_RE = /^[a-zA-Z0-9_-]{1,40}$/
const SESSION_TTL = 15 * 60 * 1000

export class GmailError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

// "personal:18c2f…" → { account, id }. A bare id is fine with one account
// connected, or when `account` is passed alongside it.
export function splitRef(ref, account = null, accounts = []) {
  const s = String(ref ?? '').trim()
  if (!s) throw new GmailError('missing id')
  const i = s.indexOf(':')
  if (i > 0 && accounts.includes(s.slice(0, i))) return { account: s.slice(0, i), id: s.slice(i + 1) }
  const acct = account || (accounts.length === 1 ? accounts[0] : null)
  if (!acct) throw new GmailError(`"${s}" does not say which account — pass the id as returned (account:id) or add account`)
  return { account: acct, id: s }
}

export function createGmail({ tokensFile, loadClient, redirectUri, cacheDir = null, fetchImpl = fetch, now = Date.now } = {}) {
  const access = new Map()      // account -> { token, exp }
  const refreshing = new Map()  // account -> Promise<token>, one refresh in flight per account
  const sessions = new Map()    // state -> { label, createdAt }
  const labelCache = new Map()  // account -> { at, labels }

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

  function requireAccount(account) {
    const labels = accountLabels()
    if (!labels.length) throw new GmailError('No Gmail account is connected. Add one in Totem: Settings → Connections → Gmail.', 409)
    const key = account ? String(account).trim() : labels.length === 1 ? labels[0] : ''
    if (!key) throw new GmailError(`Several Gmail accounts are connected (${labels.join(', ')}); say which with account.`)
    if (!labels.includes(key)) {
      // Accept the address as well as the label: "owner@…" is how people name an inbox.
      const tokens = readTokens()
      const byEmail = labels.find((l) => tokens[l]?.email && tokens[l].email.toLowerCase() === key.toLowerCase())
      if (byEmail) return byEmail
      throw new GmailError(`No Gmail account "${key}". Connected: ${labels.join(', ')}.`)
    }
    return key
  }

  async function refresh(account) {
    const acct = readTokens()[account]
    if (!acct?.refresh_token) throw new GmailError(`Gmail account "${account}" has no refresh token; reconnect it.`, 409)
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
      throw new GmailError(`Gmail sign-in for "${account}" failed (HTTP ${r.status}${reason ? `: ${reason}` : ''}). Reconnect it in Settings → Connections.`, 409)
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

  async function api(account, path, { method = 'GET', query = null, body = undefined } = {}) {
    const token = await accessToken(account)
    const url = new URL(`${API}${path}`)
    for (const [k, v] of Object.entries(query || {})) {
      if (v == null || v === '') continue
      for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(one))
    }
    const r = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (r.status === 204) return {}
    const text = await r.text()
    let json = null
    try { json = text ? JSON.parse(text) : {} } catch {}
    if (!r.ok) {
      const msg = json?.error?.message || text.slice(0, 200)
      if (r.status === 401) access.delete(account)
      if (r.status === 403 && /has not been used|is disabled/i.test(msg)) {
        throw new GmailError('The Gmail API is not enabled on the Google Cloud project behind Totem\'s OAuth client. Enable it in the Cloud console (APIs & Services → Library → Gmail API).', 409)
      }
      throw new GmailError(`Gmail "${account}" ${method} ${path.split('?')[0]} HTTP ${r.status}: ${msg}`, r.status >= 500 ? 502 : r.status)
    }
    return json ?? {}
  }

  // ---- Accounts and sign-in ----------------------------------------------------

  async function listAccounts() {
    const tokens = readTokens()
    const accounts = await Promise.all(Object.keys(tokens).map(async (label) => {
      const out = { label, email: tokens[label]?.email || '', status: 'ok', error: '', connectedAt: tokens[label]?.connectedAt || null }
      try {
        const p = await api(label, '/profile')
        out.email = p.emailAddress || out.email
        out.messagesTotal = p.messagesTotal ?? null
      } catch (e) { out.status = 'error'; out.error = String(e?.message || e).slice(0, 160) }
      return out
    }))
    return { configured: configured(), accounts }
  }

  function startAuth({ label } = {}) {
    if (!configured()) throw new GmailError('Totem has no Google OAuth client yet. Set one up as for Calendar (docs/gmail.md).', 409)
    const key = String(label || '').trim()
    if (!LABEL_RE.test(key)) throw new GmailError('label: letters, numbers, dash, underscore (max 40), no spaces')
    if (readTokens()[key]) throw new GmailError(`"${key}" is already connected — pick a different label, or remove it first`)
    const creds = client()
    const state = randomBytes(24).toString('base64url')
    for (const [k, v] of sessions) if (now() - v.createdAt > SESSION_TTL) sessions.delete(k)
    sessions.set(state, { label: key, createdAt: now() })
    const url = new URL(creds.auth_uri || 'https://accounts.google.com/o/oauth2/auth')
    url.searchParams.set('client_id', creds.client_id)
    url.searchParams.set('redirect_uri', redirectUri())
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', GMAIL_SCOPE)
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
    // Unticking the Gmail box on Google's consent screen still "succeeds".
    if (tok.scope && !String(tok.scope).split(/\s+/).includes(GMAIL_SCOPE)) {
      return { ok: false, message: 'Google did not grant Gmail access (the checkbox on the consent screen was left unticked). Try again and allow it.' }
    }
    sessions.delete(state)
    access.set(sess.label, { token: tok.access_token, exp: now() + (Number(tok.expires_in) || 3600) * 1000 })
    // Runs on the access token just cached, before the account is on disk.
    const email = (await api(sess.label, '/profile').catch(() => null))?.emailAddress || ''
    const tokens = readTokens()
    tokens[sess.label] = { refresh_token: tok.refresh_token, scope: tok.scope || GMAIL_SCOPE, email, connectedAt: new Date(now()).toISOString() }
    await writeTokens(tokens)
    return { ok: true, message: `Gmail "${sess.label}"${email ? ` (${email})` : ''} connected. You can close this tab and return to Totem.` }
  }

  async function removeAccount({ label } = {}) {
    const key = String(label || '').trim()
    const tokens = readTokens()
    if (!tokens[key]) throw new GmailError(`No Gmail account "${key}"`)
    const refreshToken = tokens[key].refresh_token
    delete tokens[key]
    await writeTokens(tokens)
    access.delete(key)
    labelCache.delete(key)
    // Best effort: also revoke the grant at Google, so removing it here means it is gone.
    fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, { method: 'POST' }).catch(() => {})
    return listAccounts()
  }

  async function renameAccount({ from, to } = {}) {
    const oldLabel = String(from || '').trim()
    const newLabel = String(to || '').trim()
    if (!LABEL_RE.test(newLabel)) throw new GmailError('label: letters, numbers, dash, underscore (max 40), no spaces')
    const tokens = readTokens()
    if (!tokens[oldLabel]) throw new GmailError(`No Gmail account "${oldLabel}"`)
    if (oldLabel === newLabel) return listAccounts()
    if (tokens[newLabel]) throw new GmailError(`"${newLabel}" already exists`)
    tokens[newLabel] = tokens[oldLabel]
    delete tokens[oldLabel]
    await writeTokens(tokens)
    access.delete(oldLabel)
    labelCache.delete(oldLabel)
    return listAccounts()
  }

  // ---- Reading -------------------------------------------------------------------

  const ref = (account, id) => `${account}:${id}`

  function summarize(account, m) {
    const h = headerMap(m.payload?.headers)
    const labelIds = m.labelIds || []
    return {
      id: ref(account, m.id),
      threadId: ref(account, m.threadId),
      account,
      from: h.from || '',
      to: h.to || '',
      cc: h.cc || '',
      subject: h.subject || '(no subject)',
      date: h.date || (m.internalDate ? new Date(Number(m.internalDate)).toISOString() : ''),
      snippet: m.snippet || '',
      labels: labelIds,
      unread: labelIds.includes('UNREAD'),
      starred: labelIds.includes('STARRED'),
      inInbox: labelIds.includes('INBOX'),
    }
  }

  async function searchOne(account, { query, max, pageToken, includeSpamTrash }) {
    const list = await api(account, '/messages', { query: { q: query || undefined, maxResults: max, pageToken, includeSpamTrash: includeSpamTrash ? 'true' : undefined } })
    const ids = (list.messages || []).map((m) => m.id)
    const messages = await mapLimit(ids, 8, (id) => api(account, `/messages/${id}`, {
      query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'] },
    }))
    return {
      messages: messages.map((m) => summarize(account, m)),
      nextPageToken: list.nextPageToken ? ref(account, list.nextPageToken) : null,
      estimate: list.resultSizeEstimate ?? null,
    }
  }

  // Gmail's own search syntax ("from:amy is:unread newer_than:7d"). With no
  // account, every connected account is searched and the results merged by date.
  async function search({ query = '', account = null, max = 20, pageToken = null, includeSpamTrash = false } = {}) {
    const limit = Math.max(1, Math.min(50, Number(max) || 20))
    if (pageToken) {
      const { account: acct, id } = splitRef(pageToken, account, accountLabels())
      return { ...(await searchOne(requireAccount(acct), { query, max: limit, pageToken: id, includeSpamTrash })), query }
    }
    const accounts = account ? [requireAccount(account)] : accountLabels()
    if (!accounts.length) requireAccount(null)
    const settled = await Promise.allSettled(accounts.map((a) => searchOne(a, { query, max: limit, includeSpamTrash })))
    const messages = []
    const errors = []
    const nextPageTokens = {}
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        messages.push(...r.value.messages)
        if (r.value.nextPageToken) nextPageTokens[accounts[i]] = r.value.nextPageToken
      } else errors.push(`${accounts[i]}: ${r.reason?.message || r.reason}`)
    })
    messages.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
    return { query, messages: messages.slice(0, limit * accounts.length), nextPageTokens, errors }
  }

  function fullMessage(account, m, maxChars) {
    const h = headerMap(m.payload?.headers)
    const { text, hasHtml, attachments } = readPayload(m.payload)
    const body = text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[… ${text.length - maxChars} more characters; read again with a larger maxChars]` : text
    return {
      ...summarize(account, m),
      replyTo: h['reply-to'] || '',
      messageIdHeader: h['message-id'] || '',
      body,
      hasHtml,
      attachments: attachments.map((a) => ({ ...a, messageId: ref(account, m.id) })),
    }
  }

  // A whole conversation. Accepts a thread id or the id of any message in it.
  async function readThread({ id, account = null, maxChars = 12_000 } = {}) {
    const { account: acct, id: raw } = splitRef(id, account, accountLabels())
    const a = requireAccount(acct)
    const cap = Math.max(500, Math.min(200_000, Number(maxChars) || 12_000))
    let thread
    try { thread = await api(a, `/threads/${encodeURIComponent(raw)}`, { query: { format: 'full' } }) }
    catch (e) {
      if (e.status !== 404 && e.status !== 400) throw e
      const m = await api(a, `/messages/${encodeURIComponent(raw)}`, { query: { format: 'minimal' } })
      thread = await api(a, `/threads/${m.threadId}`, { query: { format: 'full' } })
    }
    const messages = (thread.messages || []).map((m) => fullMessage(a, m, cap))
    return { threadId: ref(a, thread.id), account: a, subject: messages[0]?.subject || '', count: messages.length, messages }
  }

  async function readMessage({ id, account = null, maxChars = 50_000 } = {}) {
    const { account: acct, id: raw } = splitRef(id, account, accountLabels())
    const a = requireAccount(acct)
    const m = await api(a, `/messages/${encodeURIComponent(raw)}`, { query: { format: 'full' } })
    return fullMessage(a, m, Math.max(500, Math.min(200_000, Number(maxChars) || 50_000)))
  }

  async function getAttachment({ messageId, attachmentId, filename = 'attachment', account = null } = {}) {
    if (!cacheDir) throw new GmailError('attachments are unavailable: no cache directory')
    const { account: acct, id: raw } = splitRef(messageId, account, accountLabels())
    const a = requireAccount(acct)
    if (!attachmentId) throw new GmailError('attachmentId is required (from read_thread)')
    const att = await api(a, `/messages/${encodeURIComponent(raw)}/attachments/${encodeURIComponent(attachmentId)}`)
    const bytes = Buffer.from(att.data || '', 'base64url')
    const safe = String(filename).replace(/[^\w.\- ]+/g, '_').slice(-120) || 'attachment'
    const path = join(cacheDir, a, raw, safe)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes, { mode: 0o600 })
    return { path, filename: safe, size: bytes.length }
  }

  // ---- Labels, archive, trash -----------------------------------------------------

  async function labels(account, { fresh = false } = {}) {
    const cached = labelCache.get(account)
    if (!fresh && cached && now() - cached.at < 5 * 60_000) return cached.labels
    const list = (await api(account, '/labels')).labels || []
    labelCache.set(account, { at: now(), labels: list })
    return list
  }

  async function listLabels({ account = null } = {}) {
    const accounts = account ? [requireAccount(account)] : accountLabels()
    if (!accounts.length) requireAccount(null)
    const out = {}
    for (const a of accounts) {
      out[a] = (await labels(a, { fresh: true })).map((l) => ({ id: l.id, name: l.name, type: l.type }))
    }
    return { labels: out }
  }

  // Names or ids, any case, so an agent can say "Receipts" or "STARRED".
  async function labelIds(account, names = [], { create = false } = {}) {
    if (!names?.length) return []
    let list = await labels(account)
    const ids = []
    for (const raw of names) {
      const n = String(raw).trim()
      if (!n) continue
      let found = list.find((l) => l.id === n) || list.find((l) => l.name.toLowerCase() === n.toLowerCase())
      if (!found && create) {
        found = await api(account, '/labels', { method: 'POST', body: { name: n, labelListVisibility: 'labelShow', messageListVisibility: 'show' } })
        list = await labels(account, { fresh: true })
      }
      if (!found) throw new GmailError(`"${n}" is not a label on "${account}". Known: ${list.map((l) => l.name).join(', ')}`)
      ids.push(found.id)
    }
    return ids
  }

  // Group refs by account so one call can act across inboxes.
  function byAccount(ids, account) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean)
    if (!list.length) throw new GmailError('ids is required')
    if (list.length > 500) throw new GmailError('at most 500 messages per call')
    const known = accountLabels()
    const groups = new Map()
    for (const one of list) {
      const { account: a, id } = splitRef(one, account, known)
      const key = requireAccount(a)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(id)
    }
    return groups
  }

  async function modify({ ids, add = [], remove = [], account = null, createLabels = false } = {}) {
    if (!add?.length && !remove?.length) throw new GmailError('give add and/or remove')
    const groups = byAccount(ids, account)
    let changed = 0
    for (const [a, list] of groups) {
      const addLabelIds = await labelIds(a, add, { create: createLabels })
      const removeLabelIds = await labelIds(a, remove)
      await api(a, '/messages/batchModify', { method: 'POST', body: { ids: list, addLabelIds, removeLabelIds } })
      changed += list.length
    }
    return { ok: true, changed, add, remove }
  }

  // Trash is recoverable for 30 days; there is deliberately no permanent delete.
  async function trash({ ids, account = null, untrash = false } = {}) {
    const groups = byAccount(ids, account)
    let changed = 0
    for (const [a, list] of groups) {
      await mapLimit(list, 8, (id) => api(a, `/messages/${encodeURIComponent(id)}/${untrash ? 'untrash' : 'trash'}`, { method: 'POST' }))
      changed += list.length
    }
    return { ok: true, changed, trashed: !untrash }
  }

  // ---- Composing ---------------------------------------------------------------

  // Everything about an outgoing email, resolved and checked, before anything is
  // written: recipients, subject, and the reply threading headers from the
  // original. The inbox stages this exact object, so what the owner reads is
  // what goes out.
  async function prepareEmail({ account = null, to = [], cc = [], bcc = [], subject = '', body = '', replyTo = null, replyAll = false } = {}) {
    const text = String(body ?? '').trim()
    if (!text) throw new GmailError('body is required')
    if (text.length > 100_000) throw new GmailError('body is too long (100,000 characters max)')
    let a = null
    let threadId = null
    let inReplyTo = null
    let references = null
    let context = null
    let toList = parseAddressList(to)
    let ccList = parseAddressList(cc)
    const bccList = parseAddressList(bcc)
    let subj = String(subject ?? '').trim()
    const tokens = readTokens()
    if (replyTo) {
      const { account: acct, id } = splitRef(replyTo, account, accountLabels())
      a = requireAccount(acct)
      const m = await api(a, `/messages/${encodeURIComponent(id)}`, {
        query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Reply-To', 'Subject', 'Date', 'Message-ID', 'References'] },
      })
      const h = headerMap(m.payload?.headers)
      threadId = m.threadId
      inReplyTo = h['message-id'] || null
      references = [h.references, h['message-id']].filter(Boolean).join(' ') || null
      if (!subj) subj = replySubject(h.subject || '')
      const self = String(tokens[a]?.email || '').toLowerCase()
      const fromOriginal = parseAddressList(h['reply-to'] || h.from)
      const sentByOwner = fromOriginal.some((x) => x.email.toLowerCase() === self)
      if (!toList.length) toList = sentByOwner ? parseAddressList(h.to) : fromOriginal
      if (replyAll && !ccList.length) {
        const seen = new Set([self, ...toList.map((x) => x.email.toLowerCase())])
        ccList = parseAddressList([h.to, h.cc].filter(Boolean).join(', ')).filter((x) => {
          const k = x.email.toLowerCase()
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
      }
      context = { messageId: ref(a, m.id), from: h.from || '', date: h.date || '', subject: h.subject || '', snippet: m.snippet || '' }
    } else {
      a = requireAccount(account)
    }
    if (!toList.length) throw new GmailError('to is required (or replyTo, to answer a message)')
    if (toList.length + ccList.length + bccList.length > 50) throw new GmailError('at most 50 recipients')
    for (const x of [...toList, ...ccList, ...bccList]) {
      if (!validEmail(x.email)) throw new GmailError(`"${x.email}" is not an email address`)
    }
    if (!subj) throw new GmailError('subject is required')
    return {
      account: a,
      from: tokens[a]?.email || '',
      to: toList, cc: ccList, bcc: bccList,
      subject: subj, body: text,
      threadId: threadId ? ref(a, threadId) : null,
      inReplyTo, references,
      inReplyToMessage: context,
    }
  }

  function rawOf(email) {
    return toBase64Url(buildMessage({
      to: email.to, cc: email.cc, bcc: email.bcc, subject: email.subject, body: email.body,
      inReplyTo: email.inReplyTo, references: email.references,
    }))
  }

  const rawThread = (email) => (email.threadId ? splitRef(email.threadId, email.account, [email.account]).id : undefined)

  async function createDraft(args = {}) {
    const email = args.prepared || await prepareEmail(args)
    const d = await api(email.account, '/drafts', { method: 'POST', body: { message: { raw: rawOf(email), threadId: rawThread(email) } } })
    return {
      ok: true,
      draftId: ref(email.account, d.id),
      messageId: d.message?.id ? ref(email.account, d.message.id) : null,
      account: email.account,
      to: email.to.map((x) => x.email), subject: email.subject,
      threadId: email.threadId,
      openUrl: `https://mail.google.com/mail/u/${encodeURIComponent(email.from || 0)}/#drafts`,
    }
  }

  async function listDrafts({ account = null, max = 20 } = {}) {
    const accounts = account ? [requireAccount(account)] : accountLabels()
    if (!accounts.length) requireAccount(null)
    const limit = Math.max(1, Math.min(50, Number(max) || 20))
    const drafts = []
    for (const a of accounts) {
      const list = (await api(a, '/drafts', { query: { maxResults: limit } })).drafts || []
      const full = await mapLimit(list, 8, (d) => api(a, `/drafts/${d.id}`, { query: { format: 'metadata' } }))
      for (const d of full) drafts.push({ draftId: ref(a, d.id), ...summarize(a, d.message || {}) })
    }
    return { drafts }
  }

  async function deleteDraft({ id, account = null } = {}) {
    const { account: acct, id: raw } = splitRef(id, account, accountLabels())
    const a = requireAccount(acct)
    await api(a, `/drafts/${encodeURIComponent(raw)}`, { method: 'DELETE' })
    return { ok: true, deleted: ref(a, raw) }
  }

  // Not a tool. The inbox's accept path calls this, and nothing else may.
  async function send(email) {
    const m = await api(email.account, '/messages/send', { method: 'POST', body: { raw: rawOf(email), threadId: rawThread(email) } })
    return { ok: true, messageId: ref(email.account, m.id), threadId: ref(email.account, m.threadId), account: email.account }
  }

  return {
    configured, accountLabels, requireAccount, listAccounts, startAuth, completeAuth, removeAccount, renameAccount,
    search, readThread, readMessage, getAttachment, listLabels, modify, trash,
    prepareEmail, createDraft, listDrafts, deleteDraft, send,
  }
}

async function mapLimit(items, limit, fn) {
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
