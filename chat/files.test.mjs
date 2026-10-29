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
