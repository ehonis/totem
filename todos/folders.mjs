// todos/folders.mjs — task folders, which are the owner's chat projects and folders.
//
// A task's `folderId` is a chat project id (chat/projects.mjs): a top-level project
// or one of the folders inside it (`parentId`). No folder means unfiled, which every
// client labels "Personal". This file turns the names an agent or the quick-add line
// uses into ids and back; it never reads the project store itself, so the bridge and
// the gateway hand it the list they have.

/** The words an unfiled task answers to. */
export const UNFILED_NAMES = Object.freeze(['personal', 'none', 'unfiled', 'no folder'])

/** Lower case, letters and digits only: "Work - Northwind" and "worknorthwind" match. */
export const normName = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '')

/** { id, name, parentId } for each project, keeping only well-formed entries. */
export function folderList(projects) {
  return (Array.isArray(projects) ? projects : [])
    .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
    .map((p) => ({ id: p.id, name: p.name, parentId: typeof p.parentId === 'string' ? p.parentId : null }))
}

/** "Project / Folder" for a folder, the name for a project, null when it does not exist. */
export function folderPath(projects, id) {
  if (!id) return null
  const list = folderList(projects)
  const own = list.find((p) => p.id === id)
  if (!own) return null
  const parent = own.parentId ? list.find((p) => p.id === own.parentId) : null
  return parent ? `${parent.name} / ${own.name}` : own.name
}

/**
 * The folder a name names. `text` may be an id, "Project / Folder", a project or
 * folder name, or a word unfiled answers to (→ { id: null }). Returns
 * { id } on a match, { ambiguous: [paths] } when several fit, or null.
 */
export function resolveFolder(projects, text) {
  if (text == null) return { id: null }
  const raw = String(text).trim()
  if (!raw || UNFILED_NAMES.includes(raw.toLowerCase())) return { id: null }
  const list = folderList(projects)
  const byId = list.find((p) => p.id === raw)
  if (byId) return { id: byId.id }
  const want = normName(raw)
  if (!want) return null
  const pathOf = (p) => folderPath(list, p.id)
  const pick = (hits) => (hits.length === 1 ? { id: hits[0].id } : hits.length > 1 ? { ambiguous: hits.map(pathOf) } : null)
  // The full path first ("Work - Northwind / r+d"), then the name alone; a
  // project wins over a folder of the same name.
  return pick(list.filter((p) => normName(pathOf(p)) === want))
    ?? pick(list.filter((p) => !p.parentId && normName(p.name) === want))
    ?? pick(list.filter((p) => normName(p.name) === want))
    // A whole word of a project's name: "northwind" for "Work - Northwind".
    ?? pick(list.filter((p) => !p.parentId && p.name.toLowerCase().split(/[^\p{L}\p{N}+]+/u).some((w) => normName(w) === want)))
}

/** A sheet row the owner took out of the sheet's default folder on purpose (chat/task-folders.mjs value). */
export const SHEET_UNFILED = 'none'

// A sheet row's id is "sheet:<gid>:<row>:<hash of its title>" (chat/task-link.mjs).
const SHEET_REF = /^sheet:([^:]+):\d+:([^:]+)$/

function sheetRowFor(items, ref) {
  const exact = items.find((i) => i.id === ref)
  if (exact) return exact
  const m = SHEET_REF.exec(String(ref || ''))
  if (!m) return null
  const same = items.filter((i) => { const n = SHEET_REF.exec(i.id); return n && n[1] === m[1] && n[2] === m[2] })
  return same.length === 1 ? same[0] : null
}

/**
 * The folder a sheet's rows land in until the owner files one. `setting` is
 * TASK_SHEET_FOLDER: "none" leaves them unfiled, a project id names one, and empty
 * ("automatic") picks the top-level project whose name the sheet's name starts with
 * ("Gizmo Labs" for "Gizmo Labs HQ"), the longest if several do.
 */
export function sheetDefaultFolder(projects, title, setting = '') {
  const list = folderList(projects)
  const chosen = String(setting || '').trim()
  if (chosen.toLowerCase() === SHEET_UNFILED) return null
  if (chosen) return list.some((p) => p.id === chosen) ? chosen : null
  const name = normName(title)
  if (!name) return null
  const fits = list.filter((p) => !p.parentId && normName(p.name).length >= 3 && name.startsWith(normName(p.name)))
  return fits.sort((a, b) => normName(b.name).length - normName(a.name).length)[0]?.id || null
}

/**
 * Each sheet row with `folderId`: its own filing (found again when the row moved,
 * the exact id winning), else the sheet's default with `folderDefault: true`.
 * `filings` is chat/task-folders.mjs's map; filings of deleted projects are ignored.
 */
export function fileSheetItems(feed, filings, projects, setting = '') {
  const items = Array.isArray(feed?.items) ? feed.items : []
  const ids = new Set(folderList(projects).map((p) => p.id))
  const filed = new Map()
  for (const [ref, project] of Object.entries(filings || {})) {
    if (!ref.startsWith('sheet:') || !(ids.has(project) || project === SHEET_UNFILED)) continue
    const item = sheetRowFor(items, ref)
    if (item && (!filed.has(item.id) || ref === item.id)) filed.set(item.id, project === SHEET_UNFILED ? null : project)
  }
  const fallback = sheetDefaultFolder(projects, feed?.title, setting)
  return {
    ...feed,
    defaultFolderId: fallback,
    items: items.map((item) => (filed.has(item.id)
      ? { ...item, folderId: filed.get(item.id) }
      : { ...item, folderId: fallback, ...(fallback ? { folderDefault: true } : {}) })),
  }
}

/**
 * The one-time move from areas to folders: each local task the chats panel had
 * filed takes that folder, and a Ventures task the top-level project named like
 * its venture tag. Returns { entries: [{ id, folderId }] }. Personal tasks stay
 * unfiled, which is what Personal means now.
 */
export function folderAdoption(filings, todos, projects) {
  const list = folderList(projects)
  const ids = new Set(list.map((p) => p.id))
  const entries = []
  for (const [ref, project] of Object.entries(filings || {})) {
    if (ref.startsWith('sheet:')) continue
    if (ids.has(project)) entries.push({ id: ref, folderId: project })
  }
  const named = new Set(entries.map((e) => e.id))
  const roots = list.filter((p) => !p.parentId)
  for (const t of todos || []) {
    if (named.has(t.id) || t.folderId || t.area !== 'Ventures' || !t.ventureTag) continue
    const found = resolveFolder(roots, t.ventureTag)
    if (found?.id) entries.push({ id: t.id, folderId: found.id })
  }
  return { entries }
}
