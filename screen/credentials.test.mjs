import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCredentialSealer } from './credentials.mjs'

const dir = () => mkdtemp(join(tmpdir(), 'screen-creds-'))

test('a sealed login opens again before it expires', async () => {
  let t = 1_000_000
  const keyFile = join(await dir(), 'k')
  const s = createCredentialSealer({ keyFile, now: () => t })
  const { token, expiresAt } = await s.seal({ username: 'me', password: 'hunter2', minutes: 30 })
  assert.equal(expiresAt, new Date(1_000_000 + 30 * 60_000).toISOString())
  assert.ok(!token.includes('hunter2'))
  t += 29 * 60_000
  assert.deepEqual(await s.open(token), { username: 'me', password: 'hunter2', expiresAt })
})

test('the key file is created once, private, and survives a restart', async () => {
  const keyFile = join(await dir(), 'data', 'k')
  const { token } = await createCredentialSealer({ keyFile }).seal({ password: 'pw', minutes: 60 })
  assert.equal((await stat(keyFile)).mode & 0o777, 0o600)
  const again = createCredentialSealer({ keyFile })
  assert.equal((await again.open(token)).password, 'pw')
  assert.equal((await again.open(token)).username, undefined)
})

test('expired, tampered and foreign tokens are all 410', async () => {
  let t = 0
  const keyFile = join(await dir(), 'k')
  const s = createCredentialSealer({ keyFile, now: () => t })
  const { token } = await s.seal({ password: 'pw', minutes: 30 })
  const parts = token.split('.')
  const flipped = Buffer.from(parts[3], 'base64url'); flipped[0] ^= 1
  await assert.rejects(s.open([...parts.slice(0, 3), flipped.toString('base64url')].join('.')), (e) => e.status === 410)
  await assert.rejects(s.open('garbage'), (e) => e.status === 410)
  const other = createCredentialSealer({ keyFile: join(await dir(), 'k') })
  await assert.rejects(other.open(token), (e) => e.status === 410)
  t += 30 * 60_000
  await assert.rejects(s.open(token), (e) => e.status === 410 && /expired/.test(e.message))
})

test('deleting the key forgets every remembered login', async () => {
  const keyFile = join(await dir(), 'k')
  const { token } = await createCredentialSealer({ keyFile }).seal({ password: 'pw', minutes: 300 })
  await rm(keyFile)
  await assert.rejects(createCredentialSealer({ keyFile }).open(token), (e) => e.status === 410)
})

test('only the offered durations, and a password, are accepted', async () => {
  const s = createCredentialSealer({ keyFile: join(await dir(), 'k') })
  await assert.rejects(s.seal({ password: 'pw', minutes: 301 }), (e) => e.status === 400)
  await assert.rejects(s.seal({ password: 'pw', minutes: 600 }), (e) => e.status === 400)
  await assert.rejects(s.seal({ password: '', minutes: 30 }), (e) => e.status === 400)
  for (const minutes of [30, 60, 120, 300]) assert.ok((await s.seal({ password: 'pw', minutes })).token)
})
