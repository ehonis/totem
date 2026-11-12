// Which Chromium the agent browser runs, and how it introduces itself.
//
// Order: BROWSER_EXECUTABLE, then an installed Google Chrome, then Playwright's
// full Chromium, then a system Chromium, and Playwright's headless shell only
// as a last resort. The shell is the old headless browser: its client hints
// still name "HeadlessChrome", and sites behind Cloudflare's check (LinkedIn's
// sign-in) can hold it on "Just a moment..." for good. A full build runs in
// Chrome's new headless mode, which renders like the real thing.
//
// Installed Chrome is found by path rather than Playwright's `channel: 'chrome'`
// (the same binary), so one `executablePath` serves the chat's pages,
// html_preview's renderPage and the LinkedIn reader's readPage alike.

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CHROME = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
}
const SYSTEM_CHROMIUM = {
  darwin: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
  linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  win32: [],
}
// Inside Playwright's `chromium-<rev>` and `chromium_headless_shell-<rev>` folders.
const FULL_BUILDS = [
  'chrome-linux64/chrome', 'chrome-linux/chrome',
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-win64/chrome.exe', 'chrome-win/chrome.exe',
]
const SHELL_BUILDS = [
  'chrome-headless-shell-linux64/chrome-headless-shell',
  'chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell',
  'chrome-headless-shell-win64/chrome-headless-shell.exe',
]

function playwrightBuilds(cache, folder, rels, readdir) {
  let dirs = []
  try { dirs = readdir(cache) } catch { return [] }
  const re = new RegExp(`^${folder}-(\\d+)$`)
  return dirs.filter((d) => re.test(d))
    .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()))
    .flatMap((d) => rels.map((rel) => join(cache, d, rel)))
}

/**
 * Every place a browser may be, best first, as { kind, path }. `kind` is
 * configured, chrome, chromium (Playwright's full build), system-chromium or
 * headless-shell.
 */
export function browserCandidates({ env = process.env, platform = process.platform, home = homedir(), readdir = readdirSync } = {}) {
  const expand = (p) => (p.startsWith('~/') ? join(home, p.slice(2)) : p)
  const cache = env.PLAYWRIGHT_BROWSERS_PATH || join(home, platform === 'darwin' ? 'Library/Caches/ms-playwright' : platform === 'win32' ? 'AppData/Local/ms-playwright' : '.cache/ms-playwright')
  return [
    ...(env.BROWSER_EXECUTABLE ? [{ kind: 'configured', path: env.BROWSER_EXECUTABLE }] : []),
    ...(CHROME[platform] || []).map((p) => ({ kind: 'chrome', path: expand(p) })),
    ...playwrightBuilds(cache, 'chromium', FULL_BUILDS, readdir).map((path) => ({ kind: 'chromium', path })),
    ...(SYSTEM_CHROMIUM[platform] || []).map((path) => ({ kind: 'system-chromium', path })),
    ...playwrightBuilds(cache, 'chromium_headless_shell', SHELL_BUILDS, readdir).map((path) => ({ kind: 'headless-shell', path })),
  ]
}

/** The best browser this machine has, as { kind, path }, or null. */
export function pickBrowser({ exists = existsSync, ...options } = {}) {
  return browserCandidates(options).find((c) => exists(c.path)) || null
}

/** The path of the best browser this machine has, or ''. */
export function findChromium(options) {
  return pickBrowser(options)?.path || ''
}

/**
 * The browser's own user agent as an ordinary Chrome's: headless mode says
 * "HeadlessChrome", which is the first thing a bot check reads.
 */
export function plainUserAgent(ua) {
  return String(ua || '').replace(/HeadlessChrome\//g, 'Chrome/')
}

/**
 * Launch options for the agent browser. Headless unless `headed` (BROWSER_HEADED,
 * for a host whose bot checks still refuse headless; it needs a display).
 * AutomationControlled off keeps navigator.webdriver false; a 1920×1080 window
 * gives `screen` and the outer window real sizes; --hide-scrollbars, which
 * Playwright adds in headless, is dropped because a page can measure it.
 */
export function launchOptions({ executablePath, headed = false }) {
  return {
    executablePath,
    headless: !headed,
    args: ['--disable-blink-features=AutomationControlled', '--no-default-browser-check', '--window-size=1920,1080', '--lang=en-US', '--accept-lang=en-US,en'],
    ignoreDefaultArgs: ['--hide-scrollbars'],
  }
}
