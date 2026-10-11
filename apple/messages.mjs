// Messages (iMessage and SMS), read-only from the Messages app's chat.db.
//
// Everything here is SELECTs on a database the Messages app owns and writes
// continuously (WAL mode), so it is opened read-only per call and closed again:
// a long-lived handle would pin an old WAL snapshot. Sending is not here; see
// send.mjs.
//
// Shapes worth knowing:
//   - Dates are nanoseconds since 2001-01-01 (seconds on rows from before High
//     Sierra). APPLE_MS converts either to Unix milliseconds in SQL. Never select a
//     raw date column: nanoseconds overflow a JS number and node:sqlite throws.
//   - `message.text` is usually NULL on current macOS; the text lives in
//     `attributedBody` (see typedstream.mjs). Search therefore cannot be a SQL
//     LIKE: it decodes bodies into an in-memory index once, then only new rows.
//   - A tapback ("Loved …") is its own row with associated_message_type
//     2000–2006 (3000–3006 removes one) pointing at its target's guid. Threads
//     fold them onto the message they react to instead of showing them as text.

import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { decodeAttributedBody } from './typedstream.mjs'

const APPLE_EPOCH_MS = 978307200000
const APPLE_MS = (col) => `((CASE WHEN ${col} > 100000000000 THEN ${col} / 1000000 ELSE ${col} * 1000 END) + ${APPLE_EPOCH_MS})`

const TAPBACKS = { 2000: 'loved', 2001: 'liked', 2002: 'disliked', 2003: 'laughed at', 2004: 'emphasized', 2005: 'questioned', 2006: 'reacted to' }

export function messageText(row) {
  const raw = row.text || decodeAttributedBody(row.attributedBody) || ''
  // U+FFFC stands in for an inline attachment; the attachment list carries it.
  return raw.replace(/\uFFFC/g, '').trim()
}

// "p:0/GUID" or "bp:GUID" → "GUID"
const targetGuid = (assoc) => String(assoc || '').replace(/^(?:p:\d+\/|bp:)/, '')

export function expandHome(path, home = homedir()) {
  return path && path.startsWith('~/') ? `${home}${path.slice(1)}` : path
}

export function createMessages({ file, contacts = null, home = homedir() } = {}) {
  const searchIndex = { rows: new Map(), maxRowid: 0 }

  function withDb(fn) {
    const db = new DatabaseSync(file, { readOnly: true })
    try { return fn(db) } finally { db.close() }
  }

  const nameFor = (handle) => (handle ? contacts?.nameFor(handle) || null : null)

  function participants(db, chatIds) {
    if (!chatIds.length) return new Map()
    const rows = db.prepare(`
      SELECT chj.chat_id chatId, h.id handle
      FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id
      WHERE chj.chat_id IN (${chatIds.map(() => '?').join(',')})
    `).all(...chatIds)
    const out = new Map()
    for (const r of rows) {
      if (!out.has(r.chatId)) out.set(r.chatId, [])
      out.get(r.chatId).push({ handle: r.handle, name: nameFor(r.handle) })
    }
    return out
  }

  function chatTitle(chat, people) {
    if (chat.name) return chat.name
    const named = people.map((p) => p.name || p.handle)
    if (named.length) return named.join(', ')
    return nameFor(chat.ident) || chat.ident
  }

  function shapeChat(row, people) {
    return {
      id: row.id,
      guid: row.guid,
      title: chatTitle(row, people),
      isGroup: people.length > 1 || String(row.guid).includes(';+;'),
      service: row.service,
      identifier: row.ident,
      participants: people,
      unread: row.unread || 0,
      last: row.mid ? {
        at: new Date(row.at).toISOString(),
        fromMe: !!row.fromMe,
        text: row.amt >= 2000 && row.amt < 4000 ? `${row.fromMe ? 'You' : 'They'} ${TAPBACKS[row.amt] || 'reacted to'} a message` : messageText(row) || (row.att ? '(attachment)' : ''),
      } : null,
    }
  }

  const CHAT_SELECT = `
    SELECT c.ROWID id, c.guid, c.chat_identifier ident, c.display_name name, c.service_name service,
      m.ROWID mid, m.is_from_me fromMe, m.text, m.attributedBody, ${APPLE_MS('m.date')} at,
      m.cache_has_attachments att, m.associated_message_type amt,
      (SELECT COUNT(*) FROM chat_message_join u JOIN message um ON um.ROWID = u.message_id
        WHERE u.chat_id = c.ROWID AND um.is_read = 0 AND um.is_from_me = 0 AND um.associated_message_type = 0) unread
    FROM chat c
    JOIN (
      SELECT chat_id, message_id FROM (
        SELECT chat_id, message_id, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY message_date DESC, message_id DESC) rn
        FROM chat_message_join
      ) WHERE rn = 1
    ) last ON last.chat_id = c.ROWID
    JOIN message m ON m.ROWID = last.message_id`

  function listChats({ limit = 50, query = '' } = {}) {
    return withDb((db) => {
      const rows = db.prepare(`${CHAT_SELECT} ORDER BY m.date DESC`).all()
      const people = participants(db, rows.map((r) => r.id))
      let chats = rows.map((r) => shapeChat(r, people.get(r.id) || []))
      const q = String(query || '').trim().toLowerCase()
      if (q) {
        chats = chats.filter((c) => c.title.toLowerCase().includes(q)
          || c.identifier.toLowerCase().includes(q)
          || c.participants.some((p) => p.handle.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q)))
      }
      return chats.slice(0, Math.max(1, Math.min(500, Number(limit) || 50)))
    })
  }

  // A chat by ROWID, guid, or the handle of a one-to-one conversation.
  function resolveChat(db, ref) {
    const r = String(ref ?? '').trim()
    if (!r) return null
    const byId = /^\d+$/.test(r) ? db.prepare('SELECT ROWID id FROM chat WHERE ROWID = ?').get(Number(r)) : null
    if (byId) return byId.id
    const byGuid = db.prepare('SELECT ROWID id FROM chat WHERE guid = ? OR chat_identifier = ?').get(r, r)
    return byGuid ? byGuid.id : null
  }

  function getChat(ref) {
    return withDb((db) => {
      const id = resolveChat(db, ref)
      if (!id) return null
      const row = db.prepare(`${CHAT_SELECT} WHERE c.ROWID = ?`).get(id)
      if (!row) {
        const bare = db.prepare('SELECT ROWID id, guid, chat_identifier ident, display_name name, service_name service FROM chat WHERE ROWID = ?').get(id)
        return bare ? shapeChat(bare, participants(db, [id]).get(id) || []) : null
      }
      return shapeChat(row, participants(db, [id]).get(id) || [])
    })
  }

  function attachmentsFor(db, ids) {
    if (!ids.length) return new Map()
    const rows = db.prepare(`
      SELECT maj.message_id mid, a.ROWID id, a.filename, a.mime_type mime, a.transfer_name name, a.total_bytes bytes, a.is_sticker sticker
      FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id
      WHERE maj.message_id IN (${ids.map(() => '?').join(',')})
    `).all(...ids)
    const out = new Map()
    for (const r of rows) {
      // A rich link preview's hidden data, not something anyone sent.
      if (/\.pluginPayloadAttachment$/i.test(r.name || r.filename || '')) continue
      if (!out.has(r.mid)) out.set(r.mid, [])
      out.get(r.mid).push({ id: r.id, name: r.name || null, mime: r.mime || null, bytes: r.bytes || 0, sticker: !!r.sticker })
    }
    return out
  }

  // Newest `limit` messages of a chat (or older than message `before`), returned
  // oldest-first so a reader sees them in order.
  function getMessages(ref, { limit = 50, before = null } = {}) {
    return withDb((db) => {
      const chatId = resolveChat(db, ref)
      if (!chatId) return null
      const lim = Math.max(1, Math.min(500, Number(limit) || 50))
      const rows = db.prepare(`
        SELECT m.ROWID id, m.guid, m.is_from_me fromMe, m.text, m.attributedBody, ${APPLE_MS('m.date')} at,
          m.service, m.cache_has_attachments att, m.associated_message_type amt, m.associated_message_guid assoc,
          m.is_read isRead, ${APPLE_MS('m.date_read')} readAt, (m.date_read > 0) hasRead, m.error, h.id handle
        FROM chat_message_join cmj
        JOIN message m ON m.ROWID = cmj.message_id
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE cmj.chat_id = ? AND (m.associated_message_type = 0 OR m.associated_message_type IS NULL)
          ${before ? 'AND m.date < (SELECT date FROM message WHERE ROWID = ?)' : ''}
        ORDER BY m.date DESC LIMIT ?
      `).all(...(before ? [chatId, Number(before), lim] : [chatId, lim]))
      rows.reverse()
      const guids = rows.map((r) => r.guid)
      const reactions = new Map()
      if (guids.length) {
        const like = guids.map(() => 'm.associated_message_guid LIKE ?').join(' OR ')
        const taps = db.prepare(`
          SELECT m.associated_message_guid assoc, m.associated_message_type amt, m.is_from_me fromMe, h.id handle
          FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id LEFT JOIN handle h ON h.ROWID = m.handle_id
          WHERE cmj.chat_id = ? AND m.associated_message_type >= 2000 AND m.associated_message_type < 4000 AND (${like})
          ORDER BY m.date ASC
        `).all(chatId, ...guids.map((g) => `%${g}`))
        // A 3xxx row withdraws the matching 2xxx from the same person.
        for (const t of taps) {
          const target = targetGuid(t.assoc)
          const who = t.fromMe ? 'me' : t.handle
          const list = reactions.get(target) || []
          const kind = t.amt >= 3000 ? t.amt - 1000 : t.amt
          const rest = list.filter((x) => !(x.who === who && x.kind === kind))
          if (t.amt < 3000) rest.push({ who, kind })
          reactions.set(target, rest)
        }
      }
      const atts = attachmentsFor(db, rows.filter((r) => r.att).map((r) => r.id))
      return {
        chatId,
        messages: rows.map((r) => ({
          id: r.id,
          at: new Date(r.at).toISOString(),
          fromMe: !!r.fromMe,
          sender: r.fromMe ? 'me' : r.handle || null,
          senderName: r.fromMe ? 'Me' : nameFor(r.handle) || r.handle || null,
          text: messageText(r),
          service: r.service,
          attachments: atts.get(r.id) || [],
          reactions: (reactions.get(r.guid) || []).map((x) => ({
            by: x.who === 'me' ? 'Me' : nameFor(x.who) || x.who,
            kind: TAPBACKS[x.kind] || 'reacted to',
          })),
          ...(r.fromMe && r.hasRead ? { readAt: new Date(r.readAt).toISOString() } : {}),
          ...(r.error ? { failed: true } : {}),
        })),
        hasMore: rows.length === lim,
      }
    })
  }

  // Keep a decoded copy of every message body, refreshed incrementally.
  function refreshIndex(db) {
    const rows = db.prepare(`
      SELECT m.ROWID id, m.text, m.attributedBody, ${APPLE_MS('m.date')} at, m.is_from_me fromMe, h.id handle, cmj.chat_id chatId
      FROM message m
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      WHERE m.ROWID > ? AND (m.associated_message_type = 0 OR m.associated_message_type IS NULL)
    `).all(searchIndex.maxRowid)
    for (const r of rows) {
      const text = messageText(r)
      if (text) searchIndex.rows.set(r.id, { id: r.id, text, lower: text.toLowerCase(), at: r.at, fromMe: !!r.fromMe, handle: r.handle, chatId: r.chatId })
      if (r.id > searchIndex.maxRowid) searchIndex.maxRowid = r.id
    }
  }

  function search(query, { limit = 30, chat = null, since = null, until = null, fromMe = null } = {}) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return []
    return withDb((db) => {
      refreshIndex(db)
      const chatId = chat ? resolveChat(db, chat) : null
      if (chat && !chatId) return []
      const sinceMs = since ? Date.parse(since) : null
      const untilMs = until ? Date.parse(until) : null
      const hits = []
      for (const r of searchIndex.rows.values()) {
        if (chatId && r.chatId !== chatId) continue
        if (sinceMs && r.at < sinceMs) continue
        if (untilMs && r.at > untilMs) continue
        if (fromMe !== null && r.fromMe !== fromMe) continue
        if (words.every((w) => r.lower.includes(w))) hits.push(r)
      }
      hits.sort((a, b) => b.at - a.at)
      const top = hits.slice(0, Math.max(1, Math.min(200, Number(limit) || 30)))
      const chatIds = [...new Set(top.map((h) => h.chatId).filter(Boolean))]
      const titles = new Map()
      if (chatIds.length) {
        const people = participants(db, chatIds)
        for (const c of db.prepare(`SELECT ROWID id, guid, chat_identifier ident, display_name name FROM chat WHERE ROWID IN (${chatIds.map(() => '?').join(',')})`).all(...chatIds)) {
          titles.set(c.id, chatTitle(c, people.get(c.id) || []))
        }
      }
      return top.map((h) => ({
        messageId: h.id,
        chatId: h.chatId,
        chat: titles.get(h.chatId) || null,
        at: new Date(h.at).toISOString(),
        fromMe: h.fromMe,
        sender: h.fromMe ? 'Me' : nameFor(h.handle) || h.handle,
        text: h.text,
      }))
    })
  }

  // The file behind an attachment, for the dashboard to stream. Only paths
  // under ~/Library/Messages are ever returned.
  function attachmentFile(id) {
    return withDb((db) => {
      const row = db.prepare('SELECT filename, mime_type mime, transfer_name name FROM attachment WHERE ROWID = ?').get(Number(id))
      if (!row?.filename) return null
      const path = expandHome(row.filename, home)
      if (!path.startsWith(`${home}/Library/Messages/`)) return null
      return { path, mime: row.mime || null, name: row.name || null }
    })
  }

  // Did a message we just handed to Messages.app land in the database? Used to
  // turn "osascript exited 0" into "sent" or "Messages has not recorded it".
  function findRecentOutgoing({ text, sinceMs }) {
    return withDb((db) => {
      const rows = db.prepare(`
        SELECT m.ROWID id, m.text, m.attributedBody, m.error, ${APPLE_MS('m.date')} at
        FROM message m WHERE m.is_from_me = 1 AND m.date > ? ORDER BY m.date DESC LIMIT 20
      `).all(BigInt(Math.floor(sinceMs - APPLE_EPOCH_MS)) * 1_000_000n)
      const want = String(text).trim()
      const hit = rows.find((r) => messageText(r) === want)
      return hit ? { id: hit.id, at: new Date(hit.at).toISOString(), error: hit.error || 0 } : null
    })
  }

  function stats() {
    return withDb((db) => {
      const r = db.prepare(`SELECT COUNT(*) n, MIN(${APPLE_MS('date')}) first, MAX(${APPLE_MS('date')}) last FROM message`).get()
      const chats = db.prepare('SELECT COUNT(*) n FROM chat').get().n
      return { messages: r.n, chats, oldest: r.first ? new Date(r.first).toISOString() : null, newest: r.last ? new Date(r.last).toISOString() : null }
    })
  }

  return { listChats, getChat, getMessages, search, attachmentFile, findRecentOutgoing, stats }
}
