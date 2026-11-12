// The approval code: a second credential that a caller holding only the bearer
// secret does not have.
//
// Every agent CLI runs as the bridge's user, so it can read `.env` and with it
// BRIDGE_SECRET, and the bearer secret passes the API gate. Without a second
// credential, an agent following an injected instruction could accept its own
// email, message, prompt or command proposal with one curl. The approval code is
// that credential: a random code shown once, kept by the owner's devices (the
// browser's localStorage, the iPhone's keychain), and sent as a header on the
// routes that confer approval. The bridge stores only a salted HMAC-SHA256 of it
// (data/approval-code.json, 0600), so reading the file teaches an agent nothing:
// the code is 100 random bits, so a slow hash (scrypt, as a password needs) adds
// nothing, and a fast one means a flood of wrong codes never makes a right one wait.
//
// What it does not stop: an agent that can write data/ can replace the hash with
// one for a code of its own. That cannot be closed for an agent running as the
// same user, so it is made loud and not instant. The record Totem set is held in
// memory and checked against the file on every use; any difference refuses every
// high-risk approval, notifies the owner and writes the action log, until the
// owner sets a new code. The record's id and the install decision are kept in a
// second place, data/auth.json, and compared at boot, so a restart into a
// replaced file or a downgrade to `legacy` is caught too. Deleting both files and
// forging the rest is the case nothing here detects; docs/self-hosting.md lists
// what stays open.
//
// It is set from the dashboard after re-entering the password, or from a CLI that
// refuses to run without a terminal and asks for the password
// (auth/approval-code-cli.mjs). A code set by the CLI is loaded at the next start:
// to the running bridge, a file it did not write looks like tampering.
//
// States:
//   armed     a code is set: high-risk approvals need it.
//   missing   a code was set and its file is gone or empty: high-risk approvals
//             are refused until a new code is set.
//   tampered  the file (or its copy in auth.json) differs from what Totem set:
//             refused like `missing`, and the owner is told.
//   legacy    an install that predates the code, none set yet: the signed-in
//             session alone still approves, as before. Setting a code ends this.
//   unset     a fresh install, none set yet: high-risk approvals are refused until
//             one is, so a new install is never in the weak state.
// The bearer secret alone never approves anything, in any state.
//
// The idea of a second "decider" credential, a TTY-only setter and the latch comes
// from github.com/mattabate/life-distributable (MIT, (c) Matt Abate).

import { createHash, createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { clientKey } from './owner.mjs'

const scrypt = promisify(scryptCb)

export const APPROVAL_CODE_HEADER = 'x-totem-approval-code'
export const APPROVAL_STATES = Object.freeze(['armed', 'missing', 'tampered', 'legacy', 'unset'])
// The install decision: `existing` starts in `legacy`, `fresh` in `unset`.
const INSTALLS = new Set(['existing', 'fresh'])

const ALGO = 'hmac-sha256'
// Records written before the switch to HMAC (unmerged builds only) used scrypt.
// One is accepted on its first correct code and rewritten in the new form.
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32 })
// Crockford's base32: no I, L, O or U, so a code read off one screen and typed on
// another has nothing to confuse. 20 characters is 100 bits: nothing to guess,
// so the rate limit below is about CPU and noise, not about the search space.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 20
// Wrong codes tolerated per window, per client and credential, and in total.
// Past either, a wrong code is answered 429 instead of 403. A correct code is
// always checked and always accepted: the phone behind a local tunnel shares an
// agent's address and credential, so nothing an agent does to "its" budget may
// refuse the owner's code. Nothing here protects the search space (100 bits); the
// limits only make a stale device say so loudly.
const MAX_FAILURES = 5
const MAX_GLOBAL_FAILURES = 20
const MAX_TRACKED_CLIENTS = 1000
const FAILURE_WINDOW_MS = 15 * 60 * 1000

/** A request the approval gate refused: carries its HTTP status and a stable code. */
export class ApprovalRefused extends Error {
  constructor(code, message, status = 403) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** A new code, grouped in fives for reading aloud: XXXXX-XXXXX-XXXXX-XXXXX. */
export function newApprovalCode() {
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    if (i && i % 5 === 0) out += '-'
    out += ALPHABET[randomInt(ALPHABET.length)]
  }
  return out
}

/** What the owner typed, as the canonical code: case, spaces and dashes ignored, O/I/L read as 0/1/1. */
export function normalizeApprovalCode(value) {
  return String(value || '').toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
}

// HMAC-SHA256 keyed by the record's own random salt: microseconds, no queue.
const hmacCode = (code, salt) => createHmac('sha256', salt).update(normalizeApprovalCode(code)).digest()

/** The verifier fields for a code. Exported so tests can write a file Totem did not. */
export function approvalCodeHash(code) {
  const salt = randomBytes(32)
  return { algo: ALGO, salt: salt.toString('base64'), hash: hmacCode(code, salt).toString('base64') }
}

/** An scrypt verifier, as builds before the HMAC switch wrote. For the upgrade test. */
export async function legacyScryptHash(code) {
  const salt = randomBytes(16)
  const key = await scrypt(normalizeApprovalCode(code), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
  return { salt: salt.toString('base64'), hash: key.toString('base64'), params: { ...SCRYPT } }
}

/** Does `presented` match this record? Constant-time either way. */
async function matches(record, presented) {
  const want = Buffer.from(record.hash, 'base64')
  const got = record.algo === ALGO
    ? hmacCode(presented, Buffer.from(record.salt, 'base64'))
    : await scrypt(normalizeApprovalCode(presented), Buffer.from(record.salt, 'base64'), want.length || SCRYPT.keylen, { N: record.params?.N || SCRYPT.N, r: record.params?.r || SCRYPT.r, p: record.params?.p || SCRYPT.p })
  return got.length === want.length && timingSafeEqual(got, want)
}

const hasHash = (record) => Boolean(record && typeof record.hash === 'string' && record.hash && typeof record.salt === 'string' && record.salt)

/** Which hash this is, for comparing the file with the copy in auth.json. Not secret. */
export function approvalRecordId(record) {
  if (!hasHash(record)) return null
  return createHash('sha256').update(`${record.salt}:${record.hash}:${record.setAt || ''}`).digest('hex').slice(0, 32)
}

/**
 * @param {object} options
 * @param {string} options.file            data/approval-code.json
 * @param {{ read(): object|null, write(patch: object): Promise<object> }} options.policy
 *   The second copy: the install decision, the latch and the record id (data/auth.json).
 * @param {boolean} [options.existingInstall] This install predates the code.
 * @param {string}  [options.authMode]       'password' or 'proxy': the bridge records its own, for the CLI.
 * @param {(event: { kind: 'tampered'|'drift'|'legacy', reason: string }) => void} [options.report]
 *   Told once per distinct problem: the bridge notifies the owner and writes the log.
 * @param {Function} [options.now]
 * @param {Function} [options.log]
 */
export function createApprovalCode({ file, policy, existingInstall = false, authMode = null, report = () => {}, now = () => Date.now(), log = () => {} }) {
  if (!file) throw new Error('createApprovalCode needs a file')
  if (!policy?.read || !policy?.write) throw new Error('createApprovalCode needs a policy store')
  let ready = false
  let install = null
  let decidedAt = null
  let trusted = null        // the record Totem set or loaded at boot; the file must match it
  let latched = false       // a code has been set on this install, whatever the files say now
  let tamper = null         // { reason, at }: refused until the owner sets a new code
  const told = new Set()
  let failures = []
  const clientFailures = new Map()

  function tell(kind, reason) {
    const key = `${kind}:${reason}`
    if (told.has(key)) return
    told.add(key)
    log(`approval code: ${reason}`)
    try { report({ kind, reason }) } catch { /* reporting never blocks the gate */ }
  }

  function flag(reason) {
    if (!tamper) tamper = { reason, at: new Date(now()).toISOString() }
    tell('tampered', reason)
  }

  /** { value } for a JSON object; `emptied`/`unreadable` say why there is none. */
  async function readDisk() {
    let raw
    try { raw = await readFile(file, 'utf8') } catch { return { value: null } }
    if (!raw.trim()) return { value: null, emptied: true }
    try {
      const value = JSON.parse(raw)
      return value && typeof value === 'object' && !Array.isArray(value) ? { value } : { value: null, unreadable: true }
    } catch {
      return { value: null, unreadable: true }
    }
  }

  async function writeDisk(record) {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, file)
    await chmod(file, 0o600).catch(() => {})
  }

  /**
   * Load both copies and decide, once, what this install is. Each copy keeps the
   * install decision and the armed fact, and a disagreement takes the stricter
   * side and is reported: editing one file cannot downgrade the install.
   */
  async function init() {
    const { value: disk, unreadable, emptied } = await readDisk()
    const pol = policy.read() || {}
    const seen = [disk?.install, pol.install].filter((x) => INSTALLS.has(x))
    install = seen.length ? (seen.includes('fresh') ? 'fresh' : 'existing') : (existingInstall ? 'existing' : 'fresh')
    decidedAt = disk?.decidedAt || pol.decidedAt || new Date(now()).toISOString()
    if (seen.length === 2 && seen[0] !== seen[1]) flag('the install decision in data/approval-code.json and data/auth.json disagree')
    latched = Boolean(disk?.armedAt || hasHash(disk) || pol.armedAt || pol.recordId || emptied || unreadable)
    if (hasHash(disk)) {
      if (pol.recordId && pol.recordId === approvalRecordId(disk) && disk.install === install) trusted = disk
      else flag('the approval code file is not the one Totem last set')
    }
    // Latched with no date anywhere (both copies emptied) still records one, or the next boot would downgrade.
    const armedAt = trusted?.armedAt || pol.armedAt || disk?.armedAt || (latched ? new Date(now()).toISOString() : null)
    // The decision (and the armed fact) goes in both places. A hash file is never
    // rewritten here: a replaced one stays as it was found.
    if (!hasHash(disk) && !unreadable) {
      const next = { version: 2, install, decidedAt, ...(armedAt ? { armedAt } : {}) }
      if (JSON.stringify(next) !== JSON.stringify(disk)) await writeDisk(next)
    }
    const patch = {
      ...(pol.install !== install ? { install } : {}),
      ...(pol.decidedAt !== decidedAt ? { decidedAt } : {}),
      ...(authMode && pol.authMode !== authMode ? { authMode } : {}),
      ...(armedAt && !pol.armedAt ? { armedAt } : {}),
    }
    if (Object.keys(patch).length) await policy.write(patch)
    ready = true
    if (install === 'existing' && !latched && !pol.legacyNoticeAt) {
      tell('legacy', 'this install predates the approval code and has none set: a signed-in session alone still approves sends, commands and prompts')
      await policy.write({ legacyNoticeAt: new Date(now()).toISOString() })
    }
    await state()
  }

  /** The current state. Compares the file with the record held in memory every time. */
  async function state() {
    if (!ready) return { state: 'unset', setAt: null }
    if (upgrading) await upgrading.catch(() => {})
    if (tamper) return { state: 'tampered', setAt: null, reason: tamper.reason }
    const { value: disk } = await readDisk()
    if (trusted) {
      if (!hasHash(disk)) return { state: 'missing', setAt: null }
      if (approvalRecordId(disk) !== approvalRecordId(trusted) || disk.install !== trusted.install) {
        flag('the approval code file changed outside Totem')
        return { state: 'tampered', setAt: null, reason: tamper.reason }
      }
      const pol = policy.read() || {}
      if (pol.recordId !== approvalRecordId(trusted) || !pol.armedAt || pol.install !== install) {
        // The running bridge does not read this copy, so the edit changed nothing; put it back and say so.
        tell('drift', 'the approval code record in data/auth.json was edited outside Totem')
        await policy.write({ recordId: approvalRecordId(trusted), armedAt: trusted.armedAt, install })
      }
      return { state: 'armed', setAt: trusted.setAt || null }
    }
    if (hasHash(disk)) {
      flag('an approval code file appeared that Totem did not write')
      return { state: 'tampered', setAt: null, reason: tamper.reason }
    }
    if (latched) return { state: 'missing', setAt: null }
    if (disk && disk.install !== install) tell('drift', 'the install decision in data/approval-code.json was edited outside Totem')
    return { state: install === 'existing' ? 'legacy' : 'unset', setAt: null }
  }

  /** For the dashboard and the app: never the code or its hash. */
  async function status() {
    const { state: s, setAt, reason } = await state()
    return { state: s, setAt, header: APPROVAL_CODE_HEADER, ...(reason ? { reason } : {}) }
  }

  /** Make a new code and arm it. The caller has already confirmed the owner. Returns the code, once. */
  async function set() {
    if (!ready) await init()
    const code = newApprovalCode()
    const at = new Date(now()).toISOString()
    const armedAt = trusted?.armedAt || policy.read()?.armedAt || at
    const record = { version: 3, install, decidedAt, armedAt, setAt: at, ...approvalCodeHash(code) }
    await writeDisk(record)
    trusted = record
    latched = true
    tamper = null
    told.clear()
    await policy.write({ install, decidedAt, armedAt, setAt: at, recordId: approvalRecordId(record) })
    failures = []
    clientFailures.clear()
    log('approval code: set; devices holding the previous one must be given the new one')
    return { code, setAt: at }
  }

  const failureKey = (req, budget) => `${budget}:${clientKey(req)}`

  function recent(list) {
    const cutoff = now() - FAILURE_WINDOW_MS
    return list.filter((at) => at > cutoff)
  }

  function recordFailure(key) {
    const at = now()
    failures = [...recent(failures), at]
    const previous = recent(clientFailures.get(key) || [])
    clientFailures.delete(key)
    clientFailures.set(key, [...previous, at])
    while (clientFailures.size > MAX_TRACKED_CLIENTS) clientFailures.delete(clientFailures.keys().next().value)
  }

  // An scrypt record from before the HMAC switch, rewritten on its first correct
  // code. Same code, same dates; only the verifier and so the record id change.
  // `upgrading` holds every state() check until both copies agree again.
  let upgrading = null
  function upgrade(presented) {
    upgrading ||= (async () => {
      const record = { ...trusted, version: 3, ...approvalCodeHash(presented) }
      delete record.params
      await writeDisk(record)
      trusted = record
      await policy.write({ recordId: approvalRecordId(record) })
      log('approval code: verifier moved from scrypt to HMAC-SHA256')
    })().finally(() => { upgrading = null })
    return upgrading
  }

  /**
   * Does `presented` match the trusted record? A correct code is always accepted;
   * a wrong one returns false, or throws 429 once its client or everyone is past
   * the limit. Nothing waits in line: checking a code takes microseconds.
   */
  async function verify(req, presented, budget) {
    if (await matches(trusted, presented)) {
      if (trusted.algo !== ALGO && !upgrading) await upgrade(presented)
      return true
    }
    const key = failureKey(req, budget)
    recordFailure(key)
    if (recent(clientFailures.get(key) || []).length > MAX_FAILURES || failures.length > MAX_GLOBAL_FAILURES) {
      throw new ApprovalRefused('APPROVAL_RATE_LIMITED', 'Too many wrong approval codes. Wait a few minutes, then update the code on this device.', 429)
    }
    return false
  }

  function refusal(s) {
    if (s === 'missing') return new ApprovalRefused('APPROVAL_CODE_MISSING', 'This Totem\'s approval code file is missing, so approvals are refused. Set a new code in Settings → Security.')
    if (s === 'tampered') return new ApprovalRefused('APPROVAL_CODE_TAMPERED', 'This Totem\'s approval code changed outside Totem, so approvals are refused. Set a new code in Settings → Security (or restart Totem if you just ran npm run approval-code).')
    if (s === 'armed') return new ApprovalRefused('APPROVAL_CODE_REQUIRED', 'This needs the approval code. Enter it on this device (Settings → Security), then try again.')
    return new ApprovalRefused('APPROVAL_CODE_NOT_SET', 'Set an approval code first (Settings → Security). Until then, sends, commands and prompts cannot be approved.')
  }

  /**
   * The gate. `risk` is 'low' or 'high'; `hasSession` is whether the request
   * carries a signed-in session (or the auth proxy) — never the bearer secret.
   * Resolves to how it was approved, or throws ApprovalRefused.
   *
   *   a correct code            approves anything, with the session or the bearer
   *                             (the iPhone app holds only the bearer)
   *   a wrong code              refused and counted, even where none was needed
   *   no code, low risk         the session alone approves; the bearer alone never
   *   no code, high risk        legacy: the session alone; otherwise refused
   */
  async function check(req, { risk = 'high', hasSession = false } = {}) {
    const presented = String(req?.headers?.[APPROVAL_CODE_HEADER] || '').trim()
    const { state: s } = await state()
    if (presented) {
      if (s !== 'armed') throw refusal(s)
      if (await verify(req, presented, hasSession ? 'session' : 'bearer')) return 'code'
      throw new ApprovalRefused('APPROVAL_CODE_WRONG', 'That approval code is not this Totem\'s current one. Update it on this device (Settings → Security).')
    }
    if (!hasSession) {
      throw new ApprovalRefused('APPROVAL_NEEDS_OWNER', s === 'armed'
        ? 'Approving needs the approval code on this device. The bridge secret alone cannot approve.'
        : 'Approving needs a signed-in dashboard session or the approval code. The bridge secret alone cannot approve.')
    }
    if (risk === 'low' || s === 'legacy') return 'session'
    throw refusal(s)
  }

  /** Lease one-time codes (logs/approvals.mjs) only mean anything while sign-in alone approves. */
  async function oneTimeCodesAllowed() {
    return (await state()).state === 'legacy'
  }

  return { file, init, state, status, set, check, oneTimeCodesAllowed }
}
