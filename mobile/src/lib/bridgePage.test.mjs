// A bridge page in the app's WebView (ui/BridgeWebView.tsx; first used for charts,
// #260): what it may load, which request carries the app's credentials, what the
// page may do once loaded, and what is read from it.
// Run with `node --test mobile/src/lib/*.test.mjs` (also in the root npm test).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import {
  PAGE_HEIGHT_SCRIPT, bridgeNavigation, bridgePageUrl, bridgeSource, linkOpensOutside, onBridgeOrigin, pageHeightFrom, sameDocument,
} from './bridgePage.ts'

const BASE = 'https://totem.example.com'
const PATH = '/api/chat/uploads/abcDEF12_-?sig=Zm9vYmFyYmF6cXV4'
const SRC = `${BASE}${PATH}`
const CONN = { baseUrl: BASE, accessToken: 'access.jwt.token', secret: 'bridge-secret' }

test('bridgePageUrl resolves bridge paths and URLs under the base, nothing else', () => {
  assert.equal(bridgePageUrl(PATH, BASE), SRC)
  assert.equal(bridgePageUrl(PATH, `${BASE}/`), SRC)
  assert.equal(bridgePageUrl(PATH, 'HTTPS://Totem.Example.com:443'), SRC)
  assert.equal(bridgePageUrl(PATH, 'http://100.64.0.1:8787'), `http://100.64.0.1:8787${PATH}`)
  assert.equal(bridgePageUrl('/api/chat/files/raw?path=%2Fx&exp=1&sig=y', BASE), `${BASE}/api/chat/files/raw?path=%2Fx&exp=1&sig=y`)
  assert.equal(bridgePageUrl(SRC, BASE), SRC)
  assert.equal(bridgePageUrl('https://TOTEM.example.com:443/api/x', BASE), `${BASE}/api/x`)
  // A base behind a path prefix (a proxy), as bridgeUrl joins it.
  assert.equal(bridgePageUrl('/api/x', 'https://h.example/totem/'), 'https://h.example/totem/api/x')
  assert.equal(bridgePageUrl('https://h.example/totem/api/x', 'https://h.example/totem'), 'https://h.example/totem/api/x')
  assert.equal(bridgePageUrl('https://h.example/totemx/api', 'https://h.example/totem'), null)
  assert.equal(bridgePageUrl('https://h.example/other', 'https://h.example/totem'), null)
  for (const bad of [
    undefined, '', 'api/x', '//evil.example/api/x', '/\\evil.example/x', '/a b', `${PATH}#frag`,
    'https://evil.example/api/x', 'http://totem.example.com/api/x', 'https://totem.example.com:8443/api/x',
    'https://totem.example.com.evil.example/api/x', 'https://user@totem.example.com/api/x',
    'javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'about:blank',
  ]) assert.equal(bridgePageUrl(bad, BASE), null, String(bad))
  assert.equal(bridgePageUrl(PATH, ''), null)
  assert.equal(bridgePageUrl(PATH, 'javascript:alert(1)'), null)
  assert.equal(bridgePageUrl(PATH, 'https://h.example/?q=1'), null)
})

test('bridgeSource: the Access token for the bridge page only, never the bridge secret', () => {
  assert.deepEqual(bridgeSource(PATH, CONN), { uri: SRC, headers: { 'cf-access-token': 'access.jwt.token' } })
  assert.deepEqual(bridgeSource(PATH, { baseUrl: 'http://100.64.0.1:8787' }), { uri: `http://100.64.0.1:8787${PATH}`, headers: {} })
  // A connection that carries the secret still sends only the Access token: the page may be agent-written.
  assert.ok(!JSON.stringify(bridgeSource(PATH, CONN, { bearer: true })).includes('bridge-secret'))
  // Another origin gets no source at all, so no header is ever built for it.
  for (const other of ['https://evil.example/api/x', '//evil.example/x', 'http://totem.example.com/api/x', 'https://totem.example.com.evil.example/']) {
    assert.equal(bridgeSource(other, CONN), null, other)
  }
  for (const s of [bridgeSource(PATH, CONN), bridgeSource(SRC, CONN)]) assert.ok(onBridgeOrigin(s.uri, BASE))
})

test('only the first request carries the credentials: nothing the page does loads the bridge URL again', () => {
  // react-native-webview sends `source.headers` with the source's load only. The
  // component builds the source once per mount and hands it to the WebView as is;
  // it never reloads, injects into, or rebuilds it, and attaches no header itself.
  const code = (file) => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*\*[\s\S]*?\*\//g, '')
  const component = code('../ui/BridgeWebView.tsx')
  assert.match(component, /useState\(\(\) => bridgeSource\(target, getConnection\(\)\)\)/)
  assert.equal(component.match(/source=\{/g)?.length, 1)
  assert.match(component, /source=\{source\}/)
  for (const banned of ['withAccess', 'cf-access-token', 'Authorization', 'headers', 'bearer', 'secret', '.reload(', 'injectJavaScript(', 'sharedCookiesEnabled\n', 'sharedCookiesEnabled={true}']) {
    assert.ok(!component.includes(banned), `BridgeWebView.tsx must not use ${banned}`)
  }
  assert.match(component, /\bincognito\b/)
  assert.match(component, /sharedCookiesEnabled=\{false\}/)
  assert.match(component, /originWhitelist=\{\['\*'\]\}/)
  // After the first load, a navigation to the bridge URL itself (a reload, location = src)
  // is refused and closes the view, so it is never re-sent; so is any other origin.
  for (const req of [
    { url: SRC, isTopFrame: true, navigationType: 'reload' },
    { url: SRC, isTopFrame: true, navigationType: 'other' },
    { url: SRC, isTopFrame: true, navigationType: 'click' },
    { url: `${BASE}/api/todos`, isTopFrame: true, navigationType: 'other' },
    { url: 'https://evil.example/?t=1', isTopFrame: true, navigationType: 'other' },
  ]) assert.equal(bridgeNavigation(req, SRC, 'loaded'), 'leave', JSON.stringify(req))
  // Before it, a redirect anywhere (Access's sign-in, another site) stops the load.
  assert.equal(bridgeNavigation({ url: 'https://evil.example/', isTopFrame: true }, SRC, 'new'), 'fail')
  assert.equal(bridgeNavigation({ url: `${BASE}/api/other`, isTopFrame: true }, SRC, 'new'), 'fail')
  // The web preview's frame cannot send headers at all.
  assert.ok(!code('../ui/BridgeWebView.web.tsx').includes('headers'))
})

test('sameDocument compares canonical forms and ignores the hash', () => {
  assert.ok(sameDocument('HTTPS://Totem.Example.com:443/a?b=1', 'https://totem.example.com/a?b=1#x'))
  assert.ok(sameDocument('http://h:80/a', 'http://h/a'))
  assert.ok(!sameDocument('http://h:8787/a', 'http://h/a'))
  assert.ok(!sameDocument('https://h/a?b=1', 'https://h/a?b=2'))
  assert.ok(!sameDocument('https://h/a', 'http://h/a'))
  assert.ok(!sameDocument('about:blank', 'about:blank'))
})

test('bridgeNavigation: the first load is the page and nothing else', () => {
  assert.equal(bridgeNavigation({ url: SRC, isTopFrame: true, navigationType: 'other' }, SRC, 'new'), 'allow')
  assert.equal(bridgeNavigation({ url: SRC.replace('totem.example.com', 'totem.example.com:443') }, SRC, 'new'), 'allow')
  assert.equal(bridgeNavigation({ url: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/totem.example.com', isTopFrame: true }, SRC, 'new'), 'fail')
  assert.equal(bridgeNavigation({ url: `${SRC}#x`, isTopFrame: true }, SRC, 'new'), 'fail')
})

test('bridgeNavigation: the source URL loads once, even while the page is still parsing', () => {
  // An inline <script>location.reload()</script> or location.href = location.href runs
  // before the first load ends; allowing it each time would request the bridge URL in a loop.
  for (const navigationType of ['reload', 'other']) {
    assert.equal(bridgeNavigation({ url: SRC, isTopFrame: true, navigationType }, SRC, 'loading'), 'leave', navigationType)
    assert.equal(bridgeNavigation({ url: SRC.replace('totem.example.com', 'TOTEM.example.com:443'), isTopFrame: true, navigationType }, SRC, 'loading'), 'leave', navigationType)
  }
  assert.equal(bridgeNavigation({ url: `${SRC}#x`, isTopFrame: true, navigationType: 'reload' }, SRC, 'loading'), 'leave')
  // A #hash jump is the same document.
  assert.equal(bridgeNavigation({ url: `${SRC}#top`, isTopFrame: true, navigationType: 'other' }, SRC, 'loading'), 'allow')
  // Anywhere else before the page loaded is a redirect (Access's sign-in) or an escape: stopped as a failure.
  assert.equal(bridgeNavigation({ url: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/totem.example.com', isTopFrame: true }, SRC, 'loading'), 'fail')
  assert.equal(bridgeNavigation({ url: 'https://evil.example/?d=1', isTopFrame: true }, SRC, 'loading'), 'fail')
  // The phases the component steps through: one allow, then every repeat is refused.
  let phase = 'new'
  const decide = (req) => { const d = bridgeNavigation(req, SRC, phase); if (d === 'allow' && phase === 'new') phase = 'loading'; return d }
  assert.deepEqual([1, 2, 3].map(() => decide({ url: SRC, isTopFrame: true, navigationType: 'other' })), ['allow', 'leave', 'leave'])
})

test('bridgeNavigation: after the first load the page may not leave', () => {
  const after = (req) => bridgeNavigation(req, SRC, 'loaded')
  assert.equal(after({ url: `${SRC}#section`, isTopFrame: true, navigationType: 'click' }), 'allow')
  assert.equal(after({ url: `${SRC}#x`, isTopFrame: true, navigationType: 'reload' }), 'leave')
  assert.equal(after({ url: 'tel:123', isTopFrame: true }), 'leave')
  assert.equal(after({ url: 'data:text/html,hi', isTopFrame: true }), 'leave')
  assert.equal(after({ url: 'about:blank', isTopFrame: false }), 'allow')
  assert.equal(after({ url: 'https://evil.example/', isTopFrame: false }), 'block')
  assert.equal(bridgeNavigation({ url: 'https://evil.example/', isTopFrame: false }, SRC, 'new'), 'block')
})

test('pageHeightFrom takes a size report and nothing else', () => {
  assert.equal(pageHeightFrom(JSON.stringify({ type: 'totem-visual:size', height: 412.2 })), 413)
  assert.equal(pageHeightFrom(JSON.stringify({ type: 'totem-visual:size', height: 10 })), 80)
  assert.equal(pageHeightFrom(JSON.stringify({ type: 'totem-visual:size', height: 1e9 })), 8000)
  assert.equal(pageHeightFrom(JSON.stringify({ type: 'totem-visual:open', url: 'https://evil.example' })), null)
  for (const bad of [null, 42, { type: 'totem-visual:size', height: 300 }, 'not json', '{"type":"totem-visual:size","height":-1}', `{"type":"totem-visual:size","height":300,"pad":"${'x'.repeat(300)}"}`]) {
    assert.equal(pageHeightFrom(bad), null, String(bad).slice(0, 40))
  }
})

test('linkOpensOutside opens http(s) links to other sites only', () => {
  assert.ok(linkOpensOutside('https://en.wikipedia.org/wiki/Chart', BASE))
  assert.ok(linkOpensOutside('http://example.org', BASE))
  assert.ok(!linkOpensOutside(`${BASE}/api/todos`, BASE))
  assert.ok(!linkOpensOutside('https://TOTEM.example.com:443/settings', BASE))
  assert.ok(!linkOpensOutside('javascript:alert(1)', BASE))
  assert.ok(!linkOpensOutside('tel:123', BASE))
  assert.ok(!linkOpensOutside(`https://a.example/${'x'.repeat(5000)}`, BASE))
})

test('PAGE_HEIGHT_SCRIPT posts the page height as the chart bootstrap measures it, and only that', () => {
  const posted = []
  let observed = 0
  const listeners = {}
  const html = { scrollHeight: 300, clientHeight: 300, getBoundingClientRect: () => ({ height: 241.4 }) }
  const win = {
    ReactNativeWebView: { postMessage: (m) => posted.push(m) },
    ResizeObserver: class { constructor(fn) { this.fn = fn } observe() { observed++ } },
    addEventListener: (t, f) => { listeners[t] = f },
  }
  vm.runInNewContext(PAGE_HEIGHT_SCRIPT, { window: win, document: { documentElement: html, body: {} }, JSON, Math })
  assert.equal(observed, 2)
  assert.deepEqual(posted.map((m) => pageHeightFrom(m)), [242])
  html.scrollHeight = 900
  listeners.load()
  listeners.load()
  assert.deepEqual(posted.map((m) => pageHeightFrom(m)), [242, 900])
  assert.ok(posted.every((m) => Object.keys(JSON.parse(m)).join() === 'type,height'))
  assert.doesNotThrow(() => vm.runInNewContext(PAGE_HEIGHT_SCRIPT, { window: {}, document: {} }))
})
