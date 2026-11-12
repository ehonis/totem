import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { findChromium } from '../browser/manager.mjs'

const executablePath = findChromium()
test('desktop pages fill the shell without reserving an empty right panel', { skip: !executablePath }, async () => {
  const browser = await chromium.launch({ executablePath })
  try {
    const page = await browser.newPage()
    const css = await Promise.all(['styles.css', 'shell.css', 'chat/chat.css', 'cliproxy/cliproxy.css'].map((p) => readFile(new URL(`../web/src/${p}`, import.meta.url), 'utf8')))
    await page.setContent(`<style>${css.join('\n')}</style><div class="app shell panel-open">
      <nav class="sh-rail">Totem</nav><aside class="sh-panel">Chats</aside>
      <main class="main"><section class="view cp-view"><header class="cp-head"><h1>CLIProxy</h1></header><div style="height:1800px">Fictional quota history</div></section></main>
      <aside class="term-panel">Terminal</aside>
    </div>`)
    await page.evaluate(() => document.querySelector('.app').style.setProperty('--term-w', '360px'))
    for (const width of [2000, 2560, 1366, 721, 390]) {
      await page.setViewportSize({ width, height: 900 })
      for (const panel of [true, false]) {
        for (const terminal of [false, true]) {
          await page.evaluate((open) => {
            document.querySelector('.app').classList.toggle('term-open', open)
            document.querySelector('.term-panel').style.display = open ? '' : 'none'
          }, terminal)
          await page.evaluate((open) => {
            document.querySelector('.sh-panel').style.display = open ? '' : 'none'
            document.querySelector('.app').classList.toggle('panel-open', open)
            if (innerWidth <= 720) document.querySelector('.sh-rail').style.display = 'none'
            else document.querySelector('.sh-rail').style.display = ''
            if (innerWidth <= 720) document.querySelector('.sh-panel').style.display = 'none'
          }, panel)
          const boxes = await page.evaluate(() => {
            const box = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right } }
            return { main: box('.main'), view: box('.view'), term: box('.term-panel'), overflow: document.documentElement.scrollWidth > innerWidth }
          })
          assert.equal(boxes.overflow, false, `${width}px, panel ${panel}: document overflow`)
          // The terminal is a grid track holding up to --term-w; the page ends where it starts.
          const right = terminal && width > 720 ? boxes.term.left : width
          if (terminal && width >= 1366) assert.ok(Math.abs(boxes.term.right - boxes.term.left - 360) < 1, `${width}px: terminal keeps its width`)
          assert.ok(Math.abs(boxes.main.right - right) < 1, `${width}px, terminal ${terminal}: main reaches available edge (${boxes.main.right}, expected ${right})`)
          if (boxes.main.right - boxes.main.left >= 52) assert.ok(Math.abs(boxes.view.right - boxes.main.right) < 1, `${width}px: page scrollbar must reach main edge (view ${boxes.view.right}, main ${boxes.main.right})`)
        }
      }
    }
  } finally { await browser.close() }
})


// The chat header beside a side panel. A side panel can leave the chat column any
// width (down to about 180px with three panels open), and what the header holds
// varies, so chat/headerFold.ts measures it and folds things into "…" until it
// fits. This draws the real ChatHeader (web/src/chat/ChatHeader.harness.tsx,
// bundled here) in each of its shapes, with the real CSS and the real usage
// pills (fed one provider or three), and sweeps the column from 1400px to 180px,
// beside a side panel, without one under the Windows caption buttons, and at
// phone width. Nothing may overlap or leave the header, the title keeps its floor
// (or, at the last step, a readable minimum), everything folded away is in "…",
// and narrowing never unfolds anything.
const WEB = new URL('../web/', import.meta.url)
function loadEsbuild() {
  try { return createRequire(new URL('package.json', WEB))('esbuild') } catch { return null }
}
const esbuild = loadEsbuild()

// Titles of several lengths: a long one, three in the 150–300px band where a floor
// that jumps once let the header unfold, and a short one.
const TITLES = ['Pittsburgh stays for the November birthday weekend', 'Fix the usage pills overlap', 'Hotels for Saturday night', 'Plan the Pittsburgh trip budget', 'Weekly review']
const range = (from, to, step) => Array.from({ length: Math.floor((from - to) / step) + 1 }, (_, i) => from - i * step)

const usageSnapshot = (providers) => {
  const now = Date.now()
  const acct = (id, backend, pct, state = 'ok') => ({ id, backend, label: id, state, meters: [{ key: '5h', label: '5-hour limit', remainingPct: pct, resetsAt: now + 7200e3 }], headroomPct: pct, fetchedAt: now })
  const all = [
    [acct('claude:a', 'claude', 83), { backend: 'claude', usable: 1, total: 1, headroomPct: 83 }],
    [acct('codex:a', 'codex', 0, 'limited'), { backend: 'codex', usable: 0, total: 1, nextBackAt: now + 2 * 3600e3 }],
    [acct('cursor:a', 'cursor', 0, 'limited'), { backend: 'cursor', usable: 0, total: 1, nextBackAt: now + 23 * 86400e3 }],
  ].slice(0, providers)
  return { type: 'snapshot', generatedAt: now, accounts: all.map((x) => x[0]), pools: all.map((x) => x[1]) }
}

async function serveHarness() {
  const built = await esbuild.build({
    entryPoints: [fileURLToPath(new URL('src/chat/ChatHeader.harness.tsx', WEB))],
    bundle: true, write: false, format: 'esm', jsx: 'automatic', target: 'es2022', logLevel: 'silent',
    loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"', __TOTEM_VERSION__: '"test"', 'import.meta.env': '{}' },
    // Vite's `?raw` imports (the Totems glyph's SVG), as text.
    plugins: [{
      name: 'raw',
      setup(b) {
        b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: resolvePath(a.resolveDir, a.path.replace(/\?raw$/, '')), namespace: 'raw' }))
        b.onLoad({ filter: /.*/, namespace: 'raw' }, async (a) => ({ contents: await readFile(a.path, 'utf8'), loader: 'text' }))
      },
    }],
  })
  const css = await Promise.all(['styles.css', 'shell.css', 'chat/chat.css'].map((p) => readFile(new URL(`src/${p}`, WEB), 'utf8')))
  const html = `<!doctype html><meta charset="utf-8"><style>${css.join('\n')}\nbody{margin:0}</style><div id="root"></div><script type="module" src="/harness.js"></script>`
  const server = createServer((req, res) => {
    if (req.url === '/harness.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(built.outputFiles[0].text) }
    if (req.url.startsWith('/api/')) { res.writeHead(404); return res.end('{}') }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(html)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() }
}

/** Every variant's header at the current widths: what shows, where, and what has folded. */
function measureHeaders() {
  const visible = (e) => e.getClientRects().length > 0 && e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== 'hidden'
  return [...document.querySelectorAll('[data-variant]')].map((root) => {
    const top = root.querySelector('.vc-top')
    const cs = getComputedStyle(top)
    const t = top.getBoundingClientRect()
    const inner = { left: t.left + parseFloat(cs.paddingLeft), right: t.right - parseFloat(cs.paddingRight) }
    const wrap = top.querySelector('.vc-top-title-wrap').getBoundingClientRect()
    const right = top.querySelector('.vc-top-right').getBoundingClientRect()
    // What sits in the title's side is clipped to it (overflow: hidden).
    const items = [...top.querySelectorAll('button, .vc-usage-chip, .vc-top-title')].filter(visible).filter((e) => !e.closest('.vc-usage-chip') || e.matches('.vc-usage-chip'))
      .filter((e) => !(e.parentElement?.closest('button')))
      .map((e) => {
        const b = e.getBoundingClientRect()
        const inWrap = !!e.closest('.vc-top-title-wrap')
        const left = inWrap ? Math.max(b.left, wrap.left) : b.left
        const rightEdge = inWrap ? Math.min(b.right, wrap.right) : b.right
        return { what: (e.getAttribute('aria-label') || e.className || e.tagName).toString().slice(0, 40), left, right: rightEdge, inWrap }
      }).filter((i) => i.right - i.left > 0.5)
    const title = top.querySelector('.vc-top-title') || top.querySelector('.vc-top-crumb.last .vc-top-project > span')
    // Folded means display: none (a crumb's wrapper is display: contents, which has no box of its own).
    const folded = [...top.querySelectorAll('[data-fold-into]')].filter((e) => getComputedStyle(e).display === 'none').length
    const more = top.querySelector('.vc-top-more')
    const pills = [...top.querySelectorAll('.vc-usage-chip')]
    return {
      id: root.dataset.variant, inner, wrapRight: wrap.right, rightLeft: right.left, items,
      fold: (top.dataset.fold || '').split(' ').filter(Boolean).length,
      title: title ? { width: title.clientWidth, natural: title.scrollWidth } : null,
      floor: title ? window.__titleFloor(title.scrollWidth, inner.right - inner.left) : 0,
      maxed: (top.dataset.fold || '').split(' ').filter(Boolean).length === window.__foldSteps.length,
      folded, more: !!more && visible(more),
      usage: pills.length ? pills.some(visible) : null,
      usageStep: window.__foldSteps.indexOf('usage') + 1,
    }
  })
}

test('the real chat header folds to fit from 1400px down to a 180px column', { skip: !executablePath || !esbuild }, async () => {
  const served = await serveHarness()
  const browser = await chromium.launch({ executablePath })
  try {
    for (const title of TITLES) for (const providers of [3, 1]) {
      const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
      const snapshot = JSON.stringify(usageSnapshot(providers))
      await page.route('**/api/ai-usage**', (r) => r.fulfill({ status: 200, contentType: r.request().url().includes('/stream') ? 'text/event-stream' : 'application/json', body: r.request().url().includes('/stream') ? `data: ${snapshot}\n\n` : snapshot }))
      await page.goto(`${served.url}?title=${encodeURIComponent(title)}`)
      await page.waitForSelector('.vc-usage-chip', { state: 'attached' })
      const layouts = [
        // 4px at a time where the steps come thick, so a header that unfolds for a few pixels is caught.
        { name: 'beside a side panel', viewport: 1600, windows: false, widths: [...range(1400, 500, 20), ...range(480, 180, 4)] },
        // The desktop app's window is at least 420px; under 720px that is the phone layout.
        { name: 'Windows app, no side panel', viewport: 1600, windows: true, widths: [1400, 1000, 800, 721] },
        { name: 'Windows app, no side panel', viewport: 'width', windows: true, widths: [720, 560, 420] },
        { name: 'phone', viewport: 'width', windows: false, widths: [430, 390, 360, 320] },
      ]
      for (const layout of layouts) {
        const last = {}
        for (const width of [...layout.widths].sort((a, b) => b - a)) {
          await page.setViewportSize({ width: layout.viewport === 'width' ? width : layout.viewport, height: 900 })
          await page.evaluate(({ width, windows, phone }) => {
            if (windows) document.documentElement.dataset.desktop = 'windows'
            else delete document.documentElement.dataset.desktop
            for (const split of document.querySelectorAll('.vc-split')) {
              split.classList.toggle('has-artifact', !windows && !phone)
              split.lastElementChild.style.display = windows || phone ? 'none' : ''
              // The chat column's minimum (chat.css, --chat-min or 55%) is lifted here: a
              // narrow window with three panels open can still leave it this narrow.
              split.firstElementChild.style.flex = `0 0 ${width}px`
              split.firstElementChild.style.minWidth = '0'
            }
          }, { width, windows: layout.windows, phone: layout.name === 'phone' })
          // ResizeObserver delivers before the next paint.
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
          // HEADER_SHOTS=<dir> keeps a picture of every header at every width, for review.
          if (process.env.HEADER_SHOTS && width % 20 === 0 && title === TITLES[0]) {
            const shotDir = process.env.HEADER_SHOTS
            for (const id of await page.$$eval('[data-variant]', (els) => els.map((e) => e.dataset.variant))) {
              await page.locator(`[data-variant="${id}"]`).screenshot({ path: `${shotDir}/${providers}p-${layout.windows ? 'win' : layout.name === 'phone' ? 'phone' : 'panel'}-${id}-${width}.png` })
            }
          }
          for (const h of await page.evaluate(measureHeaders)) {
            // The phone's header (drawer button, New chat) exists only in the phone layout, a column of 320px or more.
            if (h.id === 'phone' && layout.name !== 'phone') continue
            const at = `"${title}", ${providers} provider${providers > 1 ? 's' : ''}, ${layout.name}, ${h.id} at ${width}px`
            for (const it of h.items) assert.ok(it.left >= h.inner.left - 0.5 && it.right <= h.inner.right + 0.5, `${at}: ${it.what} leaves the header (${it.left}–${it.right} outside ${h.inner.left}–${h.inner.right})`)
            const sorted = [...h.items].sort((a, b) => a.left - b.left)
            for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].left >= sorted[i - 1].right - 0.5, `${at}: ${sorted[i - 1].what} overlaps ${sorted[i].what}`)
            assert.ok(h.wrapRight <= h.rightLeft + 0.5, `${at}: the title runs under the right side`)
            // The fold's own floor (headerFold.ts), unless every step is taken; even then, a readable stub.
            if (h.title) {
              const floor = h.maxed ? Math.min(h.title.natural, 48) : h.floor
              assert.ok(h.title.width + 0.5 >= floor, `${at}: the title is ${h.title.width}px of ${h.title.natural}px (floor ${Math.round(floor)}, ${h.fold} steps)`)
            }
            // A usage pill shows until the step that moves it into "…" (one provider included).
            if (h.usage !== null && h.fold < h.usageStep) assert.ok(h.usage, `${at}: no usage pill, ${h.fold} steps in (it folds at step ${h.usageStep})`)
            if (h.folded) assert.ok(h.more, `${at}: ${h.folded} control(s) folded away but no "…" to reach them`)
            if (last[h.id] !== undefined) assert.ok(h.fold >= last[h.id], `${at}: narrower, yet it unfolded (${last[h.id]} → ${h.fold} steps)`)
            if (process.env.HEADER_TRACE) console.log(at, h.fold, h.title?.width)
            last[h.id] = h.fold
            if (width >= 1400 && !layout.windows && h.id === 'plain') assert.equal(h.fold, 0, `${at}: nothing folds at full width`)
          }
        }
      }
      // At 180px, every control of the fullest header is one "…" away.
      await page.setViewportSize({ width: 1600, height: 900 })
      await page.evaluate(() => {
        delete document.documentElement.dataset.desktop
        for (const split of document.querySelectorAll('.vc-split')) { split.classList.add('has-artifact'); split.lastElementChild.style.display = ''; split.firstElementChild.style.flex = '0 0 180px'; split.firstElementChild.style.minWidth = '0' }
      })
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      // The usage panel opens inside the chat column (beside the rail, the chats panel when shown) and the window.
      if (title === TITLES[0]) {
        await page.setViewportSize({ width: 1600, height: 900 })
        for (const inset of [64, 320]) for (const w of [900, 560, 380, 300]) {
          await page.evaluate(({ inset, w }) => {
            delete document.documentElement.dataset.desktop
            document.body.style.paddingLeft = `${inset}px`
            for (const split of document.querySelectorAll('.vc-split')) { split.classList.add('has-artifact'); split.lastElementChild.style.display = ''; split.firstElementChild.style.flex = `0 0 ${w}px`; split.firstElementChild.style.minWidth = '0' }
          }, { inset, w })
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
          const pills = page.locator('[data-variant="plain"] .vc-usage')
          if (!(await pills.isVisible())) continue
          await pills.click()
          await page.waitForSelector('[data-variant="plain"] .vc-usage-panel')
          const r = await page.evaluate(() => {
            const p = document.querySelector('[data-variant="plain"] .vc-usage-panel').getBoundingClientRect()
            const c = document.querySelector('[data-variant="plain"] .vc-split > .vc').getBoundingClientRect()
            return { left: p.left, right: p.right, bottom: p.bottom, column: c.left, vw: innerWidth, vh: innerHeight }
          })
          const at = `${providers} provider(s), usage panel, ${w}px column ${inset}px from the left`
          assert.ok(r.left >= r.column - 0.5, `${at}: it runs off the column's left (${Math.round(r.left)} < ${Math.round(r.column)})`)
          assert.ok(r.right <= r.vw + 0.5 && r.bottom <= r.vh + 0.5, `${at}: it leaves the window`)
          await page.keyboard.press('Escape')
          await page.waitForSelector('[data-variant="plain"] .vc-usage-panel', { state: 'detached' })
        }
        await page.evaluate(() => { document.body.style.paddingLeft = '' })
      }
      // One row in "…" for each control folded away, in every variant.
      for (const h of await page.evaluate(measureHeaders)) {
        if (!h.folded || h.id === 'phone') continue
        await page.click(`[data-variant="${h.id}"] .vc-top-more`)
        await page.waitForSelector('.vc-top-menu [role="menuitem"]')
        const rows = await page.$$eval('.vc-top-menu [role="menuitem"]', (els) => els.map((e) => e.querySelector('.vc-top-menu-label')?.textContent))
        assert.equal(rows.length, h.folded, `${providers} provider(s), ${h.id} at 180px: ${h.folded} control(s) folded, but "…" has ${rows.length} rows (${rows.join(', ')})`)
        if (h.id === 'projectGroup') {
          for (const want of ['Show chats', 'New chat', 'Personal finance and planning', 'All totems', 'Project context', 'Totems in this chat', '12 files', '2 working', 'Browsing', 'AI usage']) {
            assert.ok(rows.includes(want), `${providers} provider(s), projectGroup at 180px: "${want}" is not in "…" (${rows.join(', ')})`)
          }
        }
        await page.keyboard.press('Escape')
        await page.waitForSelector('.vc-top-menu', { state: 'detached' })
      }
      await page.close()
    }
  } finally { await browser.close(); served.close() }
})

const SHELL = `<div class="app shell panel-open term-open">
  <nav class="sh-rail">Totem</nav>
  <aside class="sh-panel">Chats<div class="panel-resize dock-left" role="separator"></div></aside>
  <main class="main"><div class="vc-split has-artifact">
    <div class="vc"><header class="vc-top">Fictional chat</header></div>
    <div class="panel-resize dock-right inline" role="separator"></div>
    <aside class="vc vc-artifact vc-files"><iframe title="canvas"></iframe></aside>
  </div></main>
  <aside class="term-panel"><div class="panel-resize dock-right" role="separator"></div>Terminal</aside>
</div>`

// The shell's minimums (shell.css, chat.css), restated here so the test checks them.
const CHAT_MIN = 380, SIDE_MIN = 320, CHATS_MIN = 220
const termMin = (vw) => Math.min(340, vw * 0.24)

async function shellPage(browser) {
  const page = await browser.newPage()
  const css = await Promise.all(['styles.css', 'shell.css', 'chat/chat.css'].map((p) => readFile(new URL(`../web/src/${p}`, import.meta.url), 'utf8')))
  await page.setContent(`<style>${css.join('\n')}</style>${SHELL}`)
  const measure = () => page.evaluate(() => {
    const w = (s) => document.querySelector(s).getBoundingClientRect().width
    return {
      chats: w('.sh-panel'), main: w('.main'), term: w('.term-panel'), chat: w('.vc-split > .vc:first-child'), side: w('.vc-artifact'),
      split: w('.vc-split'), handles: [...document.querySelectorAll('.panel-resize')].map((h) => getComputedStyle(h).display !== 'none'),
      termLeft: document.querySelector('.term-panel').getBoundingClientRect().left, mainRight: document.querySelector('.main').getBoundingClientRect().right,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }
  })
  // Each width lives where it is read (registered, not inherited): the shell's two on the shell, the side panel's on the panel.
  const setWidths = (vars) => page.evaluate((v) => {
    for (const [k, val] of Object.entries(v)) {
      const el = k === '--vc-side-w' ? document.querySelector('.vc-artifact') : document.querySelector('.app')
      if (val === null) el.style.removeProperty(k); else el.style.setProperty(k, val)
    }
  }, vars)
  return { page, measure, setWidths }
}

test('resized side panels keep their widths, give way before the page, and vanish on a phone', { skip: !executablePath }, async () => {
  const browser = await chromium.launch({ executablePath })
  try {
    const { page, measure, setWidths } = await shellPage(browser)

    // Nothing saved: the defaults, as before this change.
    await page.setViewportSize({ width: 2560, height: 900 })
    let m = await measure()
    assert.equal(Math.round(m.chats), 268, 'chats panel default')
    assert.equal(Math.round(m.term), 520, 'terminal default')
    assert.ok(Math.abs(m.chat - Math.min(m.split * 0.46, 640)) < 1.5, `chat keeps min(46%, 640px) by default (${m.chat})`)

    // Saved widths, on a wide screen: every panel takes exactly what was saved.
    await setWidths({ '--sh-panel-w': '400px', '--term-w': '600px', '--vc-side-w': '700px' })
    m = await measure()
    assert.deepEqual([Math.round(m.chats), Math.round(m.term), Math.round(m.side)], [400, 600, 700])
    assert.ok(m.handles.every(Boolean), 'every handle shows on desktop')
    assert.ok(Math.abs(m.mainRight - m.termLeft) < 1, 'the page meets the terminal')

    // The chats panel has a ceiling of its own.
    await setWidths({ '--sh-panel-w': '5000px' })
    assert.equal(Math.round((await measure()).chats), 560, 'chats panel tops out at 560px')

    // Laptop to small windows, with the defaults and with widths saved on a big monitor: the
    // chats panel and the terminal give way first. While either is above its minimum the chat
    // and its side panel keep theirs; below that everything shares what is left, and nothing
    // scrolls sideways.
    const configs = {
      defaults: { '--sh-panel-w': null, '--term-w': null, '--vc-side-w': null },
      big: { '--sh-panel-w': '420px', '--term-w': '760px', '--vc-side-w': '900px' },
    }
    for (const [name, vars] of Object.entries(configs)) {
      await setWidths(vars)
      for (const width of [1920, 1600, 1366, 1280, 1100, 1000, 900, 800, 721]) {
        await page.setViewportSize({ width, height: 900 })
        m = await measure()
        const at = `${name} @ ${width}px (chats ${m.chats}, term ${m.term}, chat ${m.chat}, side ${m.side})`
        assert.equal(m.overflow, false, `${at}: no sideways scroll`)
        assert.ok(m.chats >= CHATS_MIN - 0.5, `${at}: chats panel keeps its minimum`)
        assert.ok(m.term >= termMin(width) - 0.5, `${at}: terminal keeps its minimum`)
        const outerCanGive = m.chats > CHATS_MIN + 1 || m.term > termMin(width) + 1
        if (outerCanGive) assert.ok(m.chat >= CHAT_MIN - 0.5 && m.side >= SIDE_MIN - 0.5, `${at}: chat and side panel keep their minimums while an outer panel can give`)
        assert.ok(m.main >= Math.min(CHAT_MIN + SIDE_MIN, width - 64 - CHATS_MIN - termMin(width)) - 1, `${at}: page keeps what it needs or all that is left`)
        assert.ok(Math.abs(m.chat + m.side - m.split) < 1.5, `${at}: chat and side panel fill the split`)
      }
    }
    // The laptop case the council measured: 1366 with the defaults.
    await setWidths(configs.defaults)
    await page.setViewportSize({ width: 1366, height: 900 })
    m = await measure()
    assert.ok(m.chat >= CHAT_MIN - 0.5 && m.side >= SIDE_MIN - 0.5, `1366 defaults: chat ${m.chat}, side ${m.side}`)

    // And the saved widths come back once the window is wide again.
    await setWidths(configs.big)
    await page.setViewportSize({ width: 2560, height: 900 })
    m = await measure()
    assert.deepEqual([Math.round(m.chats), Math.round(m.term), Math.round(m.side)], [420, 760, 900])

    // A phone: the terminal and the side panel are full-screen sheets with no handle.
    await page.evaluate(() => { document.querySelector('.app').classList.remove('panel-open'); document.querySelector('.sh-panel').style.display = 'none'; document.querySelector('.sh-rail').style.display = 'none' })
    await page.setViewportSize({ width: 390, height: 844 })
    m = await measure()
    assert.equal(m.overflow, false, 'phone: no sideways scroll')
    assert.ok(m.handles.every((shown) => !shown), 'phone: no resize handles')
    assert.equal(Math.round(m.term), 390, 'phone: terminal fills the screen')
    assert.equal(Math.round(m.side), 390, 'phone: side panel fills the screen')
    assert.equal(Math.round(m.main), 390, 'phone: the page keeps the full width')
  } finally { await browser.close() }
})

test('a resize strip reaches at most 2px past its edge, so the neighbour\'s scrollbar still scrolls', { skip: !executablePath }, async () => {
  const browser = await chromium.launch({ executablePath })
  try {
    const { page } = await shellPage(browser)
    await page.setViewportSize({ width: 1920, height: 900 })
    const hits = await page.evaluate(() => {
      const isHandle = (x, y) => !!document.elementFromPoint(x, y)?.classList.contains('panel-resize')
      const y = 400
      const chatsEdge = document.querySelector('.sh-panel').getBoundingClientRect().right
      const chatEdge = document.querySelector('.vc-split > .vc:first-child').getBoundingClientRect().right
      const termEdge = document.querySelector('.term-panel').getBoundingClientRect().left
      return {
        // Inside the neighbour, 3px from the edge: its scrollbar's, not the strip's.
        chatsOut: isHandle(chatsEdge + 3, y), chatOut: isHandle(chatEdge - 3, y), termOut: isHandle(termEdge - 3, y),
        // On the edge and inside the panel: the strip's.
        chatsIn: isHandle(chatsEdge - 1, y) && isHandle(chatsEdge - 7, y),
        sideIn: isHandle(chatEdge, y) && isHandle(chatEdge + 9, y),
        termIn: isHandle(termEdge, y) && isHandle(termEdge + 9, y),
      }
    })
    assert.deepEqual(hits, { chatsOut: false, chatOut: false, termOut: false, chatsIn: true, sideIn: true, termIn: true })
  } finally { await browser.close() }
})

test('without @property (older Safari and Firefox) the shell still lays out from the fallbacks', { skip: !executablePath }, async () => {
  const browser = await chromium.launch({ executablePath })
  try {
    const page = await browser.newPage()
    const css = await Promise.all(['styles.css', 'shell.css', 'chat/chat.css'].map((p) => readFile(new URL(`../web/src/${p}`, import.meta.url), 'utf8')))
    const stripped = css.join('\n').replace(/@property[^}]*\}/g, '')
    assert.ok(!/@property/.test(stripped))
    await page.setContent(`<style>${stripped}</style>${SHELL}`)
    await page.setViewportSize({ width: 2560, height: 900 })
    const w = () => page.evaluate(() => ({ rail: document.querySelector('.sh-rail').getBoundingClientRect().width, chats: document.querySelector('.sh-panel').getBoundingClientRect().width, term: document.querySelector('.term-panel').getBoundingClientRect().width }))
    assert.deepEqual(await w(), { rail: 64, chats: 268, term: 520 })
    await page.evaluate(() => { const app = document.querySelector('.app'); app.style.setProperty('--sh-panel-w', '400px'); app.style.setProperty('--term-w', '600px') })
    assert.deepEqual(await w(), { rail: 64, chats: 400, term: 600 })
  } finally { await browser.close() }
})

test('a canvas widened at 1366 keeps its width while held and from its saved width after a resize or reload', { skip: !executablePath }, async () => {
  const browser = await chromium.launch({ executablePath })
  try {
    const { page, measure, setWidths } = await shellPage(browser)
    await page.setViewportSize({ width: 1366, height: 900 })
    // Saved chats 400 and terminal 520 do not both fit: the grid squeezes them.
    await setWidths({ '--sh-panel-w': '400px', '--term-w': '520px', '--vc-side-w': null })
    const before = await measure()
    assert.deepEqual([Math.round(before.chats), Math.round(before.term), Math.round(before.side), Math.round(before.chat)], [247, 354, 320, 380])
    // After the gesture (ResizeHandle's keep): the canvas saved at its new width and
    // published as --side-saved, the terminal saved at its saved 520 less the 20 it
    // gave, both drawn where the gesture left them, the chats panel held at 247.
    await setWidths({ '--term-w': '334px', '--vc-side-w': '340px', '--side-saved': '340px', '--sh-panel-w': '247px' })
    let m = await measure()
    assert.deepEqual([Math.round(m.chats), Math.round(m.term), Math.round(m.side), Math.round(m.chat)], [247, 334, 340, 380], 'no snap-back while held')
    // The holds drop (a resize, a reload): saved widths alone. The page keeps the
    // canvas's saved width, so the chats panel and the terminal share the squeeze
    // and the canvas stays at 340.
    await setWidths({ '--sh-panel-w': '400px', '--term-w': '500px' })
    m = await measure()
    assert.equal(m.overflow, false)
    assert.deepEqual([Math.round(m.side), Math.round(m.chat)], [340, 380], `saved widths keep the canvas (chats ${m.chats}, terminal ${m.term})`)
    assert.ok(m.chats >= 220 && m.term >= 1366 * 0.24 - 1, 'the outer panels squeeze to no less than their minimums')
    // Without --side-saved (the page reserving only the panel's minimum) the canvas would lose it.
    await setWidths({ '--side-saved': null })
    assert.equal(Math.round((await measure()).side), 320, 'the page minimum is what keeps it')
    await setWidths({ '--side-saved': '340px' })
    // Wide again: every saved width.
    await page.setViewportSize({ width: 2560, height: 900 })
    m = await measure()
    assert.deepEqual([Math.round(m.chats), Math.round(m.term), Math.round(m.side)], [400, 500, 340])
  } finally { await browser.close() }
})
