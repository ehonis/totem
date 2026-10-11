// Contacts, read straight from the Contacts app's own databases.
//
// macOS keeps one Core Data store per account under
// ~/Library/Application Support/AddressBook/Sources/<uuid>/AddressBook-v22.abcddb,
// plus a merged one at the top level. Read them all, read-only, and merge people
// who appear in more than one (the same iCloud card is often in both).
//
// The main job is naming message threads: chat.db knows "+15551234567", not
// "Mom". Phone numbers are matched on their last ten digits, so "+1 (555)
// 123-4567", "5551234567" and "+15551234567" are the same person; anything
// shorter (a short code like 12345) has to match exactly.

import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DB_NAME = 'AddressBook-v22.abcddb'

export function phoneKey(value) {
  const digits = String(value || '').replace(/\D/g, '')
  if (!digits) return ''
  return digits.length >= 10 ? digits.slice(-10) : digits
}

export function handleKey(handle) {
  const h = String(handle || '').trim()
  if (!h) return ''
  if (h.includes('@')) return h.toLowerCase()
  return phoneKey(h)
}

// "_$!<Mobile>!$_" is how Contacts stores its built-in labels.
const cleanLabel = (label) => (label ? String(label).replace(/^_\$!<(.+)>!\$_$/, '$1') : null)

export function contactDatabases(root) {
  const found = []
  if (existsSync(join(root, DB_NAME))) found.push(join(root, DB_NAME))
  const sources = join(root, 'Sources')
  if (existsSync(sources)) {
    for (const name of readdirSync(sources)) {
      const file = join(sources, name, DB_NAME)
      if (existsSync(file)) found.push(file)
    }
  }
  return found
}

function readOne(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const people = new Map()
    for (const r of db.prepare(`
      SELECT Z_PK id, ZFIRSTNAME first, ZLASTNAME last, ZORGANIZATION org, ZNICKNAME nick
      FROM ZABCDRECORD
      WHERE ZFIRSTNAME IS NOT NULL OR ZLASTNAME IS NOT NULL OR ZORGANIZATION IS NOT NULL
    `).all()) {
      const name = [r.first, r.last].filter(Boolean).join(' ').trim() || r.org || r.nick
      if (!name) continue
      people.set(r.id, { name, nickname: r.nick || null, organization: r.org || null, phones: [], emails: [] })
    }
    for (const r of db.prepare('SELECT ZOWNER owner, ZFULLNUMBER number, ZLABEL label FROM ZABCDPHONENUMBER').all()) {
      const p = people.get(r.owner)
      if (p && r.number) p.phones.push({ number: r.number, label: cleanLabel(r.label) })
    }
    for (const r of db.prepare('SELECT ZOWNER owner, ZADDRESS address, ZLABEL label FROM ZABCDEMAILADDRESS').all()) {
      const p = people.get(r.owner)
      if (p && r.address) p.emails.push({ address: r.address, label: cleanLabel(r.label) })
    }
    return [...people.values()]
  } finally {
    db.close()
  }
}

export function createContacts({ root, ttlMs = 60_000, now = Date.now } = {}) {
  let cache = null

  function stamp(files) {
    return files.map((f) => { try { return statSync(f).mtimeMs } catch { return 0 } }).join(',')
  }

  function load() {
    const files = contactDatabases(root)
    if (cache && now() - cache.at < ttlMs) return cache
    const mark = stamp(files)
    if (cache && cache.mark === mark) { cache.at = now(); return cache }
    // Merge on name plus any shared phone/email, so the same card read from two
    // stores is one person with the union of their numbers.
    const merged = []
    const byHandle = new Map()
    for (const file of files) {
      for (const person of readOne(file)) {
        const keys = [...person.phones.map((p) => handleKey(p.number)), ...person.emails.map((e) => handleKey(e.address))].filter(Boolean)
        const twin = keys.map((k) => byHandle.get(k)).find((p) => p && p.name === person.name)
        const target = twin || person
        if (twin) {
          for (const ph of person.phones) if (!twin.phones.some((x) => handleKey(x.number) === handleKey(ph.number))) twin.phones.push(ph)
          for (const em of person.emails) if (!twin.emails.some((x) => handleKey(x.address) === handleKey(em.address))) twin.emails.push(em)
        } else {
          merged.push(person)
        }
        for (const k of keys) if (!byHandle.has(k)) byHandle.set(k, target)
      }
    }
    cache = { at: now(), mark, people: merged, byHandle, files: files.length }
    return cache
  }

  return {
    available: () => contactDatabases(root).length > 0,
    count: () => load().people.length,
    nameFor(handle) {
      const key = handleKey(handle)
      return key ? load().byHandle.get(key)?.name || null : null
    },
    search(query, { limit = 20 } = {}) {
      const q = String(query || '').trim().toLowerCase()
      if (!q) return []
      const qPhone = phoneKey(q)
      const scored = []
      for (const p of load().people) {
        const name = p.name.toLowerCase()
        let score = 0
        if (name === q || (p.nickname || '').toLowerCase() === q) score = 3
        else if (name.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q))) score = 2
        else if (name.includes(q) || (p.organization || '').toLowerCase().includes(q) || (p.nickname || '').toLowerCase().includes(q)) score = 1
        else if (qPhone.length >= 4 && p.phones.some((ph) => phoneKey(ph.number).includes(qPhone))) score = 1
        else if (q.includes('@') && p.emails.some((e) => e.address.toLowerCase().includes(q))) score = 1
        if (score) scored.push({ score, p })
      }
      scored.sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
      return scored.slice(0, limit).map((s) => s.p)
    },
  }
}
