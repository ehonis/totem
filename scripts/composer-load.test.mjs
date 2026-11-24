// The composer while its editor's chunk is still on the way (web/src/chat/Composer.tsx
// PlainBox, docs/chat.md → Attachments): a plain textarea takes the typing, and the
// editor carries on from its caret and focus. jsdom cannot see the order a real
// browser runs this in (TipTap reports ready before React swaps the editor in), so
// this bundles web/src/chat/ComposerLoad.harness.tsx with the editor on its own
// chunk, holds that chunk back, and types across the switch in Chromium, with a
// mouse and with touch.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { findChromium } from '../browser/manager.mjs'

const WEB = new URL('../web/', import.meta.url)
const esbuild = (() => { try { return createRequire(new URL('package.json', WEB))('esbuild') } catch { return null } })()
const executablePath = findChromium()
const CHUNK_DELAY = 1200

async function serve() {
  const built = await esbuild.build({
    entryPoints: { harness: fileURLToPath(new URL('src/chat/ComposerLoad.harness.tsx', WEB)) },
    bundle: true, write: false, splitting: true, metafile: true, outdir: '/out', format: 'esm', jsx: 'automatic', target: 'es2022', logLevel: 'silent',
    loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"', __TOTEM_VERSION__: JSON.stringify({ version: 'test', date: '2026-01-01', commit: '' }), 'import.meta.env': '{}' },
  })
  const files = new Map(built.outputFiles.map((f) => [f.path.replace(/^\/out/, ''), f.text]))
  const editor = Object.entries(built.metafile.outputs).find(([, o]) => o.entryPoint?.endsWith('editor/PromptEditor.tsx'))?.[0].replace(/^.*?out/, '')
  assert.ok(editor && files.has(editor), 'the editor is bundled on its own chunk')
  const css = await Promise.all(['styles.css', 'shell.css', 'chat/chat.css'].map((p) => readFile(new URL(`src/${p}`, WEB), 'utf8')))
  const html = `<!doctype html><meta charset="utf-8"><style>${css.join('\n')}\nbody{margin:0}</style><div id="root"></div><script type="module" src="/harness.js"></script>`
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0]
    if (files.has(path)) {
      const send = () => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(files.get(path)) }
      return path === editor ? setTimeout(send, CHUNK_DELAY) : send()
    }
    if (path.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}') }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(html)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() }
}

test('typing across the plain box handing over to the editor loses nothing and keeps the caret', { skip: !executablePath || !esbuild }, async () => {
  const served = await serve()
  const browser = await chromium.launch({ executablePath })
  try {
    for (const [how, options] of [['mouse', {}], ['touch', { hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } }]]) {
      const page = await browser.newPage(options)
      await page.goto(served.url)
      await page.waitForSelector('textarea.vc-ed-plain')
      assert.equal(await page.locator('.vc-ed[contenteditable]:visible').count(), 0, `${how}: the editor is still held back`)
      if (how === 'touch') await page.tap('textarea.vc-ed-plain')
      else await page.click('textarea.vc-ed-plain')
      await page.keyboard.type('hello world')
      for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft')
      // One key every 40 ms until well after the chunk lands, so some fall on each side of the switch.
      let typed = 0
      while (!(await page.locator('.vc-ed[contenteditable]:visible').count()) || typed < 50) {
        await page.keyboard.type('x')
        typed += 1
        await page.waitForTimeout(40)
      }
      const after = await page.evaluate(() => ({ value: window.__value, focused: !!document.activeElement?.matches('.vc-ed[contenteditable]') }))
      assert.equal(after.value, `hello ${'x'.repeat(typed)}world`, `${how}: every key landed at the caret`)
      assert.ok(after.focused, `${how}: the editor has focus`)
      await page.keyboard.type('Z')
      assert.equal(await page.evaluate(() => window.__value), `hello ${'x'.repeat(typed)}Zworld`, `${how}: the caret is where it was`)
      await page.close()
    }
  } finally {
    await browser.close()
    served.close()
  }
})

/** A fresh page of the harness with its editor chunk on the way, and helpers for it. */
async function opened(browser, served, options = {}) {
  const page = await browser.newPage(options)
  await page.goto(served.url)
  await page.waitForSelector('textarea.vc-ed-plain')
  const editorUp = () => page.locator('.vc-ed[contenteditable]:visible').count()
  const value = () => page.evaluate(() => window.__value)
  return { page, editorUp, value }
}

test('the editor never takes focus from another field, during the load or after it', { skip: !executablePath || !esbuild }, async () => {
  const served = await serve()
  const browser = await chromium.launch({ executablePath })
  try {
    // After the handover: he moves to another field, and a re-render of the composer leaves him there.
    let { page, editorUp, value } = await opened(browser, served)
    await page.click('textarea.vc-ed-plain')
    await page.keyboard.type('hello world')
    await page.waitForSelector('.vc-ed[contenteditable]:visible')
    await page.click('#other')
    await page.keyboard.type('find')
    await page.evaluate(() => window.__bump())
    await page.waitForTimeout(100)
    await page.keyboard.type('ing')
    assert.equal(await page.inputValue('#other'), 'finding')
    assert.equal(await value(), 'hello world')
    await page.close()

    // During the load: he is typing elsewhere as the editor arrives, and it stays there.
    ;({ page, editorUp, value } = await opened(browser, served))
    await page.click('#other')
    let typed = 0
    while (!(await editorUp()) || typed < 40) {
      await page.keyboard.type('a')
      typed += 1
      await page.waitForTimeout(40)
    }
    assert.equal(await page.inputValue('#other'), 'a'.repeat(typed))
    assert.equal(await value(), '')
    await page.close()
  } finally {
    await browser.close()
    served.close()
  }
})

test('the editor takes over a selection, and waits for an IME word in progress', { skip: !executablePath || !esbuild }, async () => {
  const served = await serve()
  const browser = await chromium.launch({ executablePath })
  try {
    let { page, editorUp, value } = await opened(browser, served)
    await page.click('textarea.vc-ed-plain')
    await page.keyboard.type('hello world')
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft')
    await page.waitForSelector('.vc-ed[contenteditable]:visible')
    await page.keyboard.type('Z')
    assert.equal(await value(), 'hello Z', 'typing replaces the selection carried over')
    await page.close()

    ;({ page, editorUp, value } = await opened(browser, served))
    await page.click('textarea.vc-ed-plain')
    await page.keyboard.type('say ')
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 })
    // The chunk lands while the word is still being composed: the plain box stays.
    await page.waitForTimeout(2000)
    assert.equal(await editorUp(), 0, 'the plain box stays while a word is composed')
    await cdp.send('Input.insertText', { text: 'にほん' })
    await page.waitForSelector('.vc-ed[contenteditable]:visible')
    assert.equal(await value(), 'say にほん')
    await page.keyboard.type('!')
    assert.equal(await value(), 'say にほん!')
    await page.close()
  } finally {
    await browser.close()
    served.close()
  }
})

test('a list typed in the plain box continues on Return, and is drawn as a list once the editor lands with the caret in its item (#298)', { skip: !executablePath || !esbuild }, async () => {
  const served = await serve()
  const browser = await chromium.launch({ executablePath })
  try {
    const { page, editorUp, value } = await opened(browser, served)
    await page.click('textarea.vc-ed-plain')
    await page.keyboard.type('1. one')
    // Return in the plain box continues the list, as the editor's would, rather than sending.
    await page.keyboard.press('Enter')
    await page.keyboard.type('two')
    assert.equal(await editorUp(), 0, 'the editor is still held back')
    assert.equal(await value(), '1. one\n2. two')
    for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowLeft')
    await page.waitForSelector('.vc-ed[contenteditable] ol > li')
    assert.deepEqual(await page.$$eval('.vc-ed ol > li', (lis) => lis.map((li) => [li.dataset.marker, li.textContent])), [['1.', 'one'], ['2.', 'two']])
    await page.keyboard.type('Z')
    assert.equal(await value(), '1. one\n2. tZwo')
  } finally {
    await browser.close()
    served.close()
  }
})
