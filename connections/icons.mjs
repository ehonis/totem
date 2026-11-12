// connections/icons.mjs — the icon the owner picked for a connection.
//
// Settings → Connections draws each connection with its brand logo, or a letter
// when Totem ships none. The owner can replace that, as with a chat folder: one of
// the chat icons (chat/thread-icons.mjs), an uploaded picture, or a website's own
// icon (chat/favicon.mjs saves it as an upload). Keyed by connection id (a manifest
// server's id, or a built-in row's: gmail, google-drive, whoop, strava).
//
// Layout: one JSON file, { "<id>": { "icon": "database" } | { "image": "<upload id>" } }.
// Only the owner writes it, from the dashboard; it carries nothing secret.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { THREAD_ICONS } from '../chat/thread-icons.mjs'

export const validConnectionId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)
const validUploadId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id)
const ICONS = new Set(THREAD_ICONS)

/** A stored or requested choice → { icon } | { image } | null; anything else is dropped. */
export function cleanChoice(raw) {
  if (validUploadId(raw?.image)) return { image: raw.image }
  if (typeof raw?.icon === 'string' && ICONS.has(raw.icon)) return { icon: raw.icon }
  return null
}

export function createConnectionIconStore({ file } = {}) {
  if (!file) throw new TypeError('createConnectionIconStore requires file')
  let queue = Promise.resolve()

  async function all() {
    let raw = {}
    try { raw = JSON.parse(await readFile(file, 'utf8')) } catch {}
    const out = {}
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [id, choice] of Object.entries(raw)) {
        const clean = validConnectionId(id) ? cleanChoice(choice) : null
        if (clean) out[id] = clean
      }
    }
    return out
  }

  async function write(map) {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(map, null, 2) + '\n')
    await rename(tmp, file)
  }

  /**
   * Set a connection's icon (`{icon}` or `{image}`), or clear it with null.
   * Returns what it replaced, so the caller can drop an image nobody wears now.
   */
  function set(id, choice) {
    if (!validConnectionId(id)) return Promise.reject(Object.assign(new Error('not a connection id'), { status: 400 }))
    const clean = choice == null ? null : cleanChoice(choice)
    if (choice != null && !clean) return Promise.reject(Object.assign(new Error('pick one of the listed icons, or a picture'), { status: 400 }))
    const run = queue.then(async () => {
      const map = await all()
      const before = map[id] || null
      if (clean) map[id] = clean
      else delete map[id]
      await write(map)
      return before
    })
    queue = run.catch(() => {})
    return run
  }

  /** Every upload a connection wears, so the upload sweep keeps them. */
  async function imageIds() {
    return new Set(Object.values(await all()).map((c) => c.image).filter(Boolean))
  }

  return { all, set, imageIds }
}
