// "Remember for 30 minutes … 5 hours" on the Screen view's Mac login.
//
// The browser never keeps the password. The bridge seals {username, password,
// expiresAt} with AES-256-GCM under a key that stays on this machine
// (data/screen-credentials.key, 0600) and hands back only the sealed token,
// which the browser stores. To reconnect, the browser sends the token back and
// a signed-in request gets the login out, until expiresAt.
//
// So a copy of the browser's storage is useless without this machine, and this
// machine holds nothing to steal without the browser's token. Deleting the key
// file forgets every remembered login at once.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

export const REMEMBER_MINUTES = [30, 60, 120, 300]
const VERSION = 'v1'
const AAD = Buffer.from('totem.screen.credentials.v1')

export class CredentialsError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

export function createCredentialSealer({ keyFile, now = () => Date.now() }) {
  let keyPromise = null

  async function loadKey() {
    try {
      const raw = Buffer.from((await readFile(keyFile, 'utf8')).trim(), 'base64')
      if (raw.length === 32) return raw
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e
    }
    const key = randomBytes(32)
    await mkdir(dirname(keyFile), { recursive: true })
    const tmp = `${keyFile}.tmp`
    await writeFile(tmp, key.toString('base64') + '\n', { mode: 0o600 })
    await rename(tmp, keyFile)
    await chmod(keyFile, 0o600).catch(() => {})
    return key
  }
  const key = () => (keyPromise ||= loadKey().catch((e) => { keyPromise = null; throw e }))

  /** Seal a login for `minutes` (one of REMEMBER_MINUTES). Returns {token, expiresAt}. */
  async function seal({ username, password, minutes }) {
    if (typeof password !== 'string' || !password) throw new CredentialsError('password is required')
    if (username != null && typeof username !== 'string') throw new CredentialsError('username must be a string')
    const mins = Number(minutes)
    if (!REMEMBER_MINUTES.includes(mins)) throw new CredentialsError(`minutes must be one of ${REMEMBER_MINUTES.join(', ')}`)
    const expiresAt = now() + mins * 60_000
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', await key(), iv)
    cipher.setAAD(AAD)
    const body = Buffer.concat([cipher.update(JSON.stringify({ u: username || undefined, p: password, e: expiresAt }), 'utf8'), cipher.final()])
    const token = [VERSION, iv, cipher.getAuthTag(), body].map((part) => typeof part === 'string' ? part : part.toString('base64url')).join('.')
    return { token, expiresAt: new Date(expiresAt).toISOString() }
  }

  /** The login inside a token, or a 410 when it is expired, forged or from a replaced key. */
  async function open(token) {
    const parts = String(token || '').split('.')
    if (parts.length !== 4 || parts[0] !== VERSION) throw new CredentialsError('not a remembered login', 410)
    let payload
    try {
      const [iv, tag, body] = parts.slice(1).map((p) => Buffer.from(p, 'base64url'))
      const decipher = createDecipheriv('aes-256-gcm', await key(), iv)
      decipher.setAAD(AAD)
      decipher.setAuthTag(tag)
      payload = JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'))
    } catch {
      throw new CredentialsError('not a remembered login', 410)
    }
    if (!(payload?.e > now())) throw new CredentialsError('the remembered login has expired', 410)
    return { ...(payload.u ? { username: payload.u } : {}), password: payload.p, expiresAt: new Date(payload.e).toISOString() }
  }

  return { seal, open }
}
