// node --test chat/favicon.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchFavicon, iconLinks, siteUrl, sniffImage } from './favicon.mjs'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const ICO = Buffer.from([0, 0, 1, 0, 1, 0])

function fakeFetch(routes) {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    const hit = routes[url]
    if (!hit) return new Response('nope', { status: 404 })
    return new Response(hit.body, { status: 200, headers: { 'content-type': hit.type || 'text/html' } })
  }
  return { impl, calls }
}

test('siteUrl takes a bare domain and refuses other schemes', () => {
  assert.equal(siteUrl('example.app').href, 'https://example.app/')
  assert.equal(siteUrl('http://x.test/a').href, 'http://x.test/a')
  assert.equal(siteUrl('file:///etc/passwd'), null)
  assert.equal(siteUrl('javascript:alert(1)'), null)
  assert.equal(siteUrl(''), null)
})

test('iconLinks puts apple-touch-icon and bigger sizes first and skips SVG', () => {
  const html = `<link rel="icon" href="/f16.png" sizes="16x16"><link rel='icon' type="image/svg+xml" href="/i.svg">
    <link href="/f64.png" rel="shortcut icon" sizes="64x64"><link rel="apple-touch-icon" href="https://cdn.test/t.png"><link rel="stylesheet" href="/a.css">`
  assert.deepEqual(iconLinks(html, 'https://x.test/page'), ['https://cdn.test/t.png', 'https://x.test/f64.png', 'https://x.test/f16.png'])
})

test('sniffImage knows raster images and refuses HTML', () => {
  assert.equal(sniffImage(PNG), 'image/png')
  assert.equal(sniffImage(ICO), 'image/x-icon')
  assert.equal(sniffImage(Buffer.from('<!doctype html>')), null)
})

test('fetchFavicon takes the best linked icon that is really an image', async () => {
  const { impl } = fakeFetch({
    'https://example.app/': { body: '<link rel="apple-touch-icon" href="/soft404.png"><link rel="icon" href="/real.png">' },
    'https://example.app/soft404.png': { body: '<html>not here</html>' },
    'https://example.app/real.png': { body: PNG, type: 'image/png' },
  })
  const icon = await fetchFavicon('example.app', { fetchImpl: impl })
  assert.equal(icon.mime, 'image/png')
  assert.equal(icon.name, 'example.app-icon.png')
  assert.ok(icon.buffer.equals(PNG))
})

test('fetchFavicon falls back to /favicon.ico, and says so when there is nothing', async () => {
  const { impl } = fakeFetch({ 'https://www.x.test/': { body: '<p>hi</p>' }, 'https://www.x.test/favicon.ico': { body: ICO } })
  const icon = await fetchFavicon('www.x.test', { fetchImpl: impl })
  assert.equal(icon.name, 'x.test-icon.ico')
  const none = fakeFetch({ 'https://y.test/': { body: '<p>hi</p>' } })
  await assert.rejects(fetchFavicon('y.test', { fetchImpl: none.impl }), (e) => e.status === 422)
  await assert.rejects(fetchFavicon('ftp://z'), (e) => e.status === 400)
})
