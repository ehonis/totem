// The live browser: which Chromium runs it, how the owner's input reaches the
// page, and that the stream runs only while someone watches.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { browserCandidates, pickBrowser, plainUserAgent, launchOptions } from './pick.mjs'
import { parseInput, cdpMouse, cdpWheel, modifierBits, coalesce, validKey } from './input.mjs'
import { createBrowserManager, findChromium } from './manager.mjs'

// ---- the browser picker ---------------------------------------------------------

const fakeFs = (files) => ({
  exists: (p) => files.includes(p),
  readdir: (dir) => [...new Set(files.filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1).split('/')[0]))],
})

test('the picker prefers installed Chrome, then full Chromium, then the headless shell', () => {
  const home = '/home/o'
  const cache = `${home}/.cache/ms-playwright`
  const shell = `${cache}/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`
  const full = `${cache}/chromium-1243/chrome-linux64/chrome`
  const older = `${cache}/chromium-1200/chrome-linux64/chrome`
  const chrome = '/opt/google/chrome/chrome'
  const system = '/usr/bin/chromium'
  const pick = (files, env = {}) => pickBrowser({ env, platform: 'linux', home, ...fakeFs(files) })
  assert.deepEqual(pick([shell, full, older, chrome, system]), { kind: 'chrome', path: chrome })
  assert.deepEqual(pick([shell, older, full, system]), { kind: 'chromium', path: full }, 'the newest Playwright build first')
  assert.deepEqual(pick([shell, system]), { kind: 'system-chromium', path: system })
  assert.deepEqual(pick([shell]), { kind: 'headless-shell', path: shell })
  assert.equal(pick([]), null)
  // BROWSER_EXECUTABLE wins when it exists, and is skipped when it does not.
  assert.deepEqual(pick([shell, chrome, '/x/chrome'], { BROWSER_EXECUTABLE: '/x/chrome' }), { kind: 'configured', path: '/x/chrome' })
  assert.deepEqual(pick([shell, chrome], { BROWSER_EXECUTABLE: '/x/chrome' }), { kind: 'chrome', path: chrome })
  // macOS: the Chrome app, then Playwright's Chrome for Testing build.
  const mcache = '/Users/o/Library/Caches/ms-playwright'
  const cft = `${mcache}/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
  const macShell = `${mcache}/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell`
  const app = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const mac = (files) => pickBrowser({ env: {}, platform: 'darwin', home: '/Users/o', ...fakeFs(files) })
  assert.deepEqual(mac([macShell, cft, app]), { kind: 'chrome', path: app })
  assert.deepEqual(mac([macShell, cft]), { kind: 'chromium', path: cft })
  assert.deepEqual(mac([macShell]), { kind: 'headless-shell', path: macShell })
  const kinds = browserCandidates({ env: {}, platform: 'linux', home, readdir: fakeFs([shell, full]).readdir }).map((c) => c.kind)
  assert.ok(kinds.indexOf('chrome') < kinds.indexOf('chromium') && kinds.indexOf('chromium') < kinds.indexOf('headless-shell'))
})

test('the browser introduces itself as an ordinary Chrome', () => {
  assert.equal(plainUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36'),
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36')
  const o = launchOptions({ executablePath: '/c' })
  assert.equal(o.headless, true)
  assert.ok(o.args.includes('--disable-blink-features=AutomationControlled'))
  assert.ok(o.args.includes('--window-size=1920,1080'))
  assert.deepEqual(o.ignoreDefaultArgs, ['--hide-scrollbars'])
  assert.equal(launchOptions({ executablePath: '/c', headed: true }).headless, false)
})

// ---- input mapping --------------------------------------------------------------

const VIEW = { width: 1280, height: 800 }

test('mouse input keeps its button, clicks and modifiers, clamped to the viewport', () => {
  const down = parseInput({ kind: 'mouse', type: 'down', x: 640.5, y: 400, button: 'right', buttons: 2, clickCount: 2, modifiers: ['Shift', 'Control', 'Hyper', 'Shift'] }, VIEW)
  assert.deepEqual(down, { kind: 'mouse', type: 'down', x: 640.5, y: 400, button: 'right', buttons: 2, clickCount: 2, modifiers: ['Shift', 'Control'] })
  assert.deepEqual(cdpMouse(down), { type: 'mousePressed', x: 640.5, y: 400, button: 'right', buttons: 2, clickCount: 2, modifiers: 10, pointerType: 'mouse' })
  // Off the page lands on its edge; a move presses nothing.
  const move = parseInput({ kind: 'mouse', type: 'move', x: 5000, y: -20, buttons: 1 }, VIEW)
  assert.deepEqual([move.x, move.y, move.button, move.clickCount], [1279, 0, 'none', 0])
  assert.equal(cdpMouse(move).type, 'mouseMoved')
  assert.equal(cdpMouse(parseInput({ kind: 'mouse', type: 'up', x: 1, y: 1 }, VIEW)).button, 'left')
  assert.equal(parseInput({ kind: 'mouse', type: 'down', x: 1, y: 1, clickCount: 99 }, VIEW).clickCount, 3)
  assert.equal(modifierBits(['Alt', 'Control', 'Meta', 'Shift']), 15)
  assert.equal(modifierBits(['Meta']), 4)
  for (const bad of [{ kind: 'mouse', type: 'down', x: 'a', y: 1 }, { kind: 'mouse', type: 'hover', x: 1, y: 1 }, { kind: 'mouse', type: 'down', x: NaN, y: 1 }, null, 'click', { kind: 'exec' }]) {
    assert.equal(parseInput(bad, VIEW), null, JSON.stringify(bad))
  }
})

test('the wheel, keys and text are checked before they reach the page', () => {
  const wheel = parseInput({ kind: 'wheel', x: 10, y: 20, deltaY: 120, modifiers: ['Control'] }, VIEW)
  assert.deepEqual(cdpWheel(wheel), { type: 'mouseWheel', x: 10, y: 20, deltaX: 0, deltaY: 120, button: 'none', modifiers: 2, pointerType: 'mouse' })
  assert.equal(parseInput({ kind: 'wheel', x: 1, y: 1, deltaY: 1e9 }, VIEW).deltaY, 10_000)
  assert.equal(parseInput({ kind: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 0 }, VIEW), null)
  assert.deepEqual(parseInput({ kind: 'key', type: 'down', key: 'Enter', modifiers: ['Meta'] }, VIEW), { kind: 'key', type: 'down', key: 'Enter', modifiers: ['Meta'] })
  for (const key of ['a', 'é', 'ArrowLeft', 'F5', 'Shift', '€']) assert.ok(validKey(key), key)
  for (const key of ['', 'enter; rm', '\n', 'a'.repeat(30), 'Control+A']) assert.ok(!validKey(key), key)
  assert.deepEqual(parseInput({ kind: 'text', text: 'hunter22' }, VIEW), { kind: 'text', text: 'hunter22' })
  assert.equal(parseInput({ kind: 'text', text: 'x'.repeat(4001) }, VIEW), null)
  assert.equal(parseInput({ kind: 'text', text: '' }, VIEW), null)
})

test('a burst of moves or wheel turns waiting in line folds into one', () => {
  const m = (x, buttons = 0) => parseInput({ kind: 'mouse', type: 'move', x, y: 1, buttons }, VIEW)
  assert.equal(coalesce(m(1), m(2)).x, 2)
  assert.equal(coalesce(m(1, 1), m(2, 0)), null, 'a move that lets go of a button is its own')
  assert.equal(coalesce(parseInput({ kind: 'mouse', type: 'down', x: 1, y: 1 }, VIEW), m(2)), null)
  const w = (dy) => parseInput({ kind: 'wheel', x: 5, y: 5, deltaY: dy }, VIEW)
  assert.equal(coalesce(w(100), w(50)).deltaY, 150)
  assert.equal(coalesce(w(100), parseInput({ kind: 'wheel', x: 6, y: 5, deltaY: 1 }, VIEW)), null)
})

// ---- the stream's life, against a stand-in for Playwright -------------------------

function fakePlaywright({ failStarts = 0, failKeyDowns = -1 } = {}) {
  const seen = { launches: 0, browserClosed: 0, contextsClosed: 0, starts: [], stops: 0, acks: [], mouse: [], keys: [] }
  const handlers = {}
  const cdp = {
    on: (ev, fn) => { handlers[ev] = fn },
    off: (ev, fn) => { if (handlers[ev] === fn) delete handlers[ev] },
    send: async (method, params) => {
      if (method === 'Page.startScreencast') { seen.starts.push(params); if (failStarts-- > 0) throw new Error('Target detached') }
      if (method === 'Page.stopScreencast') seen.stops++
      if (method === 'Page.screencastFrameAck') seen.acks.push(params.sessionId)
      if (method === 'Input.dispatchMouseEvent') seen.mouse.push(params)
      return {}
    },
  }
  const page = {
    on: () => {}, url: () => 'https://example.com/', title: async () => 'Example',
    viewportSize: () => ({ width: 1280, height: 800 }),
    screenshot: async () => Buffer.from('still'), goto: async () => {}, evaluate: async () => false,
    waitForLoadState: async () => {}, waitForTimeout: async () => {},
    keyboard: { down: async (k) => { if (failKeyDowns-- === 0) throw new Error('Target closed'); seen.keys.push(`down ${k}`) }, up: async (k) => { seen.keys.push(`up ${k}`) }, insertText: async (t) => { seen.keys.push(`text ${t}`) } },
  }
  const context = { on: () => {}, newPage: async () => page, newCDPSession: async () => cdp, close: async () => { seen.contextsClosed++ } }
  const browser = { on: () => {}, newContext: async () => context, close: async () => { seen.browserClosed++ } }
  const frame = (n) => handlers['Page.screencastFrame']?.({ data: Buffer.from(`jpeg-${n}`).toString('base64'), sessionId: n, metadata: { deviceWidth: 1280, deviceHeight: 800 } })
  return { seen, frame, streaming: () => !!handlers['Page.screencastFrame'], loadPlaywright: async () => ({ chromium: { launch: async () => { seen.launches++; return browser } } }) }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('timed out'); await tick(5) } }

test('watching never opens a browser: no chat browser, no viewer', async () => {
  const fake = fakePlaywright()
  const manager = createBrowserManager({ executablePath: '/bin/true', loadPlaywright: fake.loadPlaywright })
  assert.equal(manager.watch('t', { onFrame: () => {} }), null)
  await assert.rejects(manager.input('t', { kind: 'text', text: 'x' }), /No browser tab/)
  assert.equal(fake.seen.launches, 0)
})

test('the stream starts with the first viewer, acks each frame, and stops with the last', async () => {
  const fake = fakePlaywright()
  const manager = createBrowserManager({ executablePath: '/bin/true', loadPlaywright: fake.loadPlaywright })
  try {
    await manager.open('t', { url: 'https://example.com' })
    assert.equal(fake.seen.starts.length, 0, 'nobody watching: no screencast')
    const a = []
    const b = []
    const one = manager.watch('t', { onFrame: (f) => { a.push(f) }, width: 640, dpr: 1 })
    await until(() => fake.streaming() && a.length === 1)
    assert.equal(a[0].jpeg.toString(), 'still', 'a viewer gets the page as it stands at once')
    assert.equal(fake.seen.starts[0].format, 'jpeg')
    assert.equal(fake.seen.starts[0].maxWidth, 640, 'sized to the viewer')
    assert.ok(fake.seen.starts[0].quality < 75, 'shown at half size: a coarser JPEG')
    await fake.frame(1)
    assert.equal(a[1].jpeg.toString(), 'jpeg-1')
    assert.deepEqual([a[1].width, a[1].height, a[1].url], [1280, 800, 'https://example.com/'])
    assert.deepEqual(fake.seen.acks, [1])
    // A second viewer at full size: the stream restarts at the larger size, both get frames.
    const two = manager.watch('t', { onFrame: (f) => { b.push(f) }, width: 1400, dpr: 2 })
    await until(() => fake.seen.starts.length === 2 && b.length === 1)
    assert.equal(fake.seen.starts[1].maxWidth, 1280)
    await fake.frame(2)
    assert.equal(a.at(-1).jpeg.toString(), 'jpeg-2')
    assert.equal(b.at(-1).jpeg.toString(), 'jpeg-2')
    // A viewer that is behind (its socket keeps the newest frame itself) never holds the ack.
    const slow = manager.watch('t', { onFrame: () => new Promise(() => {}) })
    await until(() => fake.seen.starts.length === 3)
    await fake.frame(3)
    assert.ok(fake.seen.acks.includes(3), 'acked without waiting on the slow viewer')
    assert.equal(a.at(-1).jpeg.toString(), 'jpeg-3')
    slow.stop()
    one.stop()
    await tick(10)
    assert.ok(fake.streaming(), 'still one viewer')
    two.stop()
    await until(() => !fake.streaming())
    assert.ok(fake.seen.stops >= 1)
    assert.equal(manager.latestFrame('t').jpeg.toString(), 'jpeg-3', 'the newest frame stays for a late reader')
  } finally {
    await manager.closeAll()
  }
})

test('the idle timers end the stream, close the context, then the browser', async () => {
  const fake = fakePlaywright()
  const manager = createBrowserManager({ executablePath: '/bin/true', loadPlaywright: fake.loadPlaywright, contextIdleMs: 60, browserIdleMs: 40 })
  await manager.open('t', { url: 'https://example.com' })
  const ended = []
  manager.watch('t', { onFrame: () => {}, onEnd: (why) => ended.push(why) })
  await until(() => fake.streaming())
  // Watching alone does not keep it alive: the context closes on its timer, the viewer is told.
  await until(() => manager.sessionKeys().length === 0, 1000)
  assert.deepEqual(ended, ['closed'])
  assert.ok(!fake.streaming())
  assert.equal(fake.seen.contextsClosed, 1)
  await until(() => fake.seen.browserClosed === 1, 1000)
})

test('owner input reaches the page in order, as CDP mouse events and keyboard keys', async () => {
  const fake = fakePlaywright()
  const manager = createBrowserManager({ executablePath: '/bin/true', loadPlaywright: fake.loadPlaywright })
  try {
    await manager.open('t', { url: 'https://example.com' })
    await Promise.all([
      manager.input('t', { kind: 'mouse', type: 'down', x: 10, y: 20, button: 'left', buttons: 1, modifiers: ['Shift'] }),
      manager.input('t', { kind: 'mouse', type: 'move', x: 30, y: 20, buttons: 1 }),
      manager.input('t', { kind: 'mouse', type: 'move', x: 40, y: 20, buttons: 1 }),
      manager.input('t', { kind: 'mouse', type: 'up', x: 40, y: 20, button: 'left' }),
      manager.input('t', { kind: 'key', type: 'down', key: 'a', modifiers: ['Control'] }),
      manager.input('t', { kind: 'key', type: 'up', key: 'a', modifiers: [] }),
      manager.input('t', { kind: 'text', text: 'pässword' }),
    ])
    assert.equal(fake.seen.mouse[0].type, 'mousePressed')
    assert.equal(fake.seen.mouse[0].modifiers, 8)
    assert.ok(fake.seen.mouse.some((m) => m.type === 'mouseMoved' && m.x === 40))
    assert.equal(fake.seen.mouse.at(-1).type, 'mouseReleased')
    // Control, listed on the key-down, goes down first; the key-up that no longer lists it lets go.
    assert.deepEqual(fake.seen.keys, ['down Control', 'down a', 'up Control', 'up a', 'text pässword'])
    await assert.rejects(manager.input('t', { kind: 'mouse', type: 'down', x: 'x', y: 1 }), /not an input/)
  } finally {
    await manager.closeAll()
  }
})

test('a key-repeat that fails leaves the good press before it held', async () => {
  // The second down of Enter (a repeat) fails; the owner still holds Enter, so its up goes out.
  const fake = fakePlaywright({ failKeyDowns: 1 })
  const manager = createBrowserManager({ executablePath: '/bin/true', loadPlaywright: fake.loadPlaywright })
  try {
    await manager.open('t', { url: 'https://example.com' })
    await manager.input('t', { kind: 'key', type: 'down', key: 'Enter', modifiers: [] }, 'p')
    await assert.rejects(manager.input('t', { kind: 'key', type: 'down', key: 'Enter', modifiers: [] }, 'p'), /Target closed/)
    await manager.input('t', { kind: 'key', type: 'up', key: 'Enter', modifiers: [] }, 'p')
    assert.deepEqual(fake.seen.keys, ['down Enter', 'up Enter'])
  } finally {
    await manager.closeAll()
  }
})

test('a screencast that fails to start is tried again on the next change', async () => {
  const fake = fakePlaywright({ failStarts: 1 })
  const manager = createBrowserManager({ executablePath: '/bin/true', loadPlaywright: fake.loadPlaywright })
  try {
    await manager.open('t', { url: 'https://example.com' })
    const one = manager.watch('t', { onFrame: () => {} })
    await until(() => fake.seen.starts.length === 1)
    await tick(20)
    assert.ok(!fake.streaming(), 'the failed start left no handler behind')
    // The next sync (another viewer, a new tab, an action's frame) starts it.
    manager.watch('t', { onFrame: () => {} })
    await until(() => fake.seen.starts.length === 2 && fake.streaming())
    one.stop()
  } finally {
    await manager.closeAll()
  }
})

// ---- the real thing, where this machine has a Chromium ---------------------------

const SPINNER = `<!doctype html><title>Spinner</title>
<style>#s{width:80px;height:80px;background:#36c;animation:spin .4s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style>
<div id="s"></div><input id="name" style="position:absolute;left:100px;top:200px;width:300px;height:30px">
<div id="drag" style="position:absolute;left:100px;top:300px;width:60px;height:60px;background:#c63"></div>
<div style="height:4000px"></div><p id="log"></p>
<script>
const log = (s) => { document.getElementById('log').textContent += s + ';' }
const d = document.getElementById('drag'); let from = null
d.addEventListener('mousedown', (e) => { from = e.clientX })
addEventListener('mouseup', (e) => { if (from !== null) log('dragged ' + (e.clientX - from)); from = null })
addEventListener('keydown', (e) => { if (e.key === 'Enter') log('enter ' + (e.shiftKey ? 'shift' : 'plain')) })
</script>`

test('a real page streams while it animates, takes a drag, the wheel, keys and a paste, and leaves no Chromium behind', { skip: !findChromium() && 'no Chromium on this machine' }, async () => {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(SPINNER) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  let launched = null
  const manager = createBrowserManager({ loadPlaywright: async () => {
    const pw = await import('playwright-core')
    return { chromium: { launch: async (o) => { launched = await pw.chromium.launch(o); return launched } } }
  } })
  try {
    await manager.open('t', { url: `http://127.0.0.1:${server.address().port}/` })
    const frames = []
    const viewer = manager.watch('t', { onFrame: (f) => { frames.push(f) }, width: 1280 })
    // Nobody touches it: the spinner alone keeps frames coming.
    await tick(1500)
    assert.ok(frames.length >= 6, `only ${frames.length} frames in 1.5 s`)
    assert.ok(frames.every((f) => f.jpeg[0] === 0xff && f.jpeg[1] === 0xd8), 'JPEGs')
    assert.deepEqual([frames.at(-1).width, frames.at(-1).height], [1280, 800])
    const ua = await (await launched.contexts()[0].pages()[0]).evaluate(() => [navigator.userAgent, navigator.webdriver, screen.width])
    assert.doesNotMatch(ua[0], /Headless/)
    assert.equal(ua[1], false)
    assert.equal(ua[2], 1920)
    const page = launched.contexts()[0].pages()[0]
    await manager.input('t', { kind: 'mouse', type: 'down', x: 130, y: 330, button: 'left', buttons: 1 })
    for (const x of [140, 160, 180]) manager.input('t', { kind: 'mouse', type: 'move', x, y: 330, buttons: 1 })
    await manager.input('t', { kind: 'mouse', type: 'up', x: 180, y: 330, button: 'left' })
    await manager.input('t', { kind: 'mouse', type: 'down', x: 200, y: 215, button: 'left', buttons: 1 })
    await manager.input('t', { kind: 'mouse', type: 'up', x: 200, y: 215, button: 'left' })
    await manager.input('t', { kind: 'text', text: 'Ünïcode paste' })
    await manager.input('t', { kind: 'key', type: 'down', key: 'Enter', modifiers: ['Shift'] })
    await manager.input('t', { kind: 'key', type: 'up', key: 'Enter', modifiers: [] })
    await manager.input('t', { kind: 'wheel', x: 400, y: 400, deltaY: 600 })
    await page.waitForFunction(() => scrollY > 0, null, { timeout: 3000 })
    assert.equal(await page.inputValue('#name'), 'Ünïcode paste')
    assert.match(await page.textContent('#log'), /dragged 50;enter shift;/)
    viewer.stop()
    await tick(300)
    const after = frames.length
    await tick(600)
    assert.equal(frames.length, after, 'no frames once nobody watches')
  } finally {
    await manager.closeAll()
    server.close()
  }
  assert.equal(launched.isConnected(), false, 'Chromium is closed')
})

test('a chart picture never shows scrollbars, though the shared browser keeps them', { skip: !findChromium() && 'no Chromium on this machine' }, async () => {
  const manager = createBrowserManager({})
  let png
  try {
    // 900 px wide in a 728 px page: a horizontal scrollbar, were it drawn, sits along the bottom.
    const out = await manager.renderPage({ html: '<!doctype html><body style="margin:0;background:rgb(0,0,255)"><div style="width:900px;height:120px;background:rgb(255,0,0)"></div>', csp: "default-src 'none'; style-src 'unsafe-inline'", width: 728 })
    png = out.screenshot
  } finally {
    await manager.closeAll()
  }
  // Read the picture's bottom-right pixels back in a page.
  const pw = await import('playwright-core')
  const b = await pw.chromium.launch({ executablePath: findChromium() })
  try {
    const page = await b.newPage()
    const px = await page.evaluate(async (src) => {
      const img = new Image(); img.src = src; await img.decode()
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      const g = c.getContext('2d'); g.drawImage(img, 0, 0)
      return { w: img.width, h: img.height, corner: [...g.getImageData(img.width - 4, img.height - 4, 1, 1).data], right: [...g.getImageData(img.width - 4, 40, 1, 1).data] }
    }, `data:image/png;base64,${png.toString('base64')}`)
    assert.equal(px.w, 728)
    assert.deepEqual(px.right.slice(0, 3), [255, 0, 0], 'no vertical bar on the right edge')
    assert.deepEqual(px.corner.slice(0, 3), [255, 0, 0], 'no horizontal bar along the bottom')
  } finally { await b.close() }
})

const TABS = `<!doctype html><meta charset="utf-8"><title>Tabs</title>
<button id="pop" style="position:absolute;left:10px;top:10px;width:100px;height:40px" onclick="window.open(location.href + '?b')">open</button>
<script>
window.events = []
for (const t of ['keydown', 'keyup']) addEventListener(t, (e) => events.push(t + ' ' + e.key + (e.ctrlKey ? ' ctrl' : '') + (e.shiftKey ? ' shift' : '')))
for (const t of ['mousedown', 'mouseup']) addEventListener(t, (e) => events.push(t + ' ' + e.button))
</script>`

async function realTabs(fn, first = null) {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(TABS) })
  // Every interface, so localhost and 127.0.0.1 are two sites (two renderers) for one server.
  await new Promise((r) => server.listen(0, r))
  let launched = null
  const manager = createBrowserManager({ loadPlaywright: async () => {
    const pw = await import('playwright-core')
    return { chromium: { launch: async (o) => { launched = await pw.chromium.launch(o); return launched } } }
  } })
  try {
    const url = `http://127.0.0.1:${server.address().port}/`
    await manager.open('t', { url: first ? url.replace('127.0.0.1', first) : url })
    const pages = () => launched.contexts()[0].pages()
    const events = (page) => page.evaluate(() => window.events.splice(0))
    await fn({ manager, pages, events, url, port: server.address().port })
  } finally {
    await manager.closeAll()
    server.close()
  }
}

test('a modifier held when a new tab opens is let go on its own tab, and never sticks', { skip: !findChromium() && 'no Chromium on this machine' }, async () => {
  await realTabs(async ({ manager, pages, events }) => {
    const a = (await manager.status('t')).tabId
    await manager.input('t', { kind: 'key', type: 'down', key: 'Control', modifiers: ['Control'] })
    await manager.input('t', { kind: 'mouse', type: 'down', x: 50, y: 30, button: 'left', buttons: 1, modifiers: ['Control'] })
    await manager.input('t', { kind: 'mouse', type: 'up', x: 50, y: 30, button: 'left', modifiers: ['Control'] })
    await until(() => pages().length === 2, 5000)
    await until(async () => (await manager.status('t')).tabId !== a)
    // The owner lets go of Control now: that release is for tab A, where it already happened.
    await manager.input('t', { kind: 'key', type: 'up', key: 'Control', modifiers: [] })
    const [pa, pb] = pages()
    assert.deepEqual(await events(pb), [], 'the new tab got no stray release')
    // Back on A (the agent switches to it), a key arrives with no Control held.
    await manager.press('t', { tabId: a, key: 'h' })
    const log = await events(pa)
    assert.ok(log.includes('keyup Control'), log.join(', '))
    assert.ok(log.includes('keydown h'), log.join(', '))
    assert.ok(!log.some((e) => e.startsWith('keydown h') && e.includes('ctrl')), log.join(', '))
  })
})

test('what a closing socket pressed is let go on the tab that had it, and only that', { skip: !findChromium() && 'no Chromium on this machine' }, async () => {
  await realTabs(async ({ manager, pages, events, url }) => {
    const a = (await manager.status('t')).tabId
    // Shift and the button down on A; then the agent opens tab B.
    await manager.input('t', { kind: 'key', type: 'down', key: 'Shift', modifiers: ['Shift'] }, 'sock-a')
    await manager.input('t', { kind: 'mouse', type: 'down', x: 300, y: 300, button: 'left', buttons: 1, modifiers: ['Shift'] }, 'sock-a')
    await manager.open('t', { url: `${url}?b`, reuseExistingTab: false })
    // The socket closes and lets go of what it pressed.
    await manager.release('t', 'sock-a')
    const [pa, pb] = pages()
    const onA = await events(pa)
    assert.ok(onA.includes('mouseup 0') && onA.includes('keyup Shift'), onA.join(', '))
    assert.deepEqual(await events(pb), [], 'B got none of it')
    await manager.press('t', { tabId: a, key: 'a' })
    assert.deepEqual(await events(pa), ['keydown a', 'keyup a'], 'A has no Shift left down')
  })
})

test('one socket letting go of its key leaves the modifier another holds', { skip: !findChromium() && 'no Chromium on this machine' }, async () => {
  await realTabs(async ({ manager, pages, events }) => {
    // Socket A holds Shift; socket B holds `a` (Shift listed), then closes.
    await manager.input('t', { kind: 'key', type: 'down', key: 'Shift', modifiers: ['Shift'] }, 'sock-a')
    await manager.input('t', { kind: 'key', type: 'down', key: 'a', modifiers: ['Shift'] }, 'sock-b')
    await manager.release('t', 'sock-b')
    await manager.press('t', { key: 'b' })
    const log = await events(pages()[0])
    assert.ok(log.includes('keyup a shift'), log.join(', '))
    assert.ok(log.includes('keydown b shift'), `Shift is still down: ${log.join(', ')}`)
  })
})

const shifted = (log, key) => log.some((e) => e.startsWith(`keydown ${key}`) && e.includes('shift'))

test('a key-down in flight when the tab switches is let go on its tab', { skip: !findChromium() && 'no Chromium on this machine' }, async () => {
  await realTabs(async ({ manager, pages, events, url }) => {
    const a = (await manager.status('t')).tabId
    await manager.open('t', { url: `${url}?b`, reuseExistingTab: false })
    const b = (await manager.status('t')).tabId
    await manager.press('t', { tabId: a, key: 'x' })
    await events(pages()[0])
    // Control goes down on A and, while it is on its way, the agent moves to B.
    const down = manager.input('t', { kind: 'key', type: 'down', key: 'Control', modifiers: ['Control'] }, 'sock')
    const agent = manager.press('t', { tabId: b, key: 'y' })
    await Promise.all([down, agent])
    await manager.input('t', { kind: 'key', type: 'up', key: 'Control', modifiers: [] }, 'sock')
    await manager.press('t', { tabId: a, key: 'h' })
    const log = await events(pages()[0])
    assert.ok(log.includes('keyup Control'), log.join(', '))
    assert.ok(log.includes('keydown h'), `h arrives with no Control: ${log.join(', ')}`)
  })
})

test('a socket closing never lets go of what another socket holds on another tab', { skip: !findChromium() && 'no Chromium on this machine' }, async () => {
  await realTabs(async ({ manager, pages, events, url }) => {
    await manager.input('t', { kind: 'key', type: 'down', key: 'Shift', modifiers: ['Shift'] }, 'sock-a')
    await manager.open('t', { url: `${url}?b`, reuseExistingTab: false })
    await manager.input('t', { kind: 'key', type: 'down', key: 'Shift', modifiers: ['Shift'] }, 'sock-b')
    await manager.release('t', 'sock-a')
    await manager.press('t', { key: 'b' })
    const log = await events(pages()[1])
    assert.ok(shifted(log, 'b'), `B's Shift is still down: ${log.join(', ')}`)
  })
})

test('two sockets holding Shift on one tab: it goes up when the last lets go', { skip: !findChromium() && 'no Chromium on this machine' }, async () => {
  await realTabs(async ({ manager, pages, events }) => {
    for (const owner of ['sock-a', 'sock-b']) await manager.input('t', { kind: 'key', type: 'down', key: 'Shift', modifiers: ['Shift'] }, owner)
    await manager.release('t', 'sock-a')
    await manager.press('t', { key: 'b' })
    assert.ok(shifted(await events(pages()[0]), 'b'), 'still held by the other socket')
    await manager.release('t', 'sock-b')
    await manager.press('t', { key: 'c' })
    const log = await events(pages()[0])
    assert.ok(log.includes('keyup Shift'), log.join(', '))
    assert.ok(log.includes('keydown c'), `released: ${log.join(', ')}`)
  })
})

test('a modifier pressed because a key listed it is let go with its socket', { skip: !findChromium() && 'no Chromium on this machine' }, async () => {
  await realTabs(async ({ manager, pages, events }) => {
    // The owner held Shift before the panel had focus, then typed Shift+A.
    await manager.input('t', { kind: 'key', type: 'down', key: 'A', modifiers: ['Shift'] }, 'sock')
    await manager.input('t', { kind: 'key', type: 'up', key: 'A', modifiers: ['Shift'] }, 'sock')
    await manager.release('t', 'sock')
    await manager.press('t', { key: 'b' })
    const log = await events(pages()[0])
    assert.ok(shifted(log, 'A'), log.join(', '))
    assert.ok(log.includes('keydown b'), `the agent's next key has no Shift: ${log.join(', ')}`)
    // The same through the key-up that no longer lists it.
    await manager.input('t', { kind: 'key', type: 'down', key: 'A', modifiers: ['Shift'] }, 'sock2')
    await manager.input('t', { kind: 'key', type: 'up', key: 'a', modifiers: [] }, 'sock2')
    await manager.press('t', { key: 'c' })
    assert.ok((await events(pages()[0])).includes('keydown c'))
  })
})

test('a release to a busy tab does not hold up input to the current one', { skip: !findChromium() && 'no Chromium on this machine' }, async () => {

  await realTabs(async ({ manager, pages, events }) => {
    // Three things held: the release job as a whole waits about a second, not one each.
    await manager.input('t', { kind: 'key', type: 'down', key: 'Shift', modifiers: ['Shift'] }, 'sock')
    await manager.input('t', { kind: 'key', type: 'down', key: 'Control', modifiers: ['Shift', 'Control'] }, 'sock')
    await manager.input('t', { kind: 'mouse', type: 'down', x: 300, y: 300, button: 'left', buttons: 1 }, 'sock')
    // Tab A (localhost) stops answering for 5 s; tab B (127.0.0.1) is its own renderer.
    await pages()[0].evaluate(() => { setTimeout(() => { const end = Date.now() + 5000; while (Date.now() < end); }, 0) })
    await tick(100)
    await manager.open('t', { url: `http://127.0.0.1:${pages()[0].url().split(':')[2].split('/')[0]}/?b`, reuseExistingTab: false })
    const started = Date.now()
    await manager.input('t', { kind: 'key', type: 'down', key: 'q', modifiers: [] }, 'sock')
    const waited = Date.now() - started
    assert.ok(waited < 1900, `input to the current tab waited ${waited} ms`)
    assert.ok((await events(pages()[1])).includes('keydown q'))
  }, 'localhost')
})

test('a press by POST is let go by the same panel’s socket, by its up or its release', { skip: !findChromium() && 'no Chromium on this machine' }, async () => {
  await realTabs(async ({ manager, pages, events }) => {
    const panel = 'panel0123456789abcdef'
    const click = async (via) => {
      await manager.input('t', { kind: 'mouse', type: 'down', x: 300, y: 300, button: 'left', buttons: 1 }, via.down)
      if (via.up) await manager.input('t', { kind: 'mouse', type: 'up', x: 300, y: 300, button: 'left' }, via.up)
      else await manager.release('t', via.release)
    }
    // POST down (the socket still connecting), then the socket's up: one panel, one owner.
    await click({ down: panel, up: panel })
    // POST down, then the socket closes.
    await click({ down: panel, release: panel })
    // And a later click on the tab still works.
    await click({ down: panel, up: panel })
    assert.deepEqual(await events(pages()[0]), ['mousedown 0', 'mouseup 0', 'mousedown 0', 'mouseup 0', 'mousedown 0', 'mouseup 0'])
  })
})
