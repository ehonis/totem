// search/index.mjs — one keyword index over everything Totem holds.
//
// "Where did I tell you about the watches?" is a lookup, not a question for a
// model. This is SQLite FTS5 (BM25 ranking, porter stemming so "watch" finds
// "watches") in an in-memory database, rebuilt from the sources when a search
// arrives and the last build is older than `staleMs`. Everything here is a few
// hundred files and a few thousand rows, so a full rebuild is milliseconds and
// there is no incremental bookkeeping to get wrong.
//
// A source is { kind, load: async () => doc[] }. A doc is
//   { id, title, body, date?, target? }
// `id` is unique within its kind; the index prefixes it (`note:people/sam.md#3`).
// `target` is where the dashboard should go to open it (a NavTarget plus extras).
// A source that throws is skipped for that build and reported, never fatal: a
// corrupt journal entry must not take search down with it.
import { DatabaseSync } from 'node:sqlite'

// Highlight markers: control characters no real text contains, so the client
// can split on them without escaping anything.
export const MARK_START = '\u0002'
export const MARK_END = '\u0003'

const MAX_BODY = 60_000

/**
 * The user's words as an FTS5 query: every word must appear (as a prefix, so a
 * half-typed word already matches). Quoting each term means FTS syntax in the
 * input (`-`, `:`, `NEAR`, quotes) is searched for, not interpreted.
 */
export function ftsQuery(text, { any = false } = {}) {
  const terms = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
  const unique = [...new Set(terms)].slice(0, 12)
  if (!unique.length) return ''
  return unique.map((t) => `"${t}"*`).join(any ? ' OR ' : ' ')
}

export function createSearchIndex({ sources = [], staleMs = 30_000, now = () => Date.now(), log = () => {} } = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE VIRTUAL TABLE docs USING fts5(
    key UNINDEXED, kind UNINDEXED, title, body, date UNINDEXED, target UNINDEXED,
    tokenize = 'porter unicode61 remove_diacritics 2'
  )`)
  const insert = db.prepare('INSERT INTO docs (key, kind, title, body, date, target) VALUES (?, ?, ?, ?, ?, ?)')
  const byKey = db.prepare('SELECT key, kind, title, body, date, target FROM docs WHERE key = ?')
  const countAll = db.prepare('SELECT kind, count(*) AS n FROM docs GROUP BY kind')

  let builtAt = null
  let building = null
  let stats = { docs: 0, tookMs: 0, errors: [] }

  async function build() {
    const started = now()
    const loaded = await Promise.all(sources.map(async (s) => {
      try { return { kind: s.kind, docs: (await s.load()) || [] } }
      catch (e) { return { kind: s.kind, docs: [], error: e?.message || String(e) } }
    }))
    const errors = loaded.filter((l) => l.error).map((l) => ({ kind: l.kind, error: l.error }))
    for (const e of errors) log(`search: ${e.kind} source failed: ${e.error}`)
    let n = 0
    db.exec('BEGIN')
    try {
      db.exec('DELETE FROM docs')
      for (const { kind, docs } of loaded) {
        for (const d of docs) {
          if (!d || d.id == null) continue
          const title = String(d.title || '').slice(0, 300)
          const body = String(d.body || '').slice(0, MAX_BODY)
          if (!title.trim() && !body.trim()) continue
          insert.run(`${kind}:${d.id}`, kind, title, body, d.date ? String(d.date) : null, d.target ? JSON.stringify(d.target) : null)
          n += 1
        }
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    builtAt = now()
    stats = { docs: n, tookMs: builtAt - started, errors }
  }

  async function refresh({ force = false } = {}) {
    if (!force && builtAt !== null && now() - builtAt < staleMs) return
    if (!building) building = build().finally(() => { building = null })
    await building
  }

  const row = (r, snippet) => ({
    id: r.key,
    kind: r.kind,
    title: r.title,
    ...(snippet !== undefined ? { snippet } : {}),
    date: r.date || null,
    target: r.target ? JSON.parse(r.target) : null,
  })

  function run(match, kinds, limit) {
    const kindFilter = kinds.length ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : ''
    // Title hits count five times a body hit: a note *called* "Watches" beats one
    // that mentions a watch in passing.
    const rows = db.prepare(`SELECT key, kind, title, date, target,
        highlight(docs, 2, '${MARK_START}', '${MARK_END}') AS titleMarked,
        snippet(docs, 3, '${MARK_START}', '${MARK_END}', '…', 28) AS snippet,
        bm25(docs, 0, 0, 5.0, 1.0) AS score
      FROM docs WHERE docs MATCH ?${kindFilter}
      ORDER BY score LIMIT ?`).all(match, ...kinds, limit)
    const counts = {}
    for (const r of db.prepare(`SELECT kind, count(*) AS n FROM docs WHERE docs MATCH ? GROUP BY kind`).all(match)) counts[r.kind] = r.n
    return { rows, counts }
  }

  async function search(text, { kinds = [], limit = 30 } = {}) {
    await refresh()
    const started = now()
    const wanted = (Array.isArray(kinds) ? kinds : String(kinds || '').split(',')).map((k) => String(k).trim()).filter(Boolean)
    const max = Math.min(Math.max(Number(limit) || 30, 1), 100)
    const all = ftsQuery(text)
    if (!all) return { query: String(text || ''), results: [], counts: {}, total: 0, loose: false, tookMs: 0 }
    let res = run(all, wanted, max)
    // Nothing has every word: fall back to any of them, and say so.
    let loose = false
    if (!res.rows.length && all.includes(' ')) { res = run(ftsQuery(text, { any: true }), wanted, max); loose = true }
    const total = Object.values(res.counts).reduce((a, b) => a + b, 0)
    return {
      query: String(text),
      results: res.rows.map((r) => ({ ...row(r, r.snippet), titleMarked: r.titleMarked })),
      counts: res.counts,
      total,
      loose,
      tookMs: now() - started,
    }
  }

  /** One doc in full, by the id a search returned. */
  async function get(id) {
    await refresh()
    const r = byKey.get(String(id || ''))
    return r ? { ...row(r), body: r.body } : null
  }

  async function status() {
    await refresh()
    const counts = {}
    for (const r of countAll.all()) counts[r.kind] = r.n
    return { ...stats, counts, builtAt }
  }

  return { search, get, refresh, status, close: () => db.close() }
}

/** A search hit as plain text: highlights shown as [brackets], for agents and logs. */
export function plainMarks(text) {
  return String(text || '').split(MARK_START).join('[').split(MARK_END).join(']')
}
