import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createFileAccess, chatFileRedirect, mimeFor } from './files.mjs'

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'totem-files-')))
  const data = join(home, 'data')
  const outputs = join(data, 'chat-outputs')
  await mkdir(join(outputs, 'thread-1', 'sub'), { recursive: true })
  await writeFile(join(outputs, 'thread-1', 'report.xlsx'), 'xlsx')
  await writeFile(join(outputs, 'thread-1', 'sub', 'notes.md'), '# hi')
  await writeFile(join(data, 'auth.json'), '{"secret":1}')
  await symlink(join(data, 'auth.json'), join(outputs, 'thread-1', 'sneaky.json'))
  const access = createFileAccess({ roots: [outputs], deny: [data] })
  return { home, data, outputs, access }
}

test('lists a chat folder as a tree and refuses a symlink out of it', async () => {
  const { home, outputs, access } = await fixture()
  try {
    const { entries } = await access.list(join(outputs, 'thread-1'))
    assert.deepEqual(entries.map((e) => e.rel), ['sub', 'sub/notes.md', 'report.xlsx'])
    assert.equal(entries.find((e) => e.rel === 'report.xlsx').mime, mimeFor('x.xlsx'))
    await assert.rejects(access.resolve(join(outputs, 'thread-1', 'sneaky.json')), { status: 403 })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('refuses paths outside the roots, inside denied data, and relative paths', async () => {
  const { home, data, outputs, access } = await fixture()
  try {
    await assert.rejects(access.resolve(join(data, 'auth.json')), { status: 403 })
    await assert.rejects(access.resolve(join(outputs, 'thread-1', '..', '..', 'auth.json')), { status: 403 })
    await assert.rejects(access.resolve('/etc/passwd'), { status: 403 })
    await assert.rejects(access.resolve('report.xlsx'), { status: 400 })
    await assert.rejects(access.resolve(join(outputs, 'nope.txt')), { status: 404 })
    assert.equal(await access.resolve(`file://${join(outputs, 'thread-1', 'report.xlsx')}`), join(outputs, 'thread-1', 'report.xlsx'))
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('serves a spreadsheet as a download', async () => {
  const { home, outputs, access } = await fixture()
  try {
    const res = Object.assign(new PassThrough(), { headers: null, writeHead(code, h) { this.code = code; this.headers = h } })
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    await access.serve(res, join(outputs, 'thread-1', 'report.xlsx'))
    assert.equal(res.code, 200)
    assert.match(res.headers['content-disposition'], /^attachment; filename="report.xlsx"/)
    assert.equal(Buffer.concat(chunks).toString(), 'xlsx')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('a download preflight returns file headers without reading a body', async () => {
  const { home, outputs, access } = await fixture()
  try {
    const res = Object.assign(new PassThrough(), { headers: null, writeHead(code, h) { this.code = code; this.headers = h } })
    let bytes = 0
    res.on('data', (c) => { bytes += c.length })
    await access.serve(res, join(outputs, 'thread-1', 'report.xlsx'), { head: true })
    assert.equal(res.headers['content-length'], 4)
    assert.match(res.headers['content-disposition'], /report.xlsx/)
    assert.equal(bytes, 0)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('a cancelled download releases its stream and settles the request', { timeout: 2000 }, async () => {
  const { home, outputs, access } = await fixture()
  try {
    const res = Object.assign(new PassThrough(), { writeHead() { queueMicrotask(() => this.destroy()) } })
    await access.serve(res, join(outputs, 'thread-1', 'report.xlsx'))
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('a chat-output path redirects to its chat; anything else does not', () => {
  const dir = '/Users/owner/apps/totem/data/chat-outputs'
  assert.equal(
    chatFileRedirect('/Users/owner/apps/totem/data/chat-outputs/f94b05ee-6fa9/OWU%20-%20x.xlsx', dir),
    `/chat?thread=f94b05ee-6fa9&file=${encodeURIComponent(`${dir}/f94b05ee-6fa9/OWU - x.xlsx`)}`,
  )
  assert.equal(chatFileRedirect('/Users/owner/apps/totem/data/auth.json', dir), null)
  assert.equal(chatFileRedirect('/chat', dir), null)
  assert.equal(chatFileRedirect('/%E0%A4%A', dir), null)
})

// A signed link is how every opener reads a file: the canvas's fetch, an <iframe>,
// an <img>, the desktop app's native download. Those carry no bearer header.
const linkParams = (url) => { const q = new URL(url, 'http://x').searchParams; return [q.get('path'), q.get('exp'), q.get('sig')] }

test('link() signs one real path for a while; the signature opens only that path, unexpired', async () => {
  const { home, outputs } = await fixture()
  let clock = 1_000_000
  const access = createFileAccess({ roots: [outputs], deny: [join(home, 'data')], key: Buffer.from('k'), now: () => clock, ttlMs: 60_000 })
  try {
    const file = join(outputs, 'thread-1', 'sub', 'notes.md')
    const link = await access.link(file)
    assert.equal(link.path, file)
    assert.equal(link.name, 'notes.md')
    assert.equal(link.mime, 'text/markdown')
    assert.match(link.url, /^\/api\/chat\/files\/raw\?path=[^&]+&exp=\d+&sig=[\w-]{43}$/)
    const [path, exp, sig] = linkParams(link.url)
    assert.equal(path, file)
    assert.equal(access.verify(path, exp, sig), true)
    // Another path, another expiry, an altered signature, another key: all refused.
    assert.equal(access.verify(join(outputs, 'thread-1', 'report.xlsx'), exp, sig), false)
    assert.equal(access.verify(path, String(Number(exp) + 1), sig), false)
    assert.equal(access.verify(path, exp, sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A')), false)
    assert.equal(access.verify(path, exp, ''), false)
    assert.equal(access.verify(path, 'soon', sig), false)
    assert.equal(access.verify(null, exp, sig), false)
    const other = createFileAccess({ roots: [outputs], key: Buffer.from('other'), now: () => clock, ttlMs: 60_000 })
    assert.equal(other.verify(path, exp, sig), false)
    // A genuine signature whose expiry lies past this TTL (same key, longer TTL) was never minted here.
    const longer = createFileAccess({ roots: [outputs], deny: [join(home, 'data')], key: Buffer.from('k'), now: () => clock, ttlMs: 60_001 })
    const far = linkParams((await longer.link(file)).url)
    assert.equal(longer.verify(...far), true)
    assert.equal(access.verify(...far), false)
    clock += 60_001
    assert.equal(access.verify(path, exp, sig), false)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('link() refuses what resolve() refuses, and folders', async () => {
  const { home, data, outputs, access } = await fixture()
  try {
    await assert.rejects(access.link(join(data, 'auth.json')), { status: 403 })
    await assert.rejects(access.link(join(outputs, 'thread-1', 'sneaky.json')), { status: 403 })
    await assert.rejects(access.link('/etc/passwd'), { status: 403 })
    await assert.rejects(access.link(join(outputs, 'thread-1')), { status: 400 })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('a signed read refuses a path that is no longer its own real path', async () => {
  const { home, outputs, access } = await fixture()
  try {
    await mkdir(join(outputs, 'thread-2'))
    await writeFile(join(outputs, 'thread-2', 'a.txt'), 'a')
    await symlink(join(outputs, 'thread-2'), join(outputs, 'alias'))
    const res = Object.assign(new PassThrough(), { writeHead(code) { this.code = code } })
    // Signed for the real path it was: still served.
    await access.serve(res, join(outputs, 'thread-2', 'a.txt'), { signed: true })
    assert.equal(res.code, 200)
    // Reached through a symlink: the signed path is not the file's real path.
    await assert.rejects(access.serve(new PassThrough(), join(outputs, 'alias', 'a.txt'), { signed: true }), { status: 403 })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('a file shown on its own is sandboxed, except a PDF; a download is not shown', async () => {
  const { home, outputs, access } = await fixture()
  try {
    await writeFile(join(outputs, 'thread-1', 'a.txt'), 'a')
    await writeFile(join(outputs, 'thread-1', 'a.pdf'), '%PDF')
    await writeFile(join(outputs, 'thread-1', 'a.html'), '<script>1</script>')
    const headers = async (name, opts = {}) => {
      const res = Object.assign(new PassThrough(), { writeHead(code, h) { this.headers = h } })
      res.resume()
      await access.serve(res, join(outputs, 'thread-1', name), opts)
      return res.headers
    }
    assert.equal((await headers('a.txt'))['content-security-policy'], 'sandbox')
    assert.equal((await headers('a.pdf'))['content-security-policy'], undefined)
    assert.match((await headers('a.pdf'))['content-disposition'], /^inline/)
    const html = await headers('a.html')
    assert.match(html['content-disposition'], /^attachment/)
    assert.equal(html['x-content-type-options'], 'nosniff')
  } finally { await rm(home, { recursive: true, force: true }) }
})
