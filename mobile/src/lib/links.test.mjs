// Where a tapped link in the iPhone app goes (links.ts), and which requests may
// carry the bridge's credentials. Run by the bridge's `npm test`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bridgePath, cacheFileName, classifyLink, fileNameOf, fileView, headProvesGone, headersFor, isBridgeUrl, originOf, uploadPath, webViewSource } from './links.ts'
import { notificationDestination } from '../features/notifications/destination.ts'

const BASE = 'https://totem.example.com'
const TAILNET = 'http://100.64.0.7:8787'
const at = (href, origins = [BASE]) => classifyLink(href, origins)

test('a link to another site opens outside the app', () => {
  assert.deepEqual(at('https://github.com/owner/repo/pull/1'), { kind: 'external', url: 'https://github.com/owner/repo/pull/1' })
  assert.deepEqual(at('http://example.org'), { kind: 'external', url: 'http://example.org' })
  // Protocol-relative: another site too.
  assert.deepEqual(at('//example.org/x'), { kind: 'external', url: 'https://example.org/x' })
})

test('a host that only looks like the bridge is another site', () => {
  assert.equal(at('https://totem.example.com.evil.net/api/chat/uploads/a').kind, 'external')
  // Userinfo or a backslash: nothing to open, and above all never the bridge.
  assert.equal(at('https://totem.example.com@evil.net/api/x'), null)
  assert.equal(at('https://evil.net\\@totem.example.com/api/x'), null)
  assert.equal(at('http://totem.example.com/api/x').kind, 'external', 'http is not the https bridge')
  assert.equal(at('http://100.64.0.7:8788/api/x', [TAILNET]).kind, 'external', 'another port is another origin')
})

test('a signed upload or other /api path opens inside the app', () => {
  assert.deepEqual(at('/api/chat/uploads/u_123abc?sig=xyz'), { kind: 'resource', path: '/api/chat/uploads/u_123abc?sig=xyz' })
  assert.deepEqual(at('https://TOTEM.example.com:443/api/chat/uploads/u_1?sig=s#frag'), { kind: 'resource', path: '/api/chat/uploads/u_1?sig=s' })
  assert.deepEqual(at('http://100.64.0.7:8787/api/chat/uploads/u_2', [TAILNET]), { kind: 'resource', path: '/api/chat/uploads/u_2' })
})

test('an absolute path on the box is a file, as the web Files panel opens it', () => {
  assert.deepEqual(at('/home/owner/out/report.pdf'), { kind: 'file', path: '/home/owner/out/report.pdf' })
  assert.deepEqual(at('/Users/owner/Notes/a%20b.md'), { kind: 'file', path: '/Users/owner/Notes/a b.md' })
  // A `#` is part of a bare path, as on the web (web/src/links.ts).
  assert.deepEqual(at('/home/owner/C#/notes.md'), { kind: 'file', path: '/home/owner/C#/notes.md' })
  assert.deepEqual(at('file:///Users/owner/x.png'), { kind: 'file', path: '/Users/owner/x.png' })
  assert.deepEqual(at('https://totem.example.com/home/owner/x.csv'), { kind: 'file', path: '/home/owner/x.csv' })
  // The raw-file URL and the web's ?file= redirect name a file; the app signs it again.
  assert.deepEqual(at('/api/chat/files/raw?path=%2Fhome%2Fowner%2Fx.pdf&exp=1&sig=2'), { kind: 'file', path: '/home/owner/x.pdf' })
  assert.deepEqual(at('/chat?file=%2Ftmp%2Fout.zip'), { kind: 'file', path: '/tmp/out.zip' })
  // Outside the folders an agent writes to: nothing to open.
  assert.equal(at('file:///etc/passwd'), null)
})

test('a dashboard page opens the app screen for it', () => {
  assert.deepEqual(at('/productivity/todos'), { kind: 'app', path: '/productivity/todos' })
  assert.deepEqual(at('/chat?thread=t1'), { kind: 'app', path: '/chat?thread=t1' })
  // A link the bridge built on PUBLIC_URL is the bridge too, once that address is known.
  assert.equal(at('https://public.example.net/inbox#P3').kind, 'external')
  assert.deepEqual(at('https://public.example.net/inbox#P3', [TAILNET, 'https://public.example.net']), { kind: 'app', path: '/inbox#P3' })
})

test('mailto:, tel: and sms: go to the system, not to the markdown library', () => {
  assert.deepEqual(at('mailto:owner@example.com'), { kind: 'system', url: 'mailto:owner@example.com' })
  assert.deepEqual(at('tel:+15555550100'), { kind: 'system', url: 'tel:+15555550100' })
  assert.deepEqual(at('SMS:+15555550100'), { kind: 'system', url: 'SMS:+15555550100' })
})

test('nothing to open: anchors, scripts, bare names', () => {
  for (const href of ['', '#top', 'javascript:alert(1)', 'data:text/html,hi', 'report.md', './out/x.pdf', 'ftp://example.org/x']) {
    assert.equal(at(href), null, href)
  }
})

test('credentials go to the bridge origin only', () => {
  const creds = { Authorization: 'Bearer s3cret', 'cf-access-token': 'jwt' }
  assert.deepEqual(headersFor('https://totem.example.com/api/chat/uploads/u?sig=1', BASE, creds), creds)
  assert.deepEqual(headersFor('https://totem.example.com:443/x', BASE, creds), creds)
  for (const url of [
    'https://cdn.example.org/pic.png',
    'https://totem.example.com.evil.net/x',
    'https://totem.example.com@evil.net/x',
    'https://evil.net\\@totem.example.com/x',
    'http://totem.example.com/x',
    'https://totem.example.com:8443/x',
    '/api/relative',
    'file:///Users/owner/x',
  ]) {
    assert.deepEqual(headersFor(url, BASE, creds), {}, url)
    assert.equal(isBridgeUrl(url, BASE), false, url)
  }
  // No bridge configured: nothing is the bridge.
  assert.deepEqual(headersFor('https://totem.example.com/x', '', creds), {})
})

test('origins compare in canonical form', () => {
  assert.equal(originOf('HTTPS://Totem.Example.com:443/a?b'), 'https://totem.example.com')
  assert.equal(originOf('http://h:80'), 'http://h')
  assert.equal(originOf('http://[::1]:8787/x'), 'http://[::1]:8787')
  assert.equal(originOf('mailto:x@y'), null)
})

test('an authority iOS and WHATWG could read differently has no origin at all', () => {
  for (const url of [
    'https://totem.example.com\\@evil.net/x',
    'https://evil.net\\@totem.example.com/x',
    'https://x@totem.example.com/x',
    'https://totem%2eexample.com/x',
    'https://totem.example.com%40evil.net/x',
    'https://totem .example.com/x',
    'https://totem.example.com\t/x',
    ' https://totem.example.com/x',
    'https://totem.example.com:/x',
    'https://totem_example.com/x',
    'https:///x',
  ]) {
    assert.equal(originOf(url), null, JSON.stringify(url))
    assert.equal(isBridgeUrl(url, BASE), false, JSON.stringify(url))
    assert.notEqual(at(url)?.kind, 'resource', JSON.stringify(url))
  }
})

test('a notification link reads origins the same way', () => {
  assert.equal(notificationDestination('https://evil.net\\@totem.example.com/inbox', [BASE]).kind, 'external')
  assert.equal(notificationDestination('https://x@totem.example.com/inbox', [BASE]).kind, 'external')
  assert.equal(notificationDestination('/\\evil.net/x', [BASE]).kind, 'external')
  assert.equal(notificationDestination('https://totem.example.com/inbox#P1', [BASE]).kind, 'inbox')
})

test('a doubled slash after the bridge never becomes another site', () => {
  assert.deepEqual(at('https://totem.example.com//evil.net/x'), { kind: 'app', path: '/evil.net/x' })
  assert.deepEqual(at('https://totem.example.com//api/chat/uploads/u_1'), { kind: 'resource', path: '/api/chat/uploads/u_1' })
  assert.equal(at('/\\evil.net/x').kind, 'external', 'WHATWG reads /\\host as another site')
  // What the app then opens stays on the bridge.
  assert.notEqual(notificationDestination(at('https://totem.example.com//evil.net/x').path, [BASE]).kind, 'external')
})

test('the viewer and the file sheet take only a bridge path from their route params', () => {
  assert.equal(bridgePath('/api/chat/uploads/u_123abcd?sig=x'), '/api/chat/uploads/u_123abcd?sig=x')
  assert.equal(bridgePath('/api/chat/files/raw?path=%2Fhome%2Fo%2Fr.pdf&exp=1&sig=2'), '/api/chat/files/raw?path=%2Fhome%2Fo%2Fr.pdf&exp=1&sig=2')
  for (const p of ['https://evil.net/x.pdf', 'https://totem.example.com/api/x', '//evil.net/x', '/\\evil.net', 'javascript:alert(1)', 'api/x', '', undefined, '/a b']) {
    assert.equal(bridgePath(p), null, String(p))
  }
  assert.equal(uploadPath('u_123abcd'), '/api/chat/uploads/u_123abcd')
  assert.equal(uploadPath('../../api/x'), null)
  assert.equal(uploadPath(undefined), null)
})

test('a 404 means gone only for a file route', () => {
  assert.equal(headProvesGone('/api/chat/uploads/u_123abcd?sig=x', 404), true)
  assert.equal(headProvesGone('/api/chat/files/raw?path=%2Fx&exp=1&sig=2', 404), true)
  assert.equal(headProvesGone('/api/chat/uploads/u_123abcd', 200), false)
  // Another /api route may not answer HEAD at all.
  assert.equal(headProvesGone('/api/journal/audio/1', 404), false)
})

test('a downloaded file gets a name the cache can hold', () => {
  for (const bad of ['', '.', '..', '  ']) assert.equal(cacheFileName(bad), 'file', JSON.stringify(bad))
  assert.equal(cacheFileName('a/b\\c:d.pdf'), 'a_b_c_d.pdf')
  assert.equal(cacheFileName('report.pdf'), 'report.pdf')
})

test('how each file kind is shown', () => {
  assert.equal(fileView('notes.md', ''), 'text')
  assert.equal(fileView('data.csv', 'text/csv'), 'text')
  assert.equal(fileView('x', 'application/json'), 'text')
  assert.equal(fileView('photo.png', ''), 'image')
  assert.equal(fileView('x', 'image/jpeg'), 'image')
  assert.equal(fileView('report.pdf', 'application/pdf'), 'pdf')
  assert.equal(fileView('page.html', ''), 'html')
  assert.equal(fileView('x', 'text/html'), 'html', 'not read as text')
  assert.equal(fileView('logo.svg', 'image/svg+xml'), 'html', 'an SVG can run script: never drawn as a picture by URL')
  assert.equal(fileView('bundle.zip', 'application/zip'), 'save')
  assert.equal(fileView('deck.pptx', ''), 'save')
  assert.equal(fileNameOf('/api/chat/files/raw?path=x'), 'raw')
  assert.equal(fileNameOf('/home/owner/a%20b.pdf'), 'a b.pdf')
})

test('the web view loads only a PDF, only from the bridge, only once the bridge says it is one', () => {
  const pdf = 'https://totem.example.com/api/chat/files/raw?path=%2Fhome%2Fo%2Fr.pdf&exp=1&sig=2'
  assert.equal(webViewSource('pdf', pdf, BASE, 'application/pdf'), pdf)
  assert.equal(webViewSource('pdf', pdf, BASE, 'Application/PDF; charset=binary'), pdf)
  assert.equal(webViewSource('pdf', 'https://evil.net/r.pdf', BASE, 'application/pdf'), null)
  assert.equal(webViewSource('pdf', 'https://evil.net\\@totem.example.com/r.pdf', BASE, 'application/pdf'), null)
  // A name can lie: the bridge's HEAD decides.
  assert.equal(webViewSource('pdf', pdf, BASE, 'text/html'), null)
  assert.equal(webViewSource('pdf', pdf, BASE, ''), null)
  // An HTML or SVG file would run as a page on the bridge's origin.
  assert.equal(webViewSource('html', 'https://totem.example.com/api/chat/uploads/u?sig=1', BASE, 'application/pdf'), null)
  for (const view of ['text', 'image', 'save']) assert.equal(webViewSource(view, pdf, BASE, 'application/pdf'), null, view)
  for (const name of ['x.html.pdf', 'x.HTML', 'x.xhtml', 'x.svgz', 'x.svg.pdf']) assert.equal(fileView(name, ''), 'html', name)
})

