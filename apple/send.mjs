// Sending an iMessage/SMS by asking the Messages app to do it (AppleScript).
//
// There is no API for this: Messages.app is the only thing that holds the
// account. The text and the recipient go in as argv, never spliced into the
// script source, so nothing in a message can be read as AppleScript.
//
// macOS asks once whether this process may control Messages (Privacy & Security
// → Automation). Until someone clicks Allow on the Mac itself, every send fails
// with -1743; that is mapped to an error that says so.
//
// A target is either an existing chat (its chat.db guid, which is also the
// AppleScript chat id) or a bare handle (phone number or email) for someone
// there is no conversation with yet. SMS to a bare handle works only when the
// owner's iPhone forwards text messages to this Mac.

import { execFile } from 'node:child_process'

const SCRIPT = `
on run argv
  set mode to item 1 of argv
  set target to item 2 of argv
  set svcName to item 3 of argv
  set theText to item 4 of argv
  tell application "Messages"
    if mode is "chat" or mode is "check-chat" then
      set dest to chat id target
      if mode is "check-chat" then return id of dest
    else
      if svcName is "SMS" then
        set svc to 1st account whose service type = SMS
      else
        set svc to 1st account whose service type = iMessage
      end if
      set dest to participant target of svc
      if mode is "check-handle" then return handle of dest
    end if
    send theText to dest
  end tell
  return "sent"
end run
`

export class SendError extends Error {
  constructor(message, { code = 'send_failed', status = 502 } = {}) {
    super(message)
    this.code = code
    this.status = status
  }
}

export function explainOsascriptError(stderr) {
  const s = String(stderr || '')
  if (/-1743|Not authori[sz]ed to send Apple events/i.test(s)) {
    return new SendError(
      'macOS has not allowed Totem to control Messages yet. On the Mac, open System Settings → Privacy & Security → '
      + 'Automation and allow node → Messages (or click Allow on the prompt that appears on the next send).',
      { code: 'automation_denied', status: 403 },
    )
  }
  if (/-1728|Can.t get (chat|participant)/i.test(s)) {
    return new SendError('Messages does not know that conversation or recipient. Check the handle, or pick an existing chat.', { code: 'unknown_recipient', status: 404 })
  }
  if (/-1719|-600|isn.t running/i.test(s)) {
    return new SendError('Messages is not running or not signed in on the Mac.', { code: 'messages_unavailable', status: 503 })
  }
  return new SendError(`Messages refused the send: ${s.trim().slice(0, 300) || 'no reason given'}`)
}

// A handle Messages can address: a phone number or an email address. Anything
// else is refused before AppleScript sees it.
export function validHandle(value) {
  const v = String(value || '').trim()
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return v
  if (/^\+?[\d\s().-]{3,20}$/.test(v) && /\d{3,}/.test(v.replace(/\D/g, ''))) return v.replace(/[\s().-]/g, '')
  return null
}

function runOsascript(args, { timeoutMs = 20_000, exec = execFile } = {}) {
  return new Promise((resolve, reject) => {
    const child = exec('osascript', ['-', ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(explainOsascriptError(stderr || err.message))
      resolve(String(stdout || '').trim())
    })
    child.stdin?.end(SCRIPT)
  })
}

export function createSender({ exec = execFile, platform = process.platform } = {}) {
  function guard() {
    if (platform !== 'darwin') throw new SendError('Sending messages needs macOS with the Messages app.', { code: 'unsupported', status: 501 })
  }

  // target: { chatGuid } or { handle, service? }
  function argsFor(target, text, check) {
    if (target.chatGuid) return [check ? 'check-chat' : 'chat', String(target.chatGuid), '', text]
    const handle = validHandle(target.handle)
    if (!handle) throw new SendError(`"${target.handle}" is not a phone number or email address`, { code: 'bad_recipient', status: 400 })
    return [check ? 'check-handle' : 'handle', handle, target.service === 'SMS' ? 'SMS' : 'iMessage', text]
  }

  return {
    // Resolve the recipient without sending anything.
    async check(target) {
      guard()
      return await runOsascript(argsFor(target, '', true), { exec })
    },
    async send(target, text) {
      guard()
      const body = String(text || '')
      if (!body.trim()) throw new SendError('Nothing to send', { code: 'empty', status: 400 })
      if (body.length > 10_000) throw new SendError('Message is too long (10,000 characters max)', { code: 'too_long', status: 400 })
      await runOsascript(argsFor(target, body, false), { exec })
    },
  }
}

export const SEND_SCRIPT = SCRIPT
