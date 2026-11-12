// The LinkedIn reader: the owner's LinkedIn, read through Totem's own browser,
// read-only and slowly.
//
// LinkedIn has no API for a personal account's feed, notifications or messages,
// so the connector reads the pages a signed-in browser sees. The sign-in is the
// owner's own: he signs in to LinkedIn in a chat's browser panel (preview_open +
// preview_handoff), and `signIn` copies that chat's LinkedIn cookies here. They
// are kept in one 0600 file (data/linkedin-tokens.json by default, under the
// `data/*-tokens.json` rules that keep Claude's file tools off it and the change
// flow from committing it).
//
// Every read is one page in a fresh context through `browser.readPage`
// (browser/manager.mjs), which lets only GET and HEAD requests to LinkedIn's hosts
// out of the page. Nothing a page's own script tries (a like, a comment, a read
// receipt, a "seen" ping) is ever sent. This module never clicks, types or submits.
//
// Slowly: at most `maxPagesPerHour` page loads an hour (default 20), one at a
// time, each after a random pause, and no reads of its own: it loads a page only
// when a tool asks, which is a chat or the totem's own schedule.

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LINKEDIN_HOSTS, canonicalLinkedinUrl } from './urls.mjs'
import { PAGE_URLS, extractLinkedinPage, signedOutPath } from './pages.mjs'

export const SOURCE_ID = 'linkedin'
const HOUR = 60 * 60_000

export class LinkedinError extends Error {
  constructor(message, { status = 400, code = 'LINKEDIN' } = {}) {
    super(message)
    this.name = 'LinkedinError'
    this.status = status
    this.code = code
  }
}

const SIGN_IN_STEPS = 'Ask the owner to sign in: in a chat, open https://www.linkedin.com/login with preview_open, call preview_handoff so he signs in in the browser panel, then call linkedin__sign_in from that chat.'

/** Only LinkedIn's own cookies and storage, from a whole browser context's state. */
export function linkedinOnly(state) {
  const onLinkedin = (domain) => /(^|\.)linkedin\.com$/i.test(String(domain || '').replace(/^\./, ''))
  return {
    cookies: (state?.cookies || []).filter((c) => onLinkedin(c.domain)),
    origins: (state?.origins || []).filter((o) => { try { return onLinkedin(new URL(o.origin).hostname) } catch { return false } }),
  }
}

/** The session cookie, if it is there and not expired. */
export function sessionCookie(state, nowMs = Date.now()) {
  const c = (state?.cookies || []).find((x) => x.name === 'li_at' && /(^|\.)linkedin\.com$/i.test(String(x.domain || '').replace(/^\./, '')))
  if (!c || !c.value) return null
  if (Number(c.expires) > 0 && Number(c.expires) * 1000 < nowMs) return null
  return c
}

export function createLinkedinReader({
  browser,
  file,
  available = () => Boolean(browser?.available?.()),
  runs = null,
  maxPagesPerHour = 20,
  log = () => {},
  now = () => Date.now(),
  pause = () => new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 3500))),
} = {}) {
  if (!file) throw new TypeError('createLinkedinReader requires file')
  const limit = Math.max(1, Math.min(120, Math.floor(Number(maxPagesPerHour) || 20)))
  const loads = [] // timestamps of page loads in the last hour
  let queue = Promise.resolve()
  let lastReadAt = null
  let lastError = null
  const track = typeof runs?.track === 'function' ? (fn) => runs.track(SOURCE_ID, fn) : (fn) => fn()
  const unconfigured = (reason) => { try { runs?.markUnconfigured?.(SOURCE_ID, reason) } catch {} }

  async function load() {
    try { return JSON.parse(await readFile(file, 'utf8')) } catch { return null }
  }

  async function save(record) {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, file)
  }

  const recent = () => {
    const cutoff = now() - HOUR
    while (loads.length && loads[0] < cutoff) loads.shift()
    return loads.length
  }

  async function status() {
    const record = await load()
    const pagesLastHour = recent()
    const base = { pagesLastHour, pageLimit: limit, lastReadAt, lastError }
    if (!available()) return { ...base, connected: false, state: 'unavailable', nextStep: 'This Totem has no browser (Chromium) to read LinkedIn with.' }
    if (!record) return { ...base, connected: false, state: 'not-signed-in', nextStep: SIGN_IN_STEPS }
    if (record.signedOutAt || !sessionCookie(record.state, now())) {
      return { ...base, connected: false, state: 'signed-out', signedInAt: record.signedInAt || null, signedOutAt: record.signedOutAt || null, nextStep: `LinkedIn signed Totem out. ${SIGN_IN_STEPS}` }
    }
    return { ...base, connected: true, state: 'connected', signedInAt: record.signedInAt || null, nextStep: null }
  }

  // One page, under the hour's budget, after a pause. Serialised, so two tools
  // called at once still read one page at a time.
  function readOne(url, { mode, limit: itemLimit = 10, scrolls = 0, state }) {
    const run = queue.then(async () => {
      const over = overBudget()
      if (over) throw over
      await pause()
      loads.push(now())
      return browser.readPage({ storageState: state, url, hosts: LINKEDIN_HOSTS, extract: extractLinkedinPage, arg: { mode, limit: itemLimit }, scrolls })
    })
    queue = run.then(() => {}, () => {})
    return run
  }

  async function connectedState() {
    if (!available()) throw new LinkedinError('LinkedIn is not connected: this Totem has no browser to read it with.', { status: 503, code: 'LINKEDIN_UNAVAILABLE' })
    const record = await load()
    if (!record || !sessionCookie(record.state, now())) {
      unconfigured('Not signed in to LinkedIn.')
      throw new LinkedinError(`LinkedIn is not connected. ${SIGN_IN_STEPS}`, { status: 409, code: 'LINKEDIN_NOT_CONNECTED' })
    }
    if (record.signedOutAt) {
      throw new LinkedinError(`LinkedIn signed Totem out on ${record.signedOutAt.slice(0, 10)}. ${SIGN_IN_STEPS}`, { status: 401, code: 'LINKEDIN_SIGNED_OUT' })
    }
    return record
  }

  const overBudget = () => {
    if (recent() < limit) return null
    const nextAt = new Date(loads[0] + HOUR).toISOString()
    // Totem's own limit, not LinkedIn failing: no status a source-health run counts as a fault.
    return new LinkedinError(`Totem reads at most ${limit} LinkedIn pages an hour, and has read ${limit}. Try again after ${nextAt}.`, { status: 400, code: 'LINKEDIN_RATE_LIMIT' })
  }

  async function read(mode, url, opts = {}) {
    const record = await connectedState()
    const over = overBudget()
    if (over) throw over
    try {
      return await track(async () => {
        const page = await readOne(url, { ...opts, mode, state: record.state })
        if (signedOutPath(page.url)) {
          await save({ ...record, signedOutAt: new Date(now()).toISOString() })
          throw new LinkedinError(`LinkedIn signed Totem out (it sent the browser to its sign-in page). ${SIGN_IN_STEPS}`, { status: 401, code: 'LINKEDIN_SIGNED_OUT' })
        }
        if (page.status && page.status >= 400) throw new LinkedinError(`LinkedIn answered ${page.status} for ${url}.`, { status: page.status >= 500 ? 502 : page.status })
        // LinkedIn rotates cookies as it goes; keep the newest, and only its own.
        const rotated = linkedinOnly(page.storageState)
        if (sessionCookie(rotated, now())) await save({ ...record, state: rotated, lastReadAt: new Date(now()).toISOString() })
        lastReadAt = new Date(now()).toISOString()
        lastError = null
        return { url: page.url, title: page.title, ...page.data, blockedRequests: page.blocked.length }
      })
    } catch (e) {
      lastError = String(e?.message || e).slice(0, 300)
      throw e
    }
  }

  return {
    status,
    limit,

    /** Copy the LinkedIn sign-in from a chat's browser state, then check it with one read. */
    async signIn(chatState) {
      if (!available()) throw new LinkedinError('This Totem has no browser to read LinkedIn with.', { status: 503, code: 'LINKEDIN_UNAVAILABLE' })
      const state = linkedinOnly(chatState)
      if (!sessionCookie(state, now())) return { connected: false, state: 'not-signed-in', nextStep: `This chat's browser is not signed in to LinkedIn. ${SIGN_IN_STEPS}` }
      const at = new Date(now()).toISOString()
      await save({ version: 1, signedInAt: at, state })
      log('linkedin: sign-in saved')
      try {
        const page = await read('feed', PAGE_URLS.feed)
        return { connected: true, state: 'connected', signedInAt: at, checked: page.url, nextStep: null }
      } catch (e) {
        if (e?.code === 'LINKEDIN_SIGNED_OUT') return { connected: false, state: 'signed-out', nextStep: e.message }
        throw e
      }
    },

    async signOut() {
      await rm(file, { force: true })
      unconfigured('Signed out of LinkedIn.')
      log('linkedin: sign-in removed')
      return { connected: false, state: 'not-signed-in' }
    },

    notifications: () => read('notifications', PAGE_URLS.notifications, { limit: 25, scrolls: 1 }),
    messages: () => read('messages', PAGE_URLS.messages, { limit: 20 }),
    conversation: async (url) => read('conversation', canonicalLinkedinUrl(url, { kinds: ['conversation'] }).url),
    feed: async (count = 10) => {
      const n = Math.max(1, Math.min(25, Math.floor(Number(count) || 10)))
      return read('feed', PAGE_URLS.feed, { limit: n, scrolls: Math.ceil(n / 5) })
    },
    profile: async (url) => read('profile', canonicalLinkedinUrl(url, { kinds: ['profile'] }).url, { limit: 5 }),
  }
}
