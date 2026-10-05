import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserManager, findChromium, normalizeUrl } from './manager.mjs'
import { callBrowserTool, browserToolDescriptors } from './tools.mjs'

test('URLs are completed the way T3 does it', () => {
  assert.equal(normalizeUrl('t3.chat'), 'https://t3.chat')
  assert.equal(normalizeUrl('localhost:5173/x'), 'http://localhost:5173/x')
  assert.equal(normalizeUrl('127.0.0.1:8787'), 'http://127.0.0.1:8787')
  assert.equal(normalizeUrl('http://example.com'), 'http://example.com')
  assert.throws(() => normalizeUrl('file:///etc/passwd'), /Only http/)
  assert.throws(() => normalizeUrl(''), /required/)
})

test('every tool has a schema the Realtime/MCP clients accept', () => {
  for (const t of browserToolDescriptors()) {
    assert.equal(t.inputSchema.type, 'object', t.name)
    assert.ok(t.name.startsWith('preview_'))
    for (const k of ['oneOf', 'anyOf', 'allOf']) assert.ok(!(k in t.inputSchema), `${t.name} has top-level ${k}`)
  }
})

const PAGE = `<!doctype html><title>Order form</title>
<h1>Coffee order</h1>
<label>Name <input id="name"></label>
<button onclick="document.getElementById('out').textContent = 'Thanks, ' + document.getElementById('name').value">Place order</button>
<p id="out"></p>
<script>console.error('a broken widget')</script>`

test('a chat can open a page, read it, fill a form, and see the result', { skip: !findChromium() && 'no Chromium on this machine' }, async () => {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const frames = []
  const manager = createBrowserManager({ onFrame: (key, f) => frames.push({ key, ...f }) })
  const dir = await mkdtemp(join(tmpdir(), 'vbrowser-'))
  const ctx = { key: 'thread-a', saveDir: dir }
  try {
    const opened = await callBrowserTool(manager, 'preview_open', { url: `localhost:${port}` }, ctx)
    assert.ok(!opened.isError, opened.content[0].text)
    assert.equal(opened.structuredContent.title, 'Order form')

    const snap = await callBrowserTool(manager, 'preview_snapshot', { save: true }, ctx)
    const text = snap.content[0].text
    assert.match(text, /role=button\[name="Place order"\]/)
    assert.match(text, /a broken widget/) // console errors are reported
    assert.equal(snap.content[1].type, 'image')
    assert.ok((await stat(snap.structuredContent.screenshotPath)).size > 1000)

    assert.ok(!(await callBrowserTool(manager, 'preview_type', { locator: 'role=textbox[name="Name"]', text: 'Ada' }, ctx)).isError)
    assert.ok(!(await callBrowserTool(manager, 'preview_click', { locator: 'role=button[name="Place order"]' }, ctx)).isError)
    assert.ok(!(await callBrowserTool(manager, 'preview_wait_for', { text: 'Thanks, Ada' }, ctx)).isError)
    const ev = await callBrowserTool(manager, 'preview_evaluate', { expression: "document.getElementById('out').textContent" }, ctx)
    assert.equal(JSON.parse(ev.content[0].text), 'Thanks, Ada')

    const sized = await callBrowserTool(manager, 'preview_resize', { mode: 'preset', preset: 'iphone-12-pro' }, ctx)
    assert.deepEqual(sized.structuredContent.viewport, { width: 390, height: 844 })

    // A bad locator is an actionable error, not a crash.
    const miss = await callBrowserTool(manager, 'preview_click', { locator: 'role=button[name="Nope"]', timeoutMs: 500 }, ctx)
    assert.ok(miss.isError)
    assert.match(miss.content[0].text, /Timeout|waiting/i)

    // Chats do not share a browser.
    const other = await callBrowserTool(manager, 'preview_status', {}, { key: 'thread-b' })
    assert.equal(other.structuredContent.tabId, null)

    assert.ok(frames.length >= 5 && frames.every((f) => f.key === 'thread-a' && f.jpeg.length > 500))
  } finally {
    await manager.closeAll()
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a shared screenshot becomes an upload; any other path stays put', async () => {
  const { embedLocalImages } = await import('./shots.mjs')
  const { writeFile, mkdir } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'vshots-'))
  try {
    await mkdir(join(dir, 'screenshots'))
    const shot = join(dir, 'screenshots', 'page.png')
    await writeFile(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    const saved = []
    const save = async (f) => { saved.push(f); return { id: 'u1', url: '/api/chat/uploads/u1?sig=x' } }
    const text = `Here it is:\n\n![Home page](${shot})\n\nand ![secret](/etc/passwd.png) and ![x](file://${shot})`
    const out = await embedLocalImages(text, { allowedDirs: [dir], save })
    assert.equal(saved.length, 1)
    assert.equal(saved[0].mime, 'image/png')
    assert.match(out.text, /!\[Home page\]\(\/api\/chat\/uploads\/u1\?sig=x\)/)
    assert.match(out.text, /!\[x\]\(\/api\/chat\/uploads\/u1\?sig=x\)/) // same file, one upload
    assert.match(out.text, /!\[secret\]\(\/etc\/passwd\.png\)/) // outside the allowed dirs
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('browser calls read like what the agent did', async () => {
  const { describeMcpCall } = await import('../chat/tools.mjs')
  assert.equal(describeMcpCall({ name: 'mcp__totem-browser__preview_open', input: { url: 'https://www.example.com/x' } }).title, 'Opened example.com')
  assert.equal(describeMcpCall({ name: 'preview_click', server: 'totem_browser', input: { locator: "role=link[name='Learn more']" } }).title, 'Clicked “Learn more”')
  assert.equal(describeMcpCall({ name: 'totem-gateway-browser__preview_snapshot', input: {} }).title, 'Looked at the page')
  assert.equal(describeMcpCall({ name: 'preview_navigate', server: 'totem_browser', input: { target: { kind: 'environment-port', port: 5173 } } }).title, 'Went to localhost:5173')
})
