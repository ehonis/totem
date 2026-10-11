// Apple data on the Mac Totem runs on: Messages, Contacts and Photos, read from
// the apps' own databases, plus sending through the Messages app.
//
// Off unless APPLE_ENABLED=true, and only on macOS. The reads need Full Disk
// Access for the node binary running Totem (System Settings → Privacy &
// Security → Full Disk Access); without it SQLite reports "unable to open
// database file" and status() turns that into the exact fix. Sending needs a
// separate one-time Automation grant (node → Messages). Both grants belong to
// the node binary's real path, so a Homebrew upgrade that moves it to a new
// Cellar directory silently revokes them — status() names the path it needs.

import { existsSync, realpathSync, accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createContacts, handleKey } from './contacts.mjs'
import { createMessages } from './messages.mjs'
import { createPhotos } from './photos.mjs'
import { createSender, SendError, validHandle } from './send.mjs'

export { SendError }

export function applePaths(home = homedir(), env = process.env) {
  return {
    messages: env.APPLE_MESSAGES_DB || join(home, 'Library', 'Messages', 'chat.db'),
    contacts: env.APPLE_CONTACTS_DIR || join(home, 'Library', 'Application Support', 'AddressBook'),
    photos: env.APPLE_PHOTOS_LIBRARY || join(home, 'Pictures', 'Photos Library.photoslibrary'),
  }
}

function nodePath() {
  try { return realpathSync(process.execPath) } catch { return process.execPath }
}

// A read that failed for lack of permission, as opposed to a missing file.
function isAccessError(e) {
  return /unable to open database|authorization denied|operation not permitted|EPERM|EACCES/i.test(String(e?.message || e))
}

export function createApple({ enabled, platform = process.platform, home = homedir(), env = process.env, cacheDir = null, exec } = {}) {
  const on = !!enabled && platform === 'darwin'
  const paths = applePaths(home, env)
  const contacts = createContacts({ root: paths.contacts })
  const messages = createMessages({ file: paths.messages, contacts, home })
  const photos = createPhotos({ library: paths.photos, cacheDir: cacheDir ? join(cacheDir, 'photos') : null, ...(exec ? { exec } : {}) })
  const sender = createSender({ platform, ...(exec ? { exec } : {}) })

  const accessFix = () => `Give Full Disk Access to ${nodePath()} (System Settings → Privacy & Security → Full Disk Access → +, then ⌘⇧G and paste the path), then restart Totem.`

  function probe(name, fn) {
    try {
      return { state: 'ready', ...fn() }
    } catch (e) {
      if (isAccessError(e)) return { state: 'no-access', detail: accessFix() }
      return { state: 'error', detail: e.message || String(e) }
    }
  }

  function status() {
    if (platform !== 'darwin') return { enabled: false, state: 'unsupported', detail: 'Apple data needs Totem to run on a Mac.' }
    if (!on) return { enabled: false, state: 'off', detail: 'Set APPLE_ENABLED=true to read Messages, Contacts and Photos on this Mac.' }
    const sources = {
      messages: existsSync(paths.messages) ? probe('messages', () => messages.stats()) : { state: 'missing', detail: 'Messages is not set up on this Mac (no chat.db).' },
      contacts: existsSync(paths.contacts) ? probe('contacts', () => ({ people: contacts.count() })) : { state: 'missing', detail: 'No Contacts database on this Mac.' },
      photos: existsSync(paths.photos) ? probe('photos', () => photos.stats()) : { state: 'missing', detail: `No Photos library at ${paths.photos}.` },
    }
    // ~/Library/Messages may exist and still be unreadable; the probe above
    // already says so, but a directory listing failing is the earlier signal.
    try { accessSync(paths.messages, constants.R_OK) } catch (e) { if (sources.messages.state === 'ready' && isAccessError(e)) sources.messages = { state: 'no-access', detail: accessFix() } }
    const states = Object.values(sources).map((s) => s.state)
    return {
      enabled: true,
      state: states.every((s) => s === 'ready') ? 'ready' : states.includes('no-access') ? 'no-access' : states.some((s) => s === 'ready') ? 'partial' : 'error',
      node: nodePath(),
      sources,
      sending: 'Sending goes through the Messages app. The first send asks (on the Mac) to allow node to control Messages.',
    }
  }

  function requireOn() {
    if (!on) {
      const err = new Error(platform === 'darwin' ? 'Apple data is off. Set APPLE_ENABLED=true.' : 'Apple data needs Totem to run on a Mac.')
      err.status = 404
      throw err
    }
  }

  // Wrap a read so a permissions failure comes back as the fix, not "unable to
  // open database file".
  function guarded(fn) {
    return (...args) => {
      requireOn()
      try {
        const out = fn(...args)
        return out && typeof out.then === 'function' ? out.catch((e) => { throw translate(e) }) : out
      } catch (e) {
        throw translate(e)
      }
    }
  }
  function translate(e) {
    if (isAccessError(e) && !(e instanceof SendError)) {
      const err = new Error(`Totem cannot read this Apple data yet. ${accessFix()}`)
      err.status = 403
      err.code = 'no_access'
      return err
    }
    return e
  }

  // `to` given as a name: exactly one contact by that name, and one obvious
  // address for them (a mobile number, else the only number, else the only
  // email). Anything less certain is refused with the choices, not guessed.
  function handleForName(name) {
    const q = String(name || '').trim().toLowerCase()
    const people = contacts.search(name, { limit: 10 }).filter((p) => p.name.toLowerCase() === q || (p.nickname || '').toLowerCase() === q)
    if (people.length !== 1) {
      throw new SendError(people.length
        ? `"${name}" matches ${people.length} contacts (${people.map((p) => p.name).join(', ')}). Give a phone number or email.`
        : `"${name}" is not a phone number, email or contact name.`, { code: 'bad_recipient', status: 400 })
    }
    const p = people[0]
    const mobile = p.phones.filter((ph) => /mobile|iphone|cell/i.test(ph.label || ''))
    const pick = mobile.length === 1 ? mobile[0].number : p.phones.length === 1 ? p.phones[0].number : !p.phones.length && p.emails.length === 1 ? p.emails[0].address : null
    if (!pick) throw new SendError(`${p.name} has ${p.phones.length} numbers and ${p.emails.length} emails. Say which one.`, { code: 'bad_recipient', status: 400 })
    return validHandle(pick)
  }

  // Where a message goes: an existing chat (by id or guid), else the one-to-one
  // chat already open with that handle, else a new conversation with the handle.
  function resolveTarget({ chat = null, to = null, service = null }) {
    if (chat) {
      const found = messages.getChat(chat)
      if (!found) throw new SendError(`No conversation "${chat}"`, { code: 'unknown_chat', status: 404 })
      return { target: { chatGuid: found.guid }, chat: found }
    }
    if (!to) throw new SendError('Say who to send to: a chat id, or a phone number or email in `to`', { code: 'bad_recipient', status: 400 })
    const handle = validHandle(to) || handleForName(to)
    const key = handleKey(handle)
    const existing = messages.listChats({ limit: 500 }).find((c) => !c.isGroup && key && handleKey(c.identifier) === key && (!service || c.service === service))
    if (existing) return { target: { chatGuid: existing.guid }, chat: existing }
    return { target: { handle, service: service || 'iMessage' }, chat: null }
  }

  async function send({ chat = null, to = null, service = null, text, confirmMs = 8000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    requireOn()
    const { target, chat: resolved } = resolveTarget({ chat, to, service })
    const startedAt = Date.now() - 2000
    await sender.send(target, text)
    // osascript returning means Messages accepted the request. Watch chat.db for
    // the outgoing row so the caller can tell "sent" from "handed over".
    let recorded = null
    for (let waited = 0; waited < confirmMs && !recorded; waited += 1000) {
      await sleep(1000)
      try { recorded = messages.findRecentOutgoing({ text, sinceMs: startedAt }) } catch { break }
    }
    const recipient = resolved?.title || contacts.nameFor(to) || to
    return {
      sent: true,
      recorded: !!recorded,
      failed: !!recorded?.error,
      to: recipient,
      chatId: resolved?.id || null,
      messageId: recorded?.id || null,
    }
  }

  return {
    enabled: on,
    paths,
    status,
    listChats: guarded((opts) => messages.listChats(opts)),
    getChat: guarded((ref) => messages.getChat(ref)),
    getMessages: guarded((ref, opts) => messages.getMessages(ref, opts)),
    searchMessages: guarded((q, opts) => messages.search(q, opts)),
    attachmentFile: guarded((id) => messages.attachmentFile(id)),
    findContacts: guarded((q, opts) => contacts.search(q, opts)),
    contactName: (handle) => { try { return on ? contacts.nameFor(handle) : null } catch { return null } },
    searchPhotos: guarded((opts) => photos.search(opts)),
    getPhoto: guarded((id) => photos.get(id)),
    photoPeople: guarded((opts) => photos.people(opts)),
    photoAlbums: guarded(() => photos.albums()),
    photoImage: guarded((id, opts) => photos.imageFile(id, opts)),
    resolveTarget: guarded((t) => resolveTarget(t)),
    checkTarget: async (t) => { requireOn(); return sender.check(resolveTarget(t).target) },
    send: async (args) => { try { return await send(args) } catch (e) { throw translate(e) } },
  }
}
