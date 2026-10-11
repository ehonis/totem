// Photos, read-only from the Photos library bundle.
//
// Two databases inside "<library>.photoslibrary/database/":
//   - Photos.sqlite: one ZASSET row per photo/video with its date (seconds since
//     2001-01-01), location, favourite flag and file name; people come from
//     ZDETECTEDFACE → ZPERSON, albums from ZGENERICALBUM through a join table
//     whose name and columns carry Core Data entity numbers (Z_34ASSETS with
//     Z_34ALBUMS / Z_3ASSETS on macOS 27). Those numbers move between macOS
//     releases, so they are looked up in Z_PRIMARYKEY rather than written down.
//   - search/leo.sqlite (psi.sqlite on older releases): the index the Photos
//     search field uses. `lexicon` holds every searchable word Photos derived
//     (scene labels like "Dog", places, people, holidays, text read from the
//     image), `items` maps an asset UUID to the lexeme ids that describe it as
//     a packed uint32 array (lexicon type 1 is the label itself, type 2 its
//     synonyms and plurals). This is what makes "dog at the beach" answerable
//     without running a model here. When the index is missing, text search falls
//     back to titles, captions, file names, places and people in Photos.sqlite.
//
// With iCloud "Optimize Mac Storage" most originals are not on disk; the
// library keeps JPEG derivatives under resources/derivatives, which is what
// imageFile() returns (converted from HEIC with `sips` only when it must).

import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'

const APPLE_EPOCH_S = 978307200
const KIND = { 0: 'photo', 1: 'video' }

// What each lexicon category means, for showing why a photo matched.
export const LEXICON_CATEGORIES = {
  1010: 'month', 1020: 'year', 1030: 'holiday', 1040: 'season', 1050: 'time of day', 1060: 'week part', 1070: 'weekday',
  2010: 'home', 2030: 'business', 2050: 'street', 2060: 'point of interest', 2070: 'neighbourhood', 2090: 'city',
  2100: 'district', 2110: 'region', 2130: 'park', 2140: 'state', 2150: 'state', 2160: 'country', 2170: 'country', 2180: 'continent', 2190: 'continent',
  3000: 'person', 3010: 'pet', 3030: 'age group',
  4000: 'scene', 4010: 'species', 4020: 'landmark', 4050: 'sound', 4060: 'activity', 4080: 'document', 4090: 'event', 4110: 'text', 4120: 'text in image', 4130: 'document',
  6000: 'camera', 7000: 'project', 7010: 'album', 7020: 'memory', 7030: 'shared album', 8000: 'favourite', 8050: 'file name', 8060: 'app', 11000: 'document', 11010: 'name on document',
}

const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'at', 'in', 'on', 'with', 'and', 'photo', 'photos', 'picture', 'pictures', 'pic', 'pics', 'my', 'me', 'from'])

export function unpackLexemes(blob) {
  if (!blob) return []
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  const out = new Array(Math.floor(buf.length / 4))
  for (let i = 0; i < out.length; i += 1) out[i] = buf.readUInt32LE(i * 4)
  return out
}

// "dog, beach" → ["dog", "beach"]; "golden retriever" stays one phrase if
// Photos knows it, otherwise the caller splits it into words.
export function splitTerms(text) {
  const raw = String(text || '').trim()
  if (!raw) return []
  return raw.split(/[,;]+/).map((t) => t.trim().toLowerCase()).filter(Boolean)
}

export function createPhotos({ library, cacheDir, exec = execFile } = {}) {
  const dbFile = join(library, 'database', 'Photos.sqlite')
  const indexFile = ['search/leo.sqlite', 'search/psi.sqlite'].map((p) => join(library, 'database', p)).find((p) => existsSync(p)) || null
  let schema = null
  let index = null

  function withDb(file, fn) {
    const db = new DatabaseSync(file, { readOnly: true })
    try { return fn(db) } finally { db.close() }
  }

  // Core Data entity numbers for the album↔asset join table.
  function albumJoin(db) {
    if (schema) return schema
    const ent = Object.fromEntries(db.prepare('SELECT Z_NAME name, Z_ENT ent FROM Z_PRIMARYKEY').all().map((r) => [r.name, r.ent]))
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'Z_[0-9]*ASSETS'").all().map((r) => r.name)
    for (const table of tables) {
      const cols = db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((r) => r.name)
      const albums = cols.find((c) => /^Z_\d+ALBUMS$/.test(c))
      const assets = cols.find((c) => c === `Z_${ent.Asset}ASSETS`) || cols.find((c) => /^Z_\d+ASSETS$/.test(c))
      if (albums && assets) { schema = { table, albums, assets }; return schema }
    }
    schema = { table: null }
    return schema
  }

  // The search index, kept in memory and reloaded when the file changes. Small:
  // one row per asset with a few dozen lexeme ids.
  function loadIndex() {
    if (!indexFile) return null
    let mtime = 0
    try { mtime = statSync(indexFile).mtimeMs + (existsSync(`${indexFile}-wal`) ? statSync(`${indexFile}-wal`).mtimeMs : 0) } catch { return null }
    if (index && index.mtime === mtime) return index
    index = withDb(indexFile, (db) => {
      const lexicon = db.prepare("SELECT lexeme_id id, content, category, type FROM lexicon WHERE content != ''").all()
      const items = db.prepare('SELECT identifier uuid, lexeme_ids ids FROM items WHERE type = 1').all()
        .map((r) => ({ uuid: r.uuid, ids: new Set(unpackLexemes(r.ids)) }))
      return { mtime, lexicon: lexicon.map((l) => ({ ...l, lower: l.content.toLowerCase() })), items }
    })
    return index
  }

  // Lexeme ids for one term: exact matches (any spelling Photos lists, e.g.
  // "Dogs" for "Dog"), else words that start with it.
  function lexemesFor(idx, term) {
    const exact = idx.lexicon.filter((l) => l.lower === term)
    const hits = exact.length ? exact : term.length >= 3 ? idx.lexicon.filter((l) => l.lower.startsWith(term) || l.lower.split(/\s+/).includes(term)) : []
    return { ids: new Set(hits.map((h) => h.id)), labels: [...new Map(hits.map((h) => [h.lower, h.content])).values()].slice(0, 6), categories: [...new Set(hits.map((h) => LEXICON_CATEGORIES[h.category] || 'other'))] }
  }

  // UUIDs matching every term, plus what each term was understood as.
  function searchIndex(text) {
    const idx = loadIndex()
    if (!idx) return null
    const phrases = splitTerms(text)
    const terms = []
    for (const phrase of phrases) {
      const whole = lexemesFor(idx, phrase)
      if (whole.ids.size) { terms.push({ term: phrase, ...whole }); continue }
      for (const word of phrase.split(/\s+/).filter((w) => w && !STOPWORDS.has(w))) terms.push({ term: word, ...lexemesFor(idx, word) })
    }
    if (!terms.length) return { uuids: null, terms }
    if (terms.some((t) => !t.ids.size)) return { uuids: new Set(), terms }
    const uuids = new Set()
    for (const item of idx.items) {
      if (terms.every((t) => { for (const id of t.ids) if (item.ids.has(id)) return true; return false })) uuids.add(item.uuid)
    }
    return { uuids, terms }
  }

  const ASSET_SELECT = `
    SELECT a.Z_PK pk, a.ZUUID uuid, a.ZDATECREATED + ${APPLE_EPOCH_S} taken, a.ZKIND kind, a.ZKINDSUBTYPE subtype,
      a.ZFILENAME filename, a.ZDIRECTORY dir, a.ZFAVORITE favorite, a.ZWIDTH width, a.ZHEIGHT height, a.ZDURATION duration,
      a.ZLATITUDE lat, a.ZLONGITUDE lon, mo.ZTITLE place, mo.ZSUBTITLE placeDetail,
      aa.ZORIGINALFILENAME originalName, aa.ZTITLE title, d.ZLONGDESCRIPTION caption
    FROM ZASSET a
    LEFT JOIN ZMOMENT mo ON mo.Z_PK = a.ZMOMENT
    LEFT JOIN ZADDITIONALASSETATTRIBUTES aa ON aa.Z_PK = a.ZADDITIONALATTRIBUTES
    LEFT JOIN ZASSETDESCRIPTION d ON d.ZASSETATTRIBUTES = aa.Z_PK
    WHERE a.ZTRASHEDSTATE = 0 AND a.ZHIDDEN = 0`

  function peopleFor(db, pks) {
    const out = new Map()
    if (!pks.length) return out
    const rows = db.prepare(`
      SELECT f.ZASSETFORFACE pk, COALESCE(NULLIF(p.ZFULLNAME, ''), p.ZDISPLAYNAME) name
      FROM ZDETECTEDFACE f JOIN ZPERSON p ON p.Z_PK = f.ZPERSONFORFACE
      WHERE f.ZASSETFORFACE IN (${pks.map(() => '?').join(',')}) AND COALESCE(NULLIF(p.ZFULLNAME, ''), p.ZDISPLAYNAME) IS NOT NULL
    `).all(...pks)
    for (const r of rows) {
      if (!out.has(r.pk)) out.set(r.pk, new Set())
      out.get(r.pk).add(r.name)
    }
    return out
  }

  function shape(r, people) {
    const hasLocation = r.lat != null && r.lon != null && r.lat >= -90 && r.lat <= 90 && r.lon >= -180 && r.lon <= 180 && !(r.lat === -180 && r.lon === -180)
    return {
      id: r.uuid,
      takenAt: new Date(r.taken * 1000).toISOString(),
      kind: r.kind === 0 && r.subtype === 10 ? 'screenshot' : KIND[r.kind] || 'other',
      favorite: !!r.favorite,
      fileName: r.originalName || r.filename,
      width: r.width, height: r.height,
      ...(r.kind === 1 && r.duration ? { durationSec: Math.round(r.duration) } : {}),
      location: hasLocation ? { lat: Number(r.lat.toFixed(5)), lon: Number(r.lon.toFixed(5)) } : null,
      place: [r.place, r.placeDetail].filter(Boolean).join(' · ') || null,
      people: [...(people.get(r.pk) || [])],
      ...(r.title ? { title: r.title } : {}),
      ...(r.caption ? { caption: r.caption } : {}),
    }
  }

  function search({ text = '', person = '', album = '', place = '', from = null, to = null, favorite = null, kind = null, limit = 30, offset = 0 } = {}) {
    const found = text ? searchIndex(text) : null
    return withDb(dbFile, (db) => {
      const where = []
      const params = []
      if (from) { where.push(`a.ZDATECREATED >= ?`); params.push(Date.parse(from) / 1000 - APPLE_EPOCH_S) }
      if (to) {
        // A bare date means "through the end of that day".
        const end = /^\d{4}-\d{2}-\d{2}$/.test(to) ? Date.parse(`${to}T23:59:59`) : Date.parse(to)
        where.push(`a.ZDATECREATED <= ?`); params.push(end / 1000 - APPLE_EPOCH_S)
      }
      if (favorite === true) where.push('a.ZFAVORITE = 1')
      if (kind === 'photo') where.push('a.ZKIND = 0')
      if (kind === 'video') where.push('a.ZKIND = 1')
      if (kind === 'screenshot') where.push('a.ZKIND = 0 AND a.ZKINDSUBTYPE = 10')
      if (person) {
        where.push(`a.Z_PK IN (SELECT f.ZASSETFORFACE FROM ZDETECTEDFACE f JOIN ZPERSON p ON p.Z_PK = f.ZPERSONFORFACE
          WHERE p.ZFULLNAME LIKE ? OR p.ZDISPLAYNAME LIKE ?)`)
        params.push(`%${person}%`, `%${person}%`)
      }
      if (album) {
        const j = albumJoin(db)
        if (!j.table) return { photos: [], total: 0, note: 'Album membership is not readable in this Photos library version.' }
        where.push(`a.Z_PK IN (SELECT x.${j.assets} FROM ${j.table} x JOIN ZGENERICALBUM g ON g.Z_PK = x.${j.albums} WHERE g.ZTITLE LIKE ? AND g.ZTRASHEDSTATE = 0)`)
        params.push(`%${album}%`)
      }
      if (place) { where.push('(mo.ZTITLE LIKE ? OR mo.ZSUBTITLE LIKE ?)'); params.push(`%${place}%`, `%${place}%`) }
      // Without the Photos search index, look for the words where Photos.sqlite
      // keeps text of its own.
      if (text && !found) {
        for (const word of splitTerms(text).flatMap((p) => p.split(/\s+/)).filter((w) => w && !STOPWORDS.has(w))) {
          where.push(`(aa.ZTITLE LIKE ? OR d.ZLONGDESCRIPTION LIKE ? OR aa.ZORIGINALFILENAME LIKE ? OR mo.ZTITLE LIKE ? OR mo.ZSUBTITLE LIKE ?
            OR a.Z_PK IN (SELECT f.ZASSETFORFACE FROM ZDETECTEDFACE f JOIN ZPERSON p ON p.Z_PK = f.ZPERSONFORFACE WHERE p.ZFULLNAME LIKE ? OR p.ZDISPLAYNAME LIKE ?))`)
          params.push(...Array(7).fill(`%${word}%`))
        }
      }
      let rows = db.prepare(`${ASSET_SELECT} ${where.length ? `AND ${where.join(' AND ')}` : ''} ORDER BY a.ZDATECREATED DESC`).all(...params)
      if (found?.uuids) rows = rows.filter((r) => found.uuids.has(r.uuid))
      const total = rows.length
      const start = Math.max(0, Number(offset) || 0)
      const page = rows.slice(start, start + Math.max(1, Math.min(200, Number(limit) || 30)))
      const people = peopleFor(db, page.map((r) => r.pk))
      return {
        photos: page.map((r) => shape(r, people)),
        total,
        ...(found ? { understoodAs: found.terms.map((t) => ({ term: t.term, matches: t.labels, as: t.categories })) } : {}),
        ...(text && !found ? { note: 'The Photos search index was not found, so text matched titles, captions, file names, places and people only.' } : {}),
      }
    })
  }

  function get(uuid) {
    return withDb(dbFile, (db) => {
      const r = db.prepare(`${ASSET_SELECT} AND a.ZUUID = ?`).get(String(uuid))
      if (!r) return null
      const photo = shape(r, peopleFor(db, [r.pk]))
      const j = albumJoin(db)
      if (j.table) {
        photo.albums = db.prepare(`SELECT g.ZTITLE title FROM ${j.table} x JOIN ZGENERICALBUM g ON g.Z_PK = x.${j.albums} WHERE x.${j.assets} = ? AND g.ZTITLE IS NOT NULL AND g.ZTRASHEDSTATE = 0`).all(r.pk).map((x) => x.title)
      }
      const idx = loadIndex()
      if (idx) {
        const item = idx.items.find((i) => i.uuid === r.uuid)
        if (item) {
          const labels = idx.lexicon.filter((l) => l.type === 1 && item.ids.has(l.id) && [4000, 4010, 4020, 4060, 4090, 3010, 4130].includes(l.category)).map((l) => l.content)
          photo.labels = [...new Set(labels)].slice(0, 25)
        }
      }
      return photo
    })
  }

  function people({ limit = 100 } = {}) {
    return withDb(dbFile, (db) => db.prepare(`
      SELECT COALESCE(NULLIF(ZFULLNAME, ''), ZDISPLAYNAME) name, ZFACECOUNT photos FROM ZPERSON
      WHERE COALESCE(NULLIF(ZFULLNAME, ''), ZDISPLAYNAME) IS NOT NULL ORDER BY ZFACECOUNT DESC LIMIT ?
    `).all(Math.max(1, Math.min(1000, Number(limit) || 100))).map((r) => ({ ...r })))
  }

  function albums() {
    return withDb(dbFile, (db) => {
      const j = albumJoin(db)
      const count = j.table ? `(SELECT COUNT(*) FROM ${j.table} x WHERE x.${j.albums} = g.Z_PK)` : 'NULL'
      return db.prepare(`SELECT g.ZTITLE title, ${count} items FROM ZGENERICALBUM g WHERE g.ZKIND = 2 AND g.ZTITLE IS NOT NULL AND g.ZTRASHEDSTATE = 0 ORDER BY g.ZTITLE`).all().map((r) => ({ ...r }))
    })
  }

  function stats() {
    return withDb(dbFile, (db) => {
      const r = db.prepare(`SELECT SUM(ZKIND = 0) photos, SUM(ZKIND = 1) videos, MIN(ZDATECREATED) first, MAX(ZDATECREATED) last FROM ZASSET WHERE ZTRASHEDSTATE = 0 AND ZHIDDEN = 0`).get()
      return {
        photos: r.photos || 0, videos: r.videos || 0,
        oldest: r.first != null ? new Date((r.first + APPLE_EPOCH_S) * 1000).toISOString() : null,
        newest: r.last != null ? new Date((r.last + APPLE_EPOCH_S) * 1000).toISOString() : null,
        searchIndex: !!indexFile,
      }
    })
  }

  // A JPEG on disk for this asset: the largest local derivative, else the
  // original converted with sips. Null when iCloud holds the only copy.
  async function imageFile(uuid, { maxPx = 1600 } = {}) {
    const id = String(uuid || '')
    if (!/^[0-9A-F-]{36}$/i.test(id)) return null
    const row = withDb(dbFile, (db) => db.prepare('SELECT ZFILENAME filename, ZDIRECTORY dir FROM ZASSET WHERE ZUUID = ?').get(id))
    if (!row) return null
    const shard = id[0].toUpperCase()
    const candidates = []
    for (const dir of [join(library, 'resources', 'derivatives', shard), join(library, 'resources', 'derivatives', 'masters', shard)]) {
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) {
        if (name.startsWith(id) && /\.jpe?g$/i.test(name)) {
          try { candidates.push({ path: join(dir, name), size: statSync(join(dir, name)).size }) } catch { /* vanished */ }
        }
      }
    }
    candidates.sort((a, b) => b.size - a.size)
    if (candidates[0]) return { path: candidates[0].path, mime: 'image/jpeg', source: 'derivative' }
    const original = row.dir && row.filename ? join(library, 'originals', row.dir, row.filename) : null
    if (!original || !existsSync(original)) return null
    if (/\.jpe?g$/i.test(original)) return { path: original, mime: 'image/jpeg', source: 'original' }
    if (!cacheDir) return null
    mkdirSync(cacheDir, { recursive: true })
    const out = join(cacheDir, `${id}-${maxPx}.jpg`)
    if (!existsSync(out)) {
      await new Promise((resolve, reject) => exec('sips', ['-s', 'format', 'jpeg', '-Z', String(maxPx), original, '--out', out], { timeout: 30_000 }, (err) => (err ? reject(err) : resolve())))
    }
    return { path: out, mime: 'image/jpeg', source: 'converted' }
  }

  return { search, get, people, albums, stats, imageFile, hasSearchIndex: () => !!indexFile }
}
