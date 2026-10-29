// Google Drive for the owner's Google accounts: find, read, create, copy, rename,
// move and trash files, plus cell-level Google Sheets and Google Docs edits.
//
// Accounts are labelled like Gmail's and kept in their own 0600 token file. The
// grant is the full `drive` scope, which the Sheets and Docs APIs also accept, so
// one sign-in reaches every file the account can open. Two things are deliberately
// not here: sharing (it hands a file to someone else, which is the owner's call)
// and permanent delete (trash keeps a file for 30 days). See docs/drive.md.
//
// The OAuth client is the same Desktop client Calendar and Gmail use; the Drive,
// Sheets and Docs APIs have to be enabled on its Google Cloud project.

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createGoogleAccounts, GoogleError, splitRef, mapLimit } from '../google/accounts.mjs'

export const DriveError = GoogleError
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'
const DRIVE = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'
const DOCS = 'https://docs.googleapis.com/v1/documents'
const MAX_DOWNLOAD = 50 * 1024 * 1024

const G = 'application/vnd.google-apps.'
export const TYPES = {
  doc: `${G}document`,
  sheet: `${G}spreadsheet`,
  slides: `${G}presentation`,
  folder: `${G}folder`,
  form: `${G}form`,
  pdf: 'application/pdf',
}
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,createdTime,size,owners(emailAddress),parents,webViewLink,starred,trashed,description,driveId,lastModifyingUser(emailAddress)'

// Which API a request went to, for the "not enabled" message.
const API_NAMES = [[SHEETS, 'Google Sheets API'], [DOCS, 'Google Docs API'], [UPLOAD, 'Google Drive API'], [DRIVE, 'Google Drive API']]

// Text a model can read straight from the download.
const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|x-sh|sql|csv|x-ndjson))/

const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

// Plain words become a name/full-text search; `q` passes Drive's own syntax through.
export function buildQuery({ query = '', q = '', type = '', folderId = '', includeTrashed = false } = {}) {
  const parts = []
  if (q) parts.push(`(${q})`)
  const words = String(query || '').trim()
  if (words) parts.push(`(name contains ${quote(words)} or fullText contains ${quote(words)})`)
  if (type) {
    const mime = TYPES[type] || (String(type).includes('/') ? type : null)
    if (!mime) throw new DriveError(`type: one of ${Object.keys(TYPES).join(', ')}, or a MIME type`)
    parts.push(`mimeType = ${quote(mime)}`)
  }
  if (folderId) parts.push(`${quote(folderId)} in parents`)
  if (!includeTrashed && !/\btrashed\b/.test(q)) parts.push('trashed = false')
  return parts.join(' and ')
}

// A 2-D array of cells, from a list of rows or one row.
function grid(values) {
  if (!Array.isArray(values)) throw new DriveError('values must be a list of rows, each a list of cells')
  const rows = values.length && !Array.isArray(values[0]) ? [values] : values
  if (rows.length > 10_000) throw new DriveError('at most 10,000 rows per call')
  return rows.map((row) => (Array.isArray(row) ? row : [row]).map((c) => (c == null ? '' : c)))
}

export function createDrive({ tokensFile, loadClient, redirectUri, cacheDir = null, fetchImpl = fetch, now = Date.now } = {}) {
  const accounts = createGoogleAccounts({
    name: 'Google Drive', scope: DRIVE_SCOPE, tokensFile, loadClient, redirectUri, fetchImpl, now,
    describe: async (label) => {
      const a = await api(label, `${DRIVE}/about`, { query: { fields: 'user(emailAddress,displayName),storageQuota(limit,usage)' } })
      return { email: a.user?.emailAddress || '', name: a.user?.displayName || '', storage: a.storageQuota || null }
    },
  })
  const { configured, accountLabels, requireAccount, listAccounts, startAuth, completeAuth, removeAccount, renameAccount } = accounts

  // `raw` returns the Response (downloads); otherwise the parsed JSON.
  async function api(account, url, { method = 'GET', query = null, body = undefined, headers = {}, raw = false } = {}) {
    const token = await accounts.accessToken(account)
    const u = new URL(url)
    for (const [k, v] of Object.entries(query || {})) {
      if (v == null || v === '') continue
      for (const one of Array.isArray(v) ? v : [v]) u.searchParams.append(k, String(one))
    }
    const isJson = body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)
    const r = await fetchImpl(u, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(isJson ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : isJson ? JSON.stringify(body) : body,
    })
    if (r.ok && raw) return r
    if (r.status === 204) return {}
    const text = await r.text()
    let json = null
    try { json = text ? JSON.parse(text) : {} } catch {}
    if (!r.ok) {
      const msg = json?.error?.message || text.slice(0, 200)
      if (r.status === 401) accounts.forget(account)
      if (r.status === 403 && /has not been used|is disabled/i.test(msg)) {
        const apiName = API_NAMES.find(([base]) => String(url).startsWith(base))?.[1] || 'Google Drive API'
        throw new DriveError(`The ${apiName} is not enabled on the Google Cloud project behind Totem's OAuth client. Enable it in the Cloud console (APIs & Services → Library → ${apiName}).`, 409)
      }
      if (r.status === 403 && /insufficient.*scope/i.test(msg)) {
        throw new DriveError(`Google Drive "${account}" was connected without full Drive access. Remove it in Settings → Connections and add it again.`, 409)
      }
      if (r.status === 400 && /not supported for this document/i.test(msg)) {
        throw new DriveError('That file is not a native Google file (an uploaded .xlsx or .docx, say). Read it with drive read_file, or make a Google copy with copy_file and convert:true, then edit the copy.', 400)
      }
      const where = String(url).replace(/^https:\/\/[^/]+/, '').split('?')[0]
      throw new DriveError(`Google Drive "${account}" ${method} ${where} HTTP ${r.status}: ${msg}`, r.status >= 500 ? 502 : r.status)
    }
    return json ?? {}
  }

  const ref = (account, id) => `${account}:${id}`

  function resolve(id, account) {
    const { account: acct, id: raw } = splitRef(id, account, accountLabels())
    return { a: requireAccount(acct), id: raw }
  }

  function summarize(account, f) {
    return {
      id: ref(account, f.id),
      account,
      name: f.name || '',
      type: Object.keys(TYPES).find((k) => TYPES[k] === f.mimeType) || 'file',
      mimeType: f.mimeType || '',
      modifiedTime: f.modifiedTime || '',
      size: f.size != null ? Number(f.size) : null,
      owners: (f.owners || []).map((o) => o.emailAddress),
      parents: (f.parents || []).map((p) => ref(account, p)),
      url: f.webViewLink || '',
      starred: Boolean(f.starred),
      trashed: Boolean(f.trashed),
      ...(f.description ? { description: f.description } : {}),
    }
  }

  const getMeta = (a, id) => api(a, `${DRIVE}/files/${encodeURIComponent(id)}`, { query: { fields: FILE_FIELDS, supportsAllDrives: 'true' } })

  // ---- Finding --------------------------------------------------------------------

  async function searchOne(a, { q, max, pageToken, orderBy }) {
    const list = await api(a, `${DRIVE}/files`, {
      query: {
        q, pageSize: max, pageToken, orderBy, fields: `nextPageToken,files(${FILE_FIELDS})`,
        corpora: 'allDrives', includeItemsFromAllDrives: 'true', supportsAllDrives: 'true',
      },
    })
    return { files: (list.files || []).map((f) => summarize(a, f)), nextPageToken: list.nextPageToken ? ref(a, list.nextPageToken) : null }
  }

  // With no account, every connected account is searched and merged by last edit.
  async function search({ query = '', q = '', type = '', folderId = '', account = null, max = 25, pageToken = null, includeTrashed = false } = {}) {
    const limit = Math.max(1, Math.min(100, Number(max) || 25))
    let folder = ''
    let scoped = account
    if (folderId) ({ a: scoped, id: folder } = resolve(folderId, account))
    const query_ = buildQuery({ query, q, type, folderId: folder, includeTrashed })
    // fullText search is ranked by relevance; Drive refuses orderBy with it.
    const orderBy = query ? undefined : 'modifiedTime desc'
    if (pageToken) {
      const { a, id } = resolve(pageToken, scoped)
      return { q: query_, ...(await searchOne(a, { q: query_, max: limit, pageToken: id, orderBy })) }
    }
    const list = scoped ? [requireAccount(scoped)] : accountLabels()
    if (!list.length) requireAccount(null)
    const settled = await Promise.allSettled(list.map((a) => searchOne(a, { q: query_, max: limit, orderBy })))
    const files = []
    const errors = []
    const nextPageTokens = {}
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        files.push(...r.value.files)
        if (r.value.nextPageToken) nextPageTokens[list[i]] = r.value.nextPageToken
      } else errors.push(`${list[i]}: ${r.reason?.message || r.reason}`)
    })
    if (!query) files.sort((x, y) => (Date.parse(y.modifiedTime) || 0) - (Date.parse(x.modifiedTime) || 0))
    return { q: query_, files, nextPageTokens, errors }
  }

  // ---- Reading ---------------------------------------------------------------------

  const clip = (text, maxChars) => (text.length > maxChars
    ? `${text.slice(0, maxChars)}\n\n[… ${text.length - maxChars} more characters; read again with a larger maxChars]`
    : text)

  async function exportText(a, id, mimeTypes) {
    let last = null
    for (const mimeType of mimeTypes) {
      try {
        const r = await api(a, `${DRIVE}/files/${encodeURIComponent(id)}/export`, { query: { mimeType }, raw: true })
        return await r.text()
      } catch (e) { last = e; if (e.status !== 400) throw e }
    }
    throw last
  }

  async function download(a, id, name) {
    if (!cacheDir) throw new DriveError('downloads are unavailable: no cache directory')
    const r = await api(a, `${DRIVE}/files/${encodeURIComponent(id)}`, { query: { alt: 'media', supportsAllDrives: 'true' }, raw: true })
    const bytes = Buffer.from(await r.arrayBuffer())
    if (bytes.length > MAX_DOWNLOAD) throw new DriveError(`file is over ${MAX_DOWNLOAD / 1024 / 1024} MB`)
    const safe = String(name || 'file').replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file'
    const path = join(cacheDir, a, id, safe)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes, { mode: 0o600 })
    return { path, bytes }
  }

  // What a file says, in the form that suits it: a Doc as Markdown, a Sheet as its
  // tabs plus the first one's cells, a folder as its contents, text as text, and
  // anything else (PDF, .xlsx, images) saved to a file on this machine.
  async function readFile({ id, account = null, maxChars = 30_000, maxRows = 200 } = {}) {
    const { a, id: raw } = resolve(id, account)
    const cap = Math.max(500, Math.min(300_000, Number(maxChars) || 30_000))
    const meta = await getMeta(a, raw)
    const file = summarize(a, meta)
    const mime = meta.mimeType || ''
    if (mime === TYPES.doc) {
      return { file, format: 'markdown', content: clip(await exportText(a, raw, ['text/markdown', 'text/plain']), cap) }
    }
    if (mime === TYPES.slides) {
      return { file, format: 'text', content: clip(await exportText(a, raw, ['text/plain']), cap) }
    }
    if (mime === TYPES.sheet) {
      const info = await sheetInfo({ id: file.id })
      const first = info.tabs[0]
      const rows = Math.max(1, Math.min(2000, Number(maxRows) || 200))
      const preview = first ? await sheetRead({ id: file.id, ranges: [`${tabRef(first.title)}!1:${rows}`] }) : { ranges: [] }
      return { file, format: 'sheet', tabs: info.tabs, ...(preview.ranges[0] ? { preview: preview.ranges[0] } : {}), nextStep: 'Read other tabs or ranges with sheet_read; edit with sheet_write, sheet_append or sheet_batch_update.' }
    }
    if (mime === TYPES.folder) {
      const out = await search({ folderId: file.id, max: 100 })
      return { file, format: 'folder', files: out.files }
    }
    if (mime.startsWith(G)) {
      return { file, format: 'unsupported', content: '', nextStep: `Totem cannot read a ${mime.slice(G.length)} file; open it at ${file.url}.` }
    }
    const { path, bytes } = await download(a, raw, meta.name)
    if (TEXTUAL.test(mime) && bytes.length <= 5 * 1024 * 1024) {
      return { file, format: 'text', content: clip(bytes.toString('utf8'), cap), path }
    }
    return { file, format: 'download', path, nextStep: 'Open the file at path with your own tools. To edit an Office file in place as a Google file, copy_file with convert:true.' }
  }

  // ---- Files -------------------------------------------------------------------------

  function multipart(metadata, content, mediaType) {
    const boundary = `totem${Math.random().toString(36).slice(2)}`
    const body = [
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\ncontent-type: ${mediaType}; charset=UTF-8\r\n\r\n${content}\r\n`,
      `--${boundary}--`,
    ].join('')
    return { body, contentType: `multipart/related; boundary=${boundary}` }
  }

  // A Doc from plain text or Markdown, a Sheet from CSV, a folder, or a plain file.
  async function createFile({ name, type = 'doc', content = '', format = 'text', folderId = null, account = null, mimeType = null } = {}) {
    const title = String(name || '').trim()
    if (!title) throw new DriveError('name is required')
    if (!['doc', 'sheet', 'slides', 'folder', 'file'].includes(type)) throw new DriveError('type: doc, sheet, slides, folder or file')
    let a = folderId ? null : requireAccount(account)
    let parents
    if (folderId) { const r = resolve(folderId, account); a = r.a; parents = [r.id] }
    const text = String(content ?? '')
    if (text.length > 5_000_000) throw new DriveError('content is too long (5,000,000 characters max)')
    const metadata = { name: title, ...(parents ? { parents } : {}) }
    let created
    if (type === 'folder' || type === 'slides' || !text) {
      metadata.mimeType = type === 'file' ? (mimeType || 'text/plain') : TYPES[type]
      created = await api(a, `${DRIVE}/files`, { method: 'POST', query: { fields: FILE_FIELDS, supportsAllDrives: 'true' }, body: metadata })
    } else {
      // Drive converts an upload into a Google file when metadata names the Google type.
      const media = type === 'sheet' ? 'text/csv' : type === 'doc' ? (format === 'markdown' ? 'text/markdown' : 'text/plain') : (mimeType || 'text/plain')
      if (type !== 'file') metadata.mimeType = TYPES[type]
      const { body, contentType } = multipart(metadata, text, media)
      created = await api(a, `${UPLOAD}/files`, {
        method: 'POST', query: { uploadType: 'multipart', fields: FILE_FIELDS, supportsAllDrives: 'true' },
        body, headers: { 'content-type': contentType },
      })
    }
    return { ok: true, file: summarize(a, created) }
  }

  // Copying is also how an uploaded .xlsx/.docx becomes an editable Google file.
  async function copyFile({ id, name = null, folderId = null, convert = false, account = null } = {}) {
    const { a, id: raw } = resolve(id, account)
    const body = {}
    if (name) body.name = String(name)
    if (folderId) body.parents = [resolve(folderId, a).id]
    if (convert) {
      const meta = await getMeta(a, raw)
      const m = meta.mimeType || ''
      body.mimeType = /spreadsheet|excel|csv/.test(m) ? TYPES.sheet
        : /wordprocessing|msword|opendocument\.text|rtf|text\/plain/.test(m) ? TYPES.doc
          : /presentation|powerpoint/.test(m) ? TYPES.slides : null
      if (!body.mimeType || m.startsWith(G)) throw new DriveError(`convert: "${meta.name}" (${m}) has no Google equivalent to convert to`)
      if (!name) body.name = String(meta.name || 'Copy').replace(/\.(xlsx?|docx?|pptx?|csv|odt|ods|rtf|txt)$/i, '')
    }
    const f = await api(a, `${DRIVE}/files/${encodeURIComponent(raw)}/copy`, { method: 'POST', query: { fields: FILE_FIELDS, supportsAllDrives: 'true' }, body })
    return { ok: true, file: summarize(a, f) }
  }

  // Rename, describe, star or move. Content goes through the Sheets and Docs tools,
  // or `content` for a plain (non-Google) file.
  async function updateFile({ id, name, description, starred, moveTo = null, content, account = null } = {}) {
    const { a, id: raw } = resolve(id, account)
    const body = {}
    if (name != null) { if (!String(name).trim()) throw new DriveError('name cannot be empty'); body.name = String(name).trim() }
    if (description != null) body.description = String(description)
    if (starred != null) body.starred = Boolean(starred)
    const query = { fields: FILE_FIELDS, supportsAllDrives: 'true' }
    if (moveTo) {
      const meta = await getMeta(a, raw)
      query.addParents = resolve(moveTo, a).id
      if (meta.parents?.length) query.removeParents = meta.parents.join(',')
    }
    if (content != null) {
      const meta = await getMeta(a, raw)
      if ((meta.mimeType || '').startsWith(G)) throw new DriveError('content replaces only plain files. Edit a Google Doc with doc_edit and a Sheet with sheet_write.')
      const { body: mp, contentType } = multipart(body, String(content), meta.mimeType || 'text/plain')
      const f = await api(a, `${UPLOAD}/files/${encodeURIComponent(raw)}`, { method: 'PATCH', query: { ...query, uploadType: 'multipart' }, body: mp, headers: { 'content-type': contentType } })
      return { ok: true, file: summarize(a, f) }
    }
    if (!Object.keys(body).length && !moveTo) throw new DriveError('nothing to change: give name, description, starred, moveTo or content')
    const f = await api(a, `${DRIVE}/files/${encodeURIComponent(raw)}`, { method: 'PATCH', query, body })
    return { ok: true, file: summarize(a, f) }
  }

  // Trash keeps a file for 30 days; there is deliberately no permanent delete.
  async function trash({ ids, untrash = false, account = null } = {}) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean)
    if (!list.length) throw new DriveError('ids is required')
    if (list.length > 100) throw new DriveError('at most 100 files per call')
    const done = await mapLimit(list, 6, async (one) => {
      const { a, id } = resolve(one, account)
      const f = await api(a, `${DRIVE}/files/${encodeURIComponent(id)}`, { method: 'PATCH', query: { fields: FILE_FIELDS, supportsAllDrives: 'true' }, body: { trashed: !untrash } })
      return summarize(a, f)
    })
    return { ok: true, changed: done.length, trashed: !untrash, files: done }
  }

  // ---- Google Sheets ------------------------------------------------------------------

  function sheetId(id, account) {
    const { a, id: raw } = resolve(id, account)
    return { a, id: raw, url: `${SHEETS}/${encodeURIComponent(raw)}` }
  }

  async function sheetInfo({ id, account = null } = {}) {
    const s = sheetId(id, account)
    const meta = await api(s.a, s.url, { query: { fields: 'spreadsheetId,properties(title,timeZone,locale),sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount))),namedRanges(name,range)' } })
    return {
      id: ref(s.a, meta.spreadsheetId),
      title: meta.properties?.title || '',
      timeZone: meta.properties?.timeZone || '',
      tabs: (meta.sheets || []).map(({ properties: p }) => ({
        sheetId: p.sheetId, title: p.title, index: p.index, hidden: Boolean(p.hidden),
        rows: p.gridProperties?.rowCount ?? null, columns: p.gridProperties?.columnCount ?? null,
        frozenRows: p.gridProperties?.frozenRowCount || 0, frozenColumns: p.gridProperties?.frozenColumnCount || 0,
      })),
      namedRanges: (meta.namedRanges || []).map((n) => n.name),
      url: `https://docs.google.com/spreadsheets/d/${meta.spreadsheetId}/edit`,
    }
  }

  const RENDER = { formatted: 'FORMATTED_VALUE', unformatted: 'UNFORMATTED_VALUE', formula: 'FORMULA' }

  async function sheetRead({ id, ranges = [], render = 'formatted', account = null, maxCells = 20_000 } = {}) {
    const s = sheetId(id, account)
    let list = (Array.isArray(ranges) ? ranges : [ranges]).filter(Boolean).map(String)
    if (!list.length) list = [tabRef((await sheetInfo({ id: ref(s.a, s.id) })).tabs[0]?.title || 'Sheet1')]
    if (list.length > 50) throw new DriveError('at most 50 ranges per call')
    if (!RENDER[render]) throw new DriveError('render: formatted, unformatted or formula')
    const out = await api(s.a, `${s.url}/values:batchGet`, { query: { ranges: list, valueRenderOption: RENDER[render], dateTimeRenderOption: 'FORMATTED_STRING' } })
    let budget = Math.max(100, Math.min(200_000, Number(maxCells) || 20_000))
    const result = (out.valueRanges || []).map((v) => {
      const values = v.values || []
      const kept = []
      for (const row of values) {
        if (budget <= 0) break
        kept.push(row)
        budget -= Math.max(1, row.length)
      }
      return { range: v.range, rows: values.length, values: kept, ...(kept.length < values.length ? { truncated: true } : {}) }
    })
    return { id: ref(s.a, s.id), ranges: result }
  }

  // USER_ENTERED, so "=SUM(A1:A3)", "3/4/2026" and "12%" land as a formula, a date
  // and a number, as if typed. `raw:true` stores every value as literal text.
  async function sheetWrite({ id, data = [], raw = false, account = null } = {}) {
    const s = sheetId(id, account)
    const list = (Array.isArray(data) ? data : [data]).filter(Boolean)
    if (!list.length) throw new DriveError('data is required: [{ range: "Tab!A1", values: [[...], ...] }]')
    const payload = list.map((d) => {
      if (!d.range) throw new DriveError('every data entry needs a range (A1 notation, e.g. "Action Items!B5:D5")')
      return { range: String(d.range), values: grid(d.values) }
    })
    const out = await api(s.a, `${s.url}/values:batchUpdate`, { method: 'POST', body: { valueInputOption: raw ? 'RAW' : 'USER_ENTERED', data: payload } })
    return {
      ok: true, id: ref(s.a, s.id),
      updatedCells: out.totalUpdatedCells || 0, updatedRows: out.totalUpdatedRows || 0,
      updatedRanges: (out.responses || []).map((r) => r.updatedRange),
    }
  }

  // New rows after the last row of the table found in `range` (a tab name is enough).
  async function sheetAppend({ id, range, values, raw = false, account = null } = {}) {
    const s = sheetId(id, account)
    if (!range) throw new DriveError('range is required: the tab ("Action Items") or the table ("Action Items!B4:G")')
    const out = await api(s.a, `${s.url}/values/${encodeURIComponent(String(range))}:append`, {
      method: 'POST',
      query: { valueInputOption: raw ? 'RAW' : 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' },
      body: { values: grid(values) },
    })
    return { ok: true, id: ref(s.a, s.id), updatedRange: out.updates?.updatedRange || '', updatedRows: out.updates?.updatedRows || 0 }
  }

  async function sheetClear({ id, ranges = [], account = null } = {}) {
    const s = sheetId(id, account)
    const list = (Array.isArray(ranges) ? ranges : [ranges]).filter(Boolean).map(String)
    if (!list.length) throw new DriveError('ranges is required')
    const out = await api(s.a, `${s.url}/values:batchClear`, { method: 'POST', body: { ranges: list } })
    return { ok: true, id: ref(s.a, s.id), clearedRanges: out.clearedRanges || [] }
  }

  // The Sheets API's own batchUpdate: tabs, formatting, sorting, filters, validation,
  // inserting or deleting rows and columns. Requests pass through as written.
  async function sheetBatchUpdate({ id, requests = [], account = null } = {}) {
    const s = sheetId(id, account)
    if (!Array.isArray(requests) || !requests.length) throw new DriveError('requests is required: a list of Sheets API batchUpdate requests')
    if (requests.length > 200) throw new DriveError('at most 200 requests per call')
    const out = await api(s.a, `${s.url}:batchUpdate`, { method: 'POST', body: { requests } })
    return { ok: true, id: ref(s.a, s.id), replies: out.replies || [] }
  }

  // ---- Google Docs -------------------------------------------------------------------

  // Append text, insert it at the top, and find-and-replace, in one atomic batch.
  async function docEdit({ id, append = null, prepend = null, replace = [], account = null } = {}) {
    const { a, id: raw } = resolve(id, account)
    const requests = []
    for (const r of Array.isArray(replace) ? replace : [replace]) {
      if (!r) continue
      if (!r.find) throw new DriveError('every replace entry needs find')
      requests.push({ replaceAllText: { containsText: { text: String(r.find), matchCase: r.matchCase !== false }, replaceText: String(r.with ?? '') } })
    }
    if (prepend) requests.push({ insertText: { text: String(prepend), location: { index: 1 } } })
    if (append) requests.push({ insertText: { text: String(append), endOfSegmentLocation: {} } })
    if (!requests.length) throw new DriveError('give append, prepend and/or replace')
    const out = await api(a, `${DOCS}/${encodeURIComponent(raw)}:batchUpdate`, { method: 'POST', body: { requests } })
    const replaced = (out.replies || []).map((r) => r.replaceAllText?.occurrencesChanged).filter((n) => n != null)
    return { ok: true, id: ref(a, raw), replacements: replaced, url: `https://docs.google.com/document/d/${raw}/edit` }
  }

  return {
    configured, accountLabels, requireAccount, listAccounts, startAuth, completeAuth, removeAccount, renameAccount,
    search, readFile, createFile, copyFile, updateFile, trash,
    sheetInfo, sheetRead, sheetWrite, sheetAppend, sheetClear, sheetBatchUpdate, docEdit,
  }
}

// A tab name as A1 notation wants it: quoted when it has anything but letters,
// digits and underscores ("Action Items" → "'Action Items'").
export function tabRef(title) {
  const t = String(title)
  return /^[A-Za-z0-9_]+$/.test(t) ? t : `'${t.replace(/'/g, "''")}'`
}
