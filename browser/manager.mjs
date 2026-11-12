// The agents' browser: T3 Code's collaborative-browser operations, run by
// Playwright on a Chromium on this box (browser/pick.mjs picks which one).
//
// One Chromium process, launched on first use and closed after BROWSER_IDLE_MS
// of nobody browsing. Each chat gets its own BrowserContext (cookies, storage,
// tabs) so two chats never see each other's logins, and the context outlives a
// turn: "now click the second result" on the next message finds the same page.
// A context idle for CONTEXT_IDLE_MS is closed.
//
// Every operation returns plain data; tools.mjs shapes it for MCP. After any
// action that can change the page, `onFrame` gets a small JPEG of the viewport
// so the chat can show the user what the agent is looking at. While someone
// watches the panel (`watch`), the current tab is also streamed with CDP's
// screencast, and the owner's own mouse and keys arrive through `input`.

import { randomUUID } from 'node:crypto'
import { readOnlyRequestDecision } from './read-only.mjs'
import { findChromium, launchOptions, plainUserAgent } from './pick.mjs'
import { cdpMouse, cdpWheel, coalesce, parseInput, MODIFIERS } from './input.mjs'

export { readOnlyRequestDecision, findChromium }

const CONTEXT_IDLE_MS = 30 * 60_000
const BROWSER_IDLE_MS = 10 * 60_000
const DEFAULT_TIMEOUT = 15_000
const MAX_TIMEOUT = 60_000
const TEXT_CAP = 20_000
const LOG_CAP = 200
const DEFAULT_VIEWPORT = { width: 1280, height: 800 }
// What a 1080p monitor reports; a viewport bigger than its screen is a tell.
const SCREEN = { width: 1920, height: 1080 }
// The stream's pace: at most this many frames a second. A viewer whose link is
// behind keeps only the newest frame (browser/socket.mjs), so nothing queues.
const STREAM_FPS = 24
// A release sent to a tab that is busy (or hung) gives up after this, so the
// owner's input to the tab he is looking at never waits behind it.
const RELEASE_TIMEOUT_MS = 1000
// html_preview's page, answered by a route; nothing on the network is asked for it.
const RENDER_URL = 'http://totem-visual.localhost/page.html'
const RENDER_TIMEOUT_MS = 20_000
const RENDER_LOAD_MS = 10_000
const RENDER_MAX_HEIGHT = 4000
const RENDER_BACKDROP = { r: 15, g: 17, b: 21, a: 1 } // the dashboard's --bg

// Chrome DevTools' standard device sizes, the ones T3's preset list names.
export const VIEWPORT_PRESETS = {
  'iphone-se': { width: 375, height: 667 },
  'iphone-12-pro': { width: 390, height: 844 },
  'iphone-14-pro-max': { width: 430, height: 932 },
  'pixel-7': { width: 412, height: 915 },
  'samsung-galaxy-s20-ultra': { width: 412, height: 915 },
  'ipad-mini': { width: 768, height: 1024 },
  'ipad-air': { width: 820, height: 1180 },
  'ipad-pro': { width: 1024, height: 1366 },
  'surface-pro-7': { width: 912, height: 1368 },
  'nest-hub': { width: 1024, height: 600 },
  'laptop': { width: 1280, height: 800 },
  'desktop': { width: 1920, height: 1080 },
}

export class BrowserError extends Error {
  constructor(message) { super(message); this.name = 'BrowserError' }
}

const clampTimeout = (ms) => Math.min(MAX_TIMEOUT, Math.max(1, Number(ms) || DEFAULT_TIMEOUT))
const now = () => new Date().toISOString()
const push = (list, item) => { list.push(item); if (list.length > LOG_CAP) list.splice(0, list.length - LOG_CAP) }

/** "t3.chat" → https://t3.chat, "localhost:5173" → http://localhost:5173 (T3's rule). */
export function normalizeUrl(raw) {
  const s = String(raw || '').trim()
  if (!s) throw new BrowserError('A URL is required.')
  if (s.length > 2048) throw new BrowserError('That URL is longer than 2048 characters.')
  if (/^(about:blank|data:)/i.test(s)) return s
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (!/^https?:\/\//i.test(s)) throw new BrowserError(`Only http(s) URLs can be opened, not ${s.split(':')[0]}.`)
    return s
  }
  const host = s.split(/[/?#]/)[0].toLowerCase()
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?$/.test(host)
  return `${loopback ? 'http' : 'https'}://${s}`
}

export function createBrowserManager({
  log = () => {}, onFrame = () => {}, executablePath = findChromium(), loadPlaywright = () => import('playwright-core'),
  headed = false, contextIdleMs = CONTEXT_IDLE_MS, browserIdleMs = BROWSER_IDLE_MS, releaseTimeoutMs = RELEASE_TIMEOUT_MS,
} = {}) {
  let browserPromise = null
  let browserIdle = null
  let userAgent // the browser's own user agent, minus "Headless"; undefined until launched
  const sessions = new Map() // threadId → { context, tabs: Map<tabId, tab>, current, lastUsed, timer, scheme, viewers, cast, … }
  let rendering = 0
  const renderQueue = []
  let reading = 0

  async function browser() {
    if (browserIdle) { clearTimeout(browserIdle); browserIdle = null }
    if (!browserPromise) {
      if (!executablePath) throw new BrowserError('No Chromium on this machine. Run `npx playwright install chromium`, or install Google Chrome.')
      browserPromise = loadPlaywright().then(({ chromium }) => chromium.launch(launchOptions({ executablePath, headed }))).then(async (b) => {
        b.on('disconnected', () => {
          browserPromise = null
          for (const s of sessions.values()) endViewers(s, 'closed')
          sessions.clear()
        })
        userAgent = await ownUserAgent(b)
        log(`browser: started ${executablePath}${headed ? ' (headed)' : ''}`)
        return b
      })
      browserPromise.catch(() => { browserPromise = null })
    }
    return browserPromise
  }

  // Context options every page a site sees gets: the browser's own user agent
  // without "HeadlessChrome", and a screen the size of a real monitor.
  function contextOptions(extra = {}) {
    return {
      viewport: DEFAULT_VIEWPORT,
      screen: SCREEN,
      ...(userAgent ? { userAgent } : {}),
      locale: 'en-US',
      timezoneId: process.env.MORNING_BRIEFING_TZ || undefined,
      ...extra,
    }
  }

  function scheduleBrowserIdle() {
    if (browserIdle) clearTimeout(browserIdle)
    browserIdle = setTimeout(async () => {
      if (sessions.size || reading || rendering || !browserPromise) return
      const b = await browserPromise.catch(() => null)
      browserPromise = null
      await b?.close().catch(() => {})
      log('browser: closed after idle')
    }, browserIdleMs)
    browserIdle.unref?.()
  }

  function touch(s, key) {
    s.lastUsed = Date.now()
    if (s.timer) clearTimeout(s.timer)
    s.timer = setTimeout(() => closeSession(key), contextIdleMs)
    s.timer.unref?.()
  }

  async function closeSession(key) {
    const s = sessions.get(key)
    if (!s) return
    sessions.delete(key)
    if (s.timer) clearTimeout(s.timer)
    endViewers(s, 'closed')
    await stopCast(s)
    await s.context.close().catch(() => {})
    if (!sessions.size) scheduleBrowserIdle()
  }

  function watchTab(s, page) {
    const tab = { id: `tab-${randomUUID().slice(0, 8)}`, page, title: '', cdp: null, held: new Map(), point: { x: 0, y: 0 }, console: [], network: [], actions: [], viewport: { mode: 'fill', ...DEFAULT_VIEWPORT } }
    page.on('console', (m) => push(tab.console, { level: m.type(), text: m.text().slice(0, 2000), timestamp: now(), source: m.location()?.url || undefined }))
    page.on('pageerror', (e) => push(tab.console, { level: 'error', text: String(e?.message || e).slice(0, 2000), timestamp: now(), source: 'pageerror' }))
    page.on('requestfinished', async (r) => {
      const res = await r.response().catch(() => null)
      push(tab.network, { url: r.url().slice(0, 500), method: r.method(), status: res?.status() ?? null, failed: false, timestamp: now() })
    })
    page.on('requestfailed', (r) => push(tab.network, { url: r.url().slice(0, 500), method: r.method(), status: null, failed: true, errorText: r.failure()?.errorText, timestamp: now() }))
    // The stream's header names the page; a title read per frame would cost a round trip.
    page.on('domcontentloaded', () => { page.title().then((t) => { tab.title = t }, () => {}) })
    page.on('close', () => {
      s.tabs.delete(tab.id)
      if (s.current === tab.id) s.current = s.tabs.keys().next().value || null
      void syncCast(s)
    })
    s.tabs.set(tab.id, tab)
    return tab
  }

  async function session(key, { create = true } = {}) {
    let s = sessions.get(key)
    if (!s && create) {
      const b = await browser()
      const context = await b.newContext(contextOptions())
      s = { context, tabs: new Map(), current: null, lastUsed: Date.now(), timer: null, scheme: 'system', viewers: new Set(), cast: null, castOp: Promise.resolve(), lastCast: null, queue: [], pumping: false }
      // A page the site opens itself (target=_blank) becomes a tab and the current one.
      context.on('page', (page) => {
        if ([...s.tabs.values()].some((t) => t.page === page)) return
        makeCurrent(s, watchTab(s, page).id)
        void syncCast(s)
      })
      sessions.set(key, s)
    }
    if (s) touch(s, key)
    return s
  }

  // ---- The live stream ------------------------------------------------------
  // CDP's Page.startScreencast on the current tab while at least one viewer
  // watches, stopped when the last one leaves, the tab changes or the context
  // closes. Watching never opens a browser or a context, and never keeps one
  // alive: only the agent's actions and the owner's input touch the idle timer.

  async function cdpFor(s, tab) {
    if (!tab.cdp) {
      tab.cdp = s.context.newCDPSession(tab.page)
      tab.cdp.catch(() => { tab.cdp = null })
    }
    return tab.cdp
  }

  function castSettings(s, tab) {
    const size = tab.page.viewportSize() || DEFAULT_VIEWPORT
    let px = 0
    for (const v of s.viewers) px = Math.max(px, Math.round((v.width || 0) * (v.dpr || 1)))
    // The frame at the size it is shown, never above the page's own pixels; a
    // frame shown well below full size can take a coarser JPEG.
    const maxWidth = Math.min(size.width, Math.max(320, px || size.width))
    const maxHeight = Math.max(200, Math.round(maxWidth * (size.height / size.width)))
    return { format: 'jpeg', quality: maxWidth < size.width * 0.75 ? 60 : 75, maxWidth, maxHeight, everyNthFrame: 1 }
  }

  /** Serialise every start and stop of one session's screencast. */
  function syncCast(s, { restart = false } = {}) {
    s.castOp = s.castOp.then(() => applyCast(s, restart)).catch((e) => log(`browser: stream ${String(e?.message || e).split('\n')[0]}`))
    return s.castOp
  }

  async function applyCast(s, restart) {
    const tab = s.viewers.size && s.current ? s.tabs.get(s.current) : null
    if (s.cast && (!tab || s.cast.tab !== tab || restart)) await stopCast(s)
    if (!tab || s.cast || !sessions.has(keyOf(s))) return
    const cdp = await cdpFor(s, tab)
    const settings = castSettings(s, tab)
    const cast = { tab, cdp, settings, lastAck: 0 }
    cast.handler = (ev) => onCastFrame(s, cast, ev)
    cdp.on('Page.screencastFrame', cast.handler)
    s.cast = cast
    try {
      await cdp.send('Page.startScreencast', settings)
    } catch (e) {
      // A tab detached mid-navigation: forget this cast so the next sync starts afresh.
      if (s.cast === cast) s.cast = null
      cdp.off?.('Page.screencastFrame', cast.handler)
      throw e
    }
  }

  async function stopCast(s) {
    const cast = s.cast
    if (!cast) return
    s.cast = null
    cast.cdp.off?.('Page.screencastFrame', cast.handler)
    await cast.cdp.send('Page.stopScreencast').catch(() => {})
  }

  async function onCastFrame(s, cast, ev) {
    const ack = () => cast.cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {})
    if (s.cast !== cast) return ack()
    const m = ev.metadata || {}
    const frame = {
      tabId: cast.tab.id, url: cast.tab.page.url(), title: cast.tab.title,
      width: Math.round(m.deviceWidth || cast.settings.maxWidth), height: Math.round(m.deviceHeight || cast.settings.maxHeight),
      jpeg: Buffer.from(ev.data, 'base64'), at: Date.now(),
    }
    s.lastCast = frame
    // Never waits on a viewer: one that is behind keeps its newest frame itself
    // (browser/socket.mjs), so it cannot slow the others.
    for (const v of s.viewers) { try { v.onFrame(frame) } catch {} }
    const wait = cast.lastAck + 1000 / STREAM_FPS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    cast.lastAck = Date.now()
    if (s.cast === cast) ack()
  }

  function endViewers(s, reason) {
    for (const v of s.viewers) { try { v.onEnd?.(reason) } catch {} }
    s.viewers.clear()
  }

  function keyOf(s) {
    for (const [k, v] of sessions) if (v === s) return k
    return null
  }

  /**
   * Stream a chat's current tab to one viewer: `onFrame({ jpeg, width, height,
   * tabId, url, title, at })` per frame, `onEnd(reason)` when the browser closes. Null when the chat has no
   * browser open: watching never opens one. `view({ width, dpr })` says what
   * size the viewer shows it at; `stop()` leaves.
   */
  function watch(key, { onFrame: take, onEnd, width = 0, dpr = 1 } = {}) {
    const s = sessions.get(key)
    if (!s) return null
    const viewer = { onFrame: take, onEnd, width, dpr }
    s.viewers.add(viewer)
    void syncCast(s, { restart: s.viewers.size > 1 }).then(() => sendStill(s, viewer))
    return {
      view({ width: w = viewer.width, dpr: d = viewer.dpr } = {}) {
        if (Math.abs(w * d - viewer.width * viewer.dpr) < 64) return
        viewer.width = w; viewer.dpr = d
        if (s.viewers.has(viewer)) void syncCast(s, { restart: true })
      },
      stop() {
        if (!s.viewers.delete(viewer)) return
        void syncCast(s)
      },
    }
  }

  // A page that is not painting sends no screencast frame, so a viewer who
  // arrives gets the page as it stands at once.
  async function sendStill(s, viewer) {
    const tab = s.current && s.tabs.get(s.current)
    if (!tab || !s.viewers.has(viewer)) return
    const size = tab.page.viewportSize() || DEFAULT_VIEWPORT
    const jpeg = await tab.page.screenshot({ type: 'jpeg', quality: 70, timeout: 5000 }).catch(() => null)
    if (!jpeg || !s.viewers.has(viewer)) return
    try { viewer.onFrame({ tabId: tab.id, url: tab.page.url(), title: tab.title, width: size.width, height: size.height, jpeg, at: Date.now() }) } catch {}
  }

  /** The newest streamed frame of a chat's browser, or null. */
  function latestFrame(key) {
    return sessions.get(key)?.lastCast || null
  }

  // ---- The owner's input ----------------------------------------------------
  // Raw events from the panel (browser/input.mjs parses them), sent in order
  // per chat. A burst of moves or wheel turns waiting behind a slow one is
  // folded into one, so a dragged mouse never falls seconds behind.
  //
  // What is held down is kept per tab, as entry ("key:Shift", "button:left") →
  // the owners holding it (one per panel socket). An owner is recorded before
  // the down is sent, so a release queued while it is in flight finds it. An up
  // goes to the page only when the last owner lets go, so one socket never lifts
  // what another holds, and only for what the tab holds, so a stray up is
  // dropped. A modifier the bridge pressed because a key arrived listing it is
  // that owner's too, let go by its next key-up that no longer lists it.

  /**
   * One input event from the panel into the chat's current tab, checked by
   * parseInput against that tab's viewport, from `owner` (the socket sending
   * it). Resolves once the page has it.
   */
  function input(key, raw, owner = 'http') {
    const s = sessions.get(key)
    if (!s) return Promise.reject(new BrowserError('No browser tab is open in this chat.'))
    const tab = s.current && s.tabs.get(s.current)
    const ev = parseInput(raw, tab?.page.viewportSize() || DEFAULT_VIEWPORT)
    if (!ev) return Promise.reject(new BrowserError('That is not an input the browser takes.'))
    touch(s, key)
    return enqueue(s, ev, owner)
  }

  function enqueue(s, ev, owner = null) {
    const last = s.queue[s.queue.length - 1]
    const merged = last && last.owner === owner && coalesce(last.ev, ev)
    if (merged) { last.ev = merged; return last.done }
    const item = { ev, owner }
    item.done = new Promise((resolve, reject) => { item.resolve = resolve; item.reject = reject })
    s.queue.push(item)
    void pump(s)
    return item.done
  }

  /**
   * The current tab changes (a link opened a tab, the agent switched): one job,
   * behind the input already queued, lets go of everything the old tab holds
   * when it runs, so a press still in flight is let go too.
   */
  function makeCurrent(s, id) {
    const prev = s.current && s.tabs.get(s.current)
    s.current = id
    if (prev && prev.id !== id) void enqueue(s, { kind: 'release', tab: prev }).catch(() => {})
  }

  /** `owner` (a panel socket closing, or its keys losing focus) lets go of all it holds, on every tab. */
  function release(key, owner) {
    const s = sessions.get(key)
    if (!s) return Promise.resolve()
    return enqueue(s, { kind: 'release' }, owner)
  }

  const heldModifiers = (tab) => MODIFIERS.filter((m) => tab.held.has(`key:${m}`))
  // Adds `owner` to `entry`; true when it was not held at all before.
  function hold(tab, entry, owner) {
    const owners = tab.held.get(entry)
    if (owners) { owners.add(owner); return false }
    tab.held.set(entry, new Set([owner]))
    return true
  }
  // Takes `owner` off `entry`; true when that was the last owner, so the up is due.
  function letGo(tab, entry, owner) {
    const owners = tab.held.get(entry)
    if (!owners?.delete(owner) || owners.size) return false
    tab.held.delete(entry)
    return true
  }

  // An up sent on a tab that may be busy or gone: never thrown, so one failure
  // does not skip the releases after it. The release job bounds the wait.
  function sendUp(s, tab, entry) {
    const [kind, name] = entry.split(/:(.*)/s)
    const sent = kind === 'button'
      ? cdpFor(s, tab).then((cdp) => cdp.send('Input.dispatchMouseEvent', cdpMouse({ type: 'up', ...tab.point, button: name, buttons: 0, clickCount: 1, modifiers: heldModifiers(tab) })))
      : tab.page.keyboard.up(name)
    return sent.catch(() => {})
  }

  // Buttons first, then keys, modifiers last, so each up carries the modifiers still down.
  const releaseOrder = (entries) => [...entries].sort((a, b) => rank(a) - rank(b))
  const rank = (entry) => (entry.startsWith('button:') ? 0 : MODIFIERS.includes(entry.slice(4)) ? 2 : 1)

  async function pump(s) {
    if (s.pumping) return
    s.pumping = true
    try {
      while (s.queue.length) {
        const item = s.queue.shift()
        try { item.resolve(await dispatch(s, item.ev, item.owner)) } catch (e) { item.reject(e instanceof BrowserError ? e : new BrowserError(cleanPlaywrightError(e))) }
      }
    } finally { s.pumping = false }
  }

  async function dispatch(s, ev, owner) {
    if (ev.kind === 'release') {
      // A tab switch: everything the old tab holds, read now. An owner: what it
      // holds, anywhere. The whole job waits at most releaseTimeoutMs; past that
      // the rest of its ups go out without waiting for a tab that is not answering.
      const deadline = Date.now() + releaseTimeoutMs
      for (const tab of ev.tab ? [ev.tab] : s.tabs.values()) {
        if (s.tabs.get(tab.id) !== tab) { tab.held.clear(); continue }
        for (const entry of releaseOrder(tab.held.keys())) {
          const due = ev.tab ? tab.held.delete(entry) : letGo(tab, entry, owner)
          if (!due) continue
          const sent = sendUp(s, tab, entry)
          const left = deadline - Date.now()
          if (left > 0) await Promise.race([sent, new Promise((r) => setTimeout(r, left).unref?.())])
        }
      }
      return
    }
    const tab = s.current && s.tabs.get(s.current)
    if (!tab) throw new BrowserError('No browser tab is open in this chat.')
    const page = tab.page
    // Each down is recorded first and undone if it fails; each up only for an owner holding it.
    const press = async (entry, send, { always = true } = {}) => {
      const had = !!tab.held.get(entry)?.has(owner)
      const first = hold(tab, entry, owner)
      if (!first && !always) return
      // A failed repeat leaves the good down before it held.
      try { await send() } catch (e) { if (!had) letGo(tab, entry, owner); throw e }
    }
    const lift = (entry, send) => (letGo(tab, entry, owner) ? send() : undefined)
    if (ev.kind === 'mouse' || ev.kind === 'wheel') {
      const cdp = await cdpFor(s, tab)
      tab.point = { x: ev.x, y: ev.y }
      const params = ev.kind === 'wheel' ? cdpWheel(ev) : cdpMouse(ev)
      if (ev.kind === 'mouse' && ev.type === 'down') return press(`button:${ev.button}`, () => cdp.send('Input.dispatchMouseEvent', params))
      if (ev.kind === 'mouse' && ev.type === 'up') return lift(`button:${ev.button}`, () => cdp.send('Input.dispatchMouseEvent', params))
      return cdp.send('Input.dispatchMouseEvent', params)
    }
    if (ev.kind === 'text') return page.keyboard.insertText(ev.text)
    if (ev.kind !== 'key') return
    const isModifier = MODIFIERS.includes(ev.key)
    if (!isModifier) {
      // The page's modifiers follow what this owner says it holds: a key-down
      // listing one presses it, any key event no longer listing it lets go.
      for (const m of MODIFIERS) {
        const has = tab.held.get(`key:${m}`)?.has(owner)
        if (ev.modifiers.includes(m) && !has && ev.type === 'down') await press(`key:${m}`, () => page.keyboard.down(m), { always: false })
        if (!ev.modifiers.includes(m) && has) await lift(`key:${m}`, () => page.keyboard.up(m))
      }
    }
    const entry = `key:${ev.key}`
    if (ev.type === 'up') return lift(entry, () => page.keyboard.up(ev.key).catch((e) => { if (!/Unknown key/i.test(String(e?.message))) throw e }))
    try {
      await press(entry, () => page.keyboard.down(ev.key))
    } catch (e) {
      // A key Playwright's layout does not know: a character still types.
      if ([...ev.key].length === 1) return page.keyboard.insertText(ev.key)
      if (!/Unknown key/i.test(String(e?.message))) throw e
    }
  }

  async function tabFor(key, tabId, { create = true } = {}) {
    const s = await session(key, { create })
    if (!s) throw new BrowserError('No browser tab is open in this chat. Call preview_open first.')
    if (tabId) {
      const tab = s.tabs.get(tabId)
      if (!tab) throw new BrowserError(`No tab ${tabId}. Open tabs: ${[...s.tabs.keys()].join(', ') || 'none'}.`)
      makeCurrent(s, tab.id)
      return { s, tab }
    }
    let tab = s.current && s.tabs.get(s.current)
    if (!tab) {
      if (!create) throw new BrowserError('No browser tab is open in this chat. Call preview_open first.')
      const page = await s.context.newPage()
      tab = [...s.tabs.values()].find((t) => t.page === page) || watchTab(s, page)
      makeCurrent(s, tab.id)
    }
    return { s, tab }
  }

  async function status(key, { tabId } = {}) {
    const s = sessions.get(key)
    const tab = s && (tabId ? s.tabs.get(tabId) : s.current && s.tabs.get(s.current))
    if (!tab) return { available: true, visible: false, tabId: null, url: null, title: null, loading: false }
    const size = tab.page.viewportSize() || DEFAULT_VIEWPORT
    return {
      available: true, visible: true, tabId: tab.id,
      url: tab.page.url(), title: await tab.page.title().catch(() => ''),
      loading: await tab.page.evaluate(() => document.readyState !== 'complete').catch(() => false),
      viewportSetting: tab.viewport.mode === 'preset' ? { mode: 'preset', preset: tab.viewport.preset } : { mode: tab.viewport.mode },
      viewport: { width: size.width, height: size.height },
      tabs: [...s.tabs.values()].map((t) => ({ tabId: t.id, url: t.page.url() })),
    }
  }

  // Each action is logged on the tab's timeline, the way T3's snapshot reports
  // "action history", so a model can see what it already tried.
  async function act(tab, action, fn) {
    const entry = { id: randomUUID().slice(0, 8), action, status: 'running', startedAt: now() }
    push(tab.actions, entry)
    try {
      const out = await fn()
      entry.status = 'succeeded'
      return out
    } catch (e) {
      entry.status = 'failed'
      entry.error = String(e?.message || e).split('\n')[0].slice(0, 400)
      throw new BrowserError(cleanPlaywrightError(e))
    } finally {
      entry.completedAt = now()
    }
  }

  async function frame(key, tab) {
    const s = sessions.get(key)
    if (s?.viewers.size && s.cast?.tab !== tab) void syncCast(s)
    try {
      const jpeg = await tab.page.screenshot({ type: 'jpeg', quality: 62, timeout: 5000 })
      onFrame(key, { tabId: tab.id, url: tab.page.url(), title: await tab.page.title().catch(() => ''), jpeg })
    } catch {}
  }

  function target(page, { locator, selector, x, y }) {
    if (locator) return page.locator(locator).first()
    if (selector) return page.locator(`css=${selector}`).first()
    if (x !== undefined && y !== undefined) return null
    throw new BrowserError('Provide exactly one target: locator, selector, or x and y.')
  }

  async function open(key, { tabId, url, reuseExistingTab = true } = {}) {
    const s = await session(key)
    let tab
    if (!reuseExistingTab) {
      if (tabId) throw new BrowserError('tabId cannot be combined with reuseExistingTab=false.')
      const page = await s.context.newPage()
      tab = [...s.tabs.values()].find((t) => t.page === page) || watchTab(s, page)
      makeCurrent(s, tab.id)
    } else {
      ;({ tab } = await tabFor(key, tabId))
    }
    if (url) await act(tab, `open ${url}`, () => tab.page.goto(normalizeUrl(url), { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT }))
    await frame(key, tab)
    return status(key, { tabId: tab.id })
  }

  async function navigate(key, { tabId, url, target: t, readiness = 'load', timeoutMs } = {}) {
    if (Number(url !== undefined) + Number(t !== undefined) !== 1) throw new BrowserError('Provide exactly one of url or target.')
    let href
    if (url !== undefined) href = normalizeUrl(url)
    else if (t?.kind === 'url') href = normalizeUrl(t.url)
    else if (t?.kind === 'environment-port') {
      const port = Number(t.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BrowserError('port must be 1-65535.')
      const path = String(t.path || '')
      href = `${t.protocol === 'https' ? 'https' : 'http'}://localhost:${port}${path && !path.startsWith('/') ? '/' : ''}${path}`
    } else throw new BrowserError("target must be {kind:'url',url} or {kind:'environment-port',port}.")
    const { tab } = await tabFor(key, tabId)
    const waitUntil = readiness === 'none' ? 'commit' : readiness === 'domContentLoaded' ? 'domcontentloaded' : 'load'
    await act(tab, `navigate ${href}`, () => tab.page.goto(href, { waitUntil, timeout: clampTimeout(timeoutMs) }))
    await frame(key, tab)
    return status(key, { tabId: tab.id })
  }

  async function resize(key, { tabId, mode, preset, width, height, orientation } = {}) {
    const { tab } = await tabFor(key, tabId, { create: false })
    let size
    if (mode === 'fill') { size = DEFAULT_VIEWPORT; tab.viewport = { mode: 'fill', ...size } }
    else if (mode === 'freeform') {
      if (!width || !height) throw new BrowserError('Freeform mode requires width and height.')
      if (width * height > 8_294_400) throw new BrowserError('Custom viewport area must not exceed 8294400 pixels.')
      size = { width: Math.round(width), height: Math.round(height) }
      tab.viewport = { mode: 'freeform', ...size }
    } else if (mode === 'preset') {
      const p = VIEWPORT_PRESETS[preset]
      if (!p) throw new BrowserError(`Unknown preset ${preset}. Known: ${Object.keys(VIEWPORT_PRESETS).join(', ')}.`)
      const landscape = orientation === 'landscape'
      size = landscape ? { width: p.height, height: p.width } : { ...p }
      tab.viewport = { mode: 'preset', preset, ...size }
    } else throw new BrowserError("mode must be 'fill', 'freeform' or 'preset'.")
    await tab.page.setViewportSize(size)
    await frame(key, tab)
    return { tabId: tab.id, setting: tab.viewport.mode === 'preset' ? { mode: 'preset', preset } : { mode: tab.viewport.mode }, viewport: size }
  }

  async function setColorScheme(key, { tabId, colorScheme } = {}) {
    if (!['light', 'dark', 'system'].includes(colorScheme)) throw new BrowserError("colorScheme must be 'light', 'dark' or 'system'.")
    const { tab } = await tabFor(key, tabId, { create: false })
    await tab.page.emulateMedia({ colorScheme: colorScheme === 'system' ? null : colorScheme })
    await frame(key, tab)
    return { tabId: tab.id, colorScheme }
  }

  async function snapshot(key, { tabId } = {}) {
    const { tab } = await tabFor(key, tabId, { create: false })
    const page = tab.page
    const [title, aria, dom, png] = await Promise.all([
      page.title().catch(() => ''),
      page.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => ''),
      page.evaluate(collectPageState).catch(() => ({ visibleText: '', elements: [], loading: false })),
      page.screenshot({ type: 'png', timeout: 8000 }),
    ])
    const size = page.viewportSize() || DEFAULT_VIEWPORT
    await frame(key, tab)
    return {
      tabId: tab.id,
      url: page.url(),
      title,
      loading: dom.loading,
      visibleText: dom.visibleText,
      interactiveElements: dom.elements,
      accessibilityTree: aria,
      consoleEntries: tab.console.slice(-30),
      networkEntries: tab.network.filter((n) => n.failed || (n.status || 0) >= 400).slice(-20),
      actionTimeline: tab.actions.slice(-15),
      screenshot: { mimeType: 'image/png', data: png, width: size.width, height: size.height },
    }
  }

  async function click(key, { tabId, locator, selector, x, y, timeoutMs } = {}) {
    const { tab } = await tabFor(key, tabId, { create: false })
    const el = target(tab.page, { locator, selector, x, y })
    await act(tab, `click ${locator || selector || `${x},${y}`}`, () => (el
      ? el.click({ timeout: clampTimeout(timeoutMs) })
      : tab.page.mouse.click(Number(x), Number(y))))
    await settle(tab.page)
    await frame(key, tab)
    return { tabId: tab.id }
  }

  async function type(key, { tabId, text, locator, selector, clear = false, timeoutMs } = {}) {
    if (typeof text !== 'string') throw new BrowserError('text is required.')
    if (locator && selector) throw new BrowserError('Provide at most one of selector or locator.')
    const { tab } = await tabFor(key, tabId, { create: false })
    await act(tab, `type into ${locator || selector || 'focused element'}`, async () => {
      if (locator || selector) {
        const el = target(tab.page, { locator, selector })
        if (clear) await el.fill('', { timeout: clampTimeout(timeoutMs) })
        else await el.focus({ timeout: clampTimeout(timeoutMs) })
        await el.pressSequentially(text, { delay: 8, timeout: clampTimeout(timeoutMs) })
      } else {
        if (clear) await tab.page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').then(() => tab.page.keyboard.press('Backspace'))
        await tab.page.keyboard.insertText(text)
      }
    })
    await frame(key, tab)
    return { tabId: tab.id }
  }

  async function press(key, { tabId, key: k, modifiers = [] } = {}) {
    if (!k) throw new BrowserError('key is required.')
    const { tab } = await tabFor(key, tabId, { create: false })
    const combo = [...modifiers, k].join('+')
    await act(tab, `press ${combo}`, () => tab.page.keyboard.press(combo))
    await settle(tab.page)
    await frame(key, tab)
    return { tabId: tab.id }
  }

  async function scroll(key, { tabId, deltaX = 0, deltaY = 0, locator, selector } = {}) {
    if (!deltaX && !deltaY) throw new BrowserError('Provide deltaX or deltaY.')
    if (locator && selector) throw new BrowserError('Provide at most one of selector or locator.')
    const { tab } = await tabFor(key, tabId, { create: false })
    await act(tab, `scroll ${deltaX},${deltaY}`, async () => {
      if (locator || selector) {
        await target(tab.page, { locator, selector }).evaluate((el, [dx, dy]) => el.scrollBy(dx, dy), [deltaX, deltaY])
      } else {
        await tab.page.mouse.wheel(deltaX, deltaY)
        await tab.page.waitForTimeout(250)
      }
    })
    await frame(key, tab)
    return { tabId: tab.id }
  }

  async function evaluate(key, { tabId, expression } = {}) {
    if (!expression || String(expression).length > 64_000) throw new BrowserError('expression is required (up to 64 KB).')
    const { tab } = await tabFor(key, tabId, { create: false })
    // Indirect eval runs the expression in the page's global scope, like the
    // console; a returned Promise is awaited by Playwright.
    const value = await act(tab, 'evaluate', () => tab.page.evaluate((src) => (0, eval)(src), String(expression)))
    let json
    try { json = JSON.stringify(value ?? null) } catch { json = 'null' }
    if (json && json.length > 64_000) json = JSON.stringify(json.slice(0, 64_000) + '… (truncated)')
    await frame(key, tab)
    return { value: JSON.parse(json ?? 'null') }
  }

  async function waitFor(key, { tabId, locator, selector, text, urlIncludes, timeoutMs } = {}) {
    if (locator && selector) throw new BrowserError('Provide at most one of selector or locator.')
    if (!locator && !selector && !text && !urlIncludes) throw new BrowserError('Provide at least one wait condition.')
    const { tab } = await tabFor(key, tabId, { create: false })
    const t = clampTimeout(timeoutMs)
    await act(tab, 'wait', async () => {
      const waits = []
      if (locator || selector) waits.push(target(tab.page, { locator, selector }).waitFor({ state: 'visible', timeout: t }))
      if (text) waits.push(tab.page.waitForFunction((s) => document.body?.innerText.includes(s), text, { timeout: t }))
      if (urlIncludes) waits.push(tab.page.waitForURL((u) => u.href.includes(urlIncludes), { timeout: t }))
      await Promise.all(waits)
    })
    await frame(key, tab)
    return { tabId: tab.id }
  }

  /** A fresh frame of the current tab, for a viewer whose last one may be stale. */
  async function look(key) {
    const s = sessions.get(key)
    const tab = s?.current && s.tabs.get(s.current)
    if (tab) await frame(key, tab)
    return { tabId: tab?.id || null }
  }

  /**
   * Load one HTML page on its own (no chat's session, cookies or tabs) and take
   * its picture: html_preview (chat/visuals.mjs). The page is served at a fixed
   * fake origin under `csp`, the policy the chat frame serves it with, so what
   * loads here is what loads there, and it may not navigate anywhere: a preview
   * runs with nobody watching. At most two at once; each has RENDER_TIMEOUT_MS
   * from the start of the launch to the picture.
   */
  async function renderPage({ html, csp, width = 728 }) {
    while (rendering >= 2) await new Promise((r) => renderQueue.push(r))
    rendering++
    let context = null
    let timedOut = false
    let timer
    const work = (async () => {
      const b = await browser()
      // The sandbox already rules out service workers; Playwright's own block logs an error the model would chase.
      const ctx = await b.newContext({ viewport: { width, height: 600 }, colorScheme: 'dark', deviceScaleFactor: 1 })
      if (timedOut) { await ctx.close().catch(() => {}); throw new BrowserError('timed out') }
      context = ctx
      const consoleMessages = []
      const note = (level, text) => { if (consoleMessages.length < 20) consoleMessages.push({ level, text: String(text).slice(0, 500) }) }
      const page = await context.newPage()
      // The page is see-through; the picture shows it on the chat's background.
      const cdp = await context.newCDPSession(page).catch(() => null)
      await cdp?.send('Emulation.setDefaultBackgroundColorOverride', { color: RENDER_BACKDROP }).catch(() => {})
      // The shared browser keeps its scrollbars (a site can measure them); a chart's picture never shows them.
      await cdp?.send('Emulation.setScrollbarsHidden', { hidden: true }).catch(() => {})
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || m.type() === 'log') note(m.type(), m.text()) })
      page.on('pageerror', (e) => note('error', e?.message || e))
      page.on('requestfailed', (r) => { if (!r.isNavigationRequest()) note('error', `blocked or failed: ${r.url().slice(0, 200)}`) })
      let refused
      const navigationRefused = new Promise((resolve) => { refused = resolve })
      await context.route('**/*', (route) => {
        const request = route.request()
        const url = request.url()
        if (url === RENDER_URL) return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp }, body: html })
        // Leaving the page (location = …, a popup) is the one request CSP cannot stop.
        // It is answered here, never sent; a 204 keeps the page where an abort would show an error page.
        // Only the page itself leaving ends the wait for its load; a popup it opens does not.
        if (request.isNavigationRequest()) { note('error', `navigation blocked: ${url.slice(0, 200)}`); if (request.frame() === page.mainFrame()) refused(); return route.fulfill({ status: 204, body: '' }) }
        if (url.startsWith('https://')) return route.continue()
        return route.abort('blockedbyclient')
      })
      // Not waitUntil 'load': a page that navigates while loading holds goto open
      // after its refused navigation, so the load gets its own shorter wait.
      await page.goto(RENDER_URL, { waitUntil: 'commit', timeout: RENDER_TIMEOUT_MS })
      // A refused navigation can leave 'load' unfired; the page is as done as it gets.
      await Promise.race([page.waitForLoadState('load', { timeout: RENDER_LOAD_MS }), navigationRefused.then(() => page.waitForTimeout(300))])
        .catch(() => note('warning', `the page had not finished loading after ${RENDER_LOAD_MS / 1000} seconds`))
      await page.evaluate(() => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))).catch(() => {})
      // Chart libraries animate their first draw.
      await page.waitForTimeout(800)
      const measure = () => page.evaluate(() => Math.ceil(document.documentElement.getBoundingClientRect().height))
      const contentHeight = await measure()
      const capturedHeight = Math.max(80, Math.min(RENDER_MAX_HEIGHT, contentHeight))
      await page.setViewportSize({ width, height: capturedHeight })
      await page.waitForTimeout(100)
      const screenshot = await page.screenshot({ type: 'png' })
      return { contentHeight: await measure().catch(() => contentHeight), capturedHeight, consoleMessages, screenshot }
    })()
    // Past the timeout the context closes under it; that failure is not news.
    work.catch(() => {})
    try {
      return await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => { timedOut = true; reject(new BrowserError(`The page did not finish loading in ${Math.round(RENDER_TIMEOUT_MS / 1000)} seconds`)) }, RENDER_TIMEOUT_MS)
      })])
    } finally {
      clearTimeout(timer)
      await context?.close().catch(() => {})
      rendering--
      renderQueue.shift()?.()
      if (!sessions.size) scheduleBrowserIdle()
    }
  }

  /**
   * Load one page read-only, in a context of its own made from `storageState`
   * (a sign-in saved earlier), and run `extract(arg)` in it. Only what
   * readOnlyRequestDecision allows leaves the page: GETs to `hosts`. WebSockets
   * are closed, service workers blocked, popups closed, nothing downloaded. Each
   * `scrolls` scrolls the page two screens to load more. Returns the extract's
   * value, where the page ended up, the context's storage state afterwards (a
   * site may rotate its cookies on any answer) and what was blocked.
   */
  async function readPage({ storageState = null, url, hosts, extract = null, arg = null, scrolls = 0, timeoutMs = 30_000 } = {}) {
    if (!Array.isArray(hosts) || !hosts.length) throw new BrowserError('readPage needs the hosts it may load from.')
    const href = normalizeUrl(url)
    if (readOnlyRequestDecision({ method: 'GET', url: href, resourceType: 'document' }, hosts) !== 'continue') throw new BrowserError(`readPage may not open ${href.slice(0, 200)}.`)
    reading++
    let context = null
    try {
      const b = await browser()
      context = await b.newContext(contextOptions({
        storageState: storageState || undefined,
        serviceWorkers: 'block',
        acceptDownloads: false,
      }))
      const blocked = []
      await context.route('**/*', (route) => {
        const r = route.request()
        if (readOnlyRequestDecision({ method: r.method(), url: r.url(), resourceType: r.resourceType() }, hosts) === 'continue') return route.continue()
        if (blocked.length < 40 && !['image', 'media', 'font'].includes(r.resourceType())) blocked.push(`${r.method()} ${r.url().slice(0, 160)}`)
        return route.abort('blockedbyclient')
      })
      // A socket can send anything; this one is never connected to its server.
      if (typeof context.routeWebSocket === 'function') await context.routeWebSocket(/.*/, (ws) => { ws.close() })
      // Only the page opened here; anything the site opens itself is closed.
      let page = null
      context.on('page', (p) => { if (page && p !== page) p.close().catch(() => {}) })
      page = await context.newPage()
      const response = await page.goto(href, { waitUntil: 'domcontentloaded', timeout: Math.min(60_000, Math.max(1000, Number(timeoutMs) || 30_000)) })
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
      for (let i = 0; i < Math.min(8, Math.max(0, Number(scrolls) || 0)); i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2)).catch(() => {})
        await page.waitForTimeout(900)
      }
      const data = extract ? await page.evaluate(extract, arg) : null
      return {
        url: page.url(),
        status: response?.status() ?? null,
        title: await page.title().catch(() => ''),
        data,
        storageState: await context.storageState(),
        blocked,
      }
    } catch (e) {
      throw e instanceof BrowserError ? e : new BrowserError(cleanPlaywrightError(e))
    } finally {
      await context?.close().catch(() => {})
      reading--
      if (!sessions.size) scheduleBrowserIdle()
    }
  }

  /** A chat's cookies and storage, or null when it has no browser open. */
  async function storageState(key) {
    const s = sessions.get(key)
    if (!s) return null
    touch(s, key)
    return s.context.storageState()
  }

  async function closeAll() {
    for (const key of [...sessions.keys()]) await closeSession(key)
    if (browserIdle) { clearTimeout(browserIdle); browserIdle = null }
    const b = await browserPromise?.catch(() => null)
    browserPromise = null
    await b?.close().catch(() => {})
  }

  return {
    available: () => !!executablePath,
    executablePath,
    status, open, navigate, resize, setColorScheme, snapshot, click, type, press, scroll, evaluate, waitFor, look,
    watch, latestFrame, input, release,
    renderPage, readPage, storageState, closeSession, closeAll,
    sessionKeys: () => [...sessions.keys()],
  }
}

/** The browser's user agent as an ordinary Chrome's, or undefined if it cannot say. */
async function ownUserAgent(b) {
  try {
    const cdp = await b.newBrowserCDPSession()
    const { userAgent } = await cdp.send('Browser.getVersion')
    await cdp.detach().catch(() => {})
    return plainUserAgent(userAgent) || undefined
  } catch { return undefined }
}

/** A click that starts a navigation settles before the next look. */
async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(150)
}

function cleanPlaywrightError(e) {
  const msg = String(e?.message || e)
  // Playwright's messages lead with the useful line and follow with a call log.
  const first = msg.split('\n=========================== logs')[0].split('\nCall log:')[0].trim()
  return first.replace(/^(locator|page|mouse|keyboard)\.\w+:\s*/i, '').slice(0, 1200)
}

// Runs in the page. Visible text (capped) and the interactive elements a model
// can act on, each with a Playwright role locator it can pass straight back.
function collectPageState() {
  const CAP = 20000
  const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n')
  const visibleText = text.length > CAP ? `${text.slice(0, CAP)}\n… (${text.length - CAP} more characters; use preview_evaluate to read more)` : text
  const roleOf = (el) => {
    const r = el.getAttribute('role')
    if (r) return r
    const tag = el.tagName.toLowerCase()
    if (tag === 'a' && el.hasAttribute('href')) return 'link'
    if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset'].includes(el.type))) return 'button'
    if (tag === 'input' && el.type === 'checkbox') return 'checkbox'
    if (tag === 'input' && el.type === 'radio') return 'radio'
    if (tag === 'input' && ['search'].includes(el.type)) return 'searchbox'
    if (tag === 'input' || tag === 'textarea') return 'textbox'
    if (tag === 'select') return 'combobox'
    if (tag === 'summary') return 'button'
    return null
  }
  const nameOf = (el) => {
    const label = el.getAttribute('aria-label') || (el.labels && el.labels[0]?.innerText) || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt')
    const own = (el.innerText || el.value || '').trim()
    return String(label || own || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  }
  const q = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const nodes = document.querySelectorAll('a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=option], [contenteditable=true], [onclick]')
  const elements = []
  for (const el of nodes) {
    if (elements.length >= 150) break
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') continue
    if (r.bottom < 0 || r.top > innerHeight * 3) continue
    const role = roleOf(el)
    const name = nameOf(el)
    const selector = role && name ? `role=${role}[name="${q(name)}"]` : el.id ? `#${CSS.escape(el.id)}` : name ? `text="${q(name.slice(0, 60))}"` : el.tagName.toLowerCase()
    elements.push({ tag: el.tagName.toLowerCase(), role, name, selector, x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) })
  }
  return { visibleText, elements, loading: document.readyState !== 'complete' }
}
