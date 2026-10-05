// The agents' browser: T3 Code's collaborative-browser operations, run by
// Playwright on a headless Chromium on this box.
//
// One Chromium process, launched on first use and closed after BROWSER_IDLE_MS
// of nobody browsing. Each chat gets its own BrowserContext (cookies, storage,
// tabs) so two chats never see each other's logins, and the context outlives a
// turn: "now click the second result" on the next message finds the same page.
// A context idle for CONTEXT_IDLE_MS is closed.
//
// Every operation returns plain data; tools.mjs shapes it for MCP. After any
// action that can change the page, `onFrame` gets a small JPEG of the viewport
// so the chat can show the user what the agent is looking at, live.

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const CONTEXT_IDLE_MS = 30 * 60_000
const BROWSER_IDLE_MS = 10 * 60_000
const DEFAULT_TIMEOUT = 15_000
const MAX_TIMEOUT = 60_000
const TEXT_CAP = 20_000
const LOG_CAP = 200
const DEFAULT_VIEWPORT = { width: 1280, height: 800 }

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

/** Playwright's headless shell or Chrome, whichever this machine has. */
export function findChromium() {
  if (process.env.BROWSER_EXECUTABLE && existsSync(process.env.BROWSER_EXECUTABLE)) return process.env.BROWSER_EXECUTABLE
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright')
  try {
    const dirs = readdirSync(cache).filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const d of dirs) {
      for (const rel of [
        'chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/chrome', 'chrome-linux64/chrome',
        'chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      ]) {
        const p = join(cache, d, rel)
        if (existsSync(p)) return p
      }
    }
  } catch {}
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (existsSync(p)) return p
  }
  return ''
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

export function createBrowserManager({ log = () => {}, onFrame = () => {}, executablePath = findChromium(), loadPlaywright = () => import('playwright-core') } = {}) {
  let browserPromise = null
  let browserIdle = null
  const sessions = new Map() // threadId → { context, tabs: Map<tabId, tab>, current, lastUsed, timer, scheme }

  async function browser() {
    if (browserIdle) { clearTimeout(browserIdle); browserIdle = null }
    if (!browserPromise) {
      if (!executablePath) throw new BrowserError('No Chromium on this machine. Run `npx playwright install chromium-headless-shell`.')
      browserPromise = loadPlaywright().then(({ chromium }) => chromium.launch({
        executablePath,
        args: ['--disable-blink-features=AutomationControlled', '--no-default-browser-check'],
      })).then((b) => {
        b.on('disconnected', () => { browserPromise = null; sessions.clear() })
        log(`browser: started ${executablePath}`)
        return b
      })
      browserPromise.catch(() => { browserPromise = null })
    }
    return browserPromise
  }

  function scheduleBrowserIdle() {
    if (browserIdle) clearTimeout(browserIdle)
    browserIdle = setTimeout(async () => {
      if (sessions.size || !browserPromise) return
      const b = await browserPromise.catch(() => null)
      browserPromise = null
      await b?.close().catch(() => {})
      log('browser: closed after idle')
    }, BROWSER_IDLE_MS)
    browserIdle.unref?.()
  }

  function touch(s, key) {
    s.lastUsed = Date.now()
    if (s.timer) clearTimeout(s.timer)
    s.timer = setTimeout(() => closeSession(key), CONTEXT_IDLE_MS)
    s.timer.unref?.()
  }

  async function closeSession(key) {
    const s = sessions.get(key)
    if (!s) return
    sessions.delete(key)
    if (s.timer) clearTimeout(s.timer)
    await s.context.close().catch(() => {})
    if (!sessions.size) scheduleBrowserIdle()
  }

  function watchTab(s, page) {
    const tab = { id: `tab-${randomUUID().slice(0, 8)}`, page, console: [], network: [], actions: [], viewport: { mode: 'fill', ...DEFAULT_VIEWPORT } }
    page.on('console', (m) => push(tab.console, { level: m.type(), text: m.text().slice(0, 2000), timestamp: now(), source: m.location()?.url || undefined }))
    page.on('pageerror', (e) => push(tab.console, { level: 'error', text: String(e?.message || e).slice(0, 2000), timestamp: now(), source: 'pageerror' }))
    page.on('requestfinished', async (r) => {
      const res = await r.response().catch(() => null)
      push(tab.network, { url: r.url().slice(0, 500), method: r.method(), status: res?.status() ?? null, failed: false, timestamp: now() })
    })
    page.on('requestfailed', (r) => push(tab.network, { url: r.url().slice(0, 500), method: r.method(), status: null, failed: true, errorText: r.failure()?.errorText, timestamp: now() }))
    page.on('close', () => {
      s.tabs.delete(tab.id)
      if (s.current === tab.id) s.current = s.tabs.keys().next().value || null
    })
    s.tabs.set(tab.id, tab)
    return tab
  }

  async function session(key, { create = true } = {}) {
    let s = sessions.get(key)
    if (!s && create) {
      const b = await browser()
      const context = await b.newContext({
        viewport: DEFAULT_VIEWPORT,
        userAgent: undefined,
        locale: 'en-US',
        timezoneId: process.env.MORNING_BRIEFING_TZ || undefined,
      })
      s = { context, tabs: new Map(), current: null, lastUsed: Date.now(), timer: null, scheme: 'system' }
      // A page the site opens itself (target=_blank) becomes a tab and the current one.
      context.on('page', (page) => { if (![...s.tabs.values()].some((t) => t.page === page)) s.current = watchTab(s, page).id })
      sessions.set(key, s)
    }
    if (s) touch(s, key)
    return s
  }

  async function tabFor(key, tabId, { create = true } = {}) {
    const s = await session(key, { create })
    if (!s) throw new BrowserError('No browser tab is open in this chat. Call preview_open first.')
    if (tabId) {
      const tab = s.tabs.get(tabId)
      if (!tab) throw new BrowserError(`No tab ${tabId}. Open tabs: ${[...s.tabs.keys()].join(', ') || 'none'}.`)
      s.current = tab.id
      return { s, tab }
    }
    let tab = s.current && s.tabs.get(s.current)
    if (!tab) {
      if (!create) throw new BrowserError('No browser tab is open in this chat. Call preview_open first.')
      const page = await s.context.newPage()
      tab = [...s.tabs.values()].find((t) => t.page === page) || watchTab(s, page)
      s.current = tab.id
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
      s.current = tab.id
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
    status, open, navigate, resize, setColorScheme, snapshot, click, type, press, scroll, evaluate, waitFor,
    closeSession, closeAll,
    sessionKeys: () => [...sessions.keys()],
  }
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
