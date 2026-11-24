// A model shows the owner a screenshot the way it would in T3 Code: it saves one
// (preview_snapshot save:true) and writes ![what it shows](/abs/path.png) in its
// reply. The browser in the chat can't load a path on the box, so when the turn
// ends each such image becomes a chat upload and its path is replaced with the
// upload's signed URL. A file under `allowedDirs` is copied from disk. A picture
// a tool already returned this turn (`seen`: an image the agent read, by path)
// reuses that tool's upload, so the reply shows exactly the bytes the agent saw
// and the disk is not read again. Nothing else is taken — a reply can't smuggle
// an arbitrary file off the disk by naming it.

import { readFile, stat } from 'node:fs/promises'
import { basename, extname, resolve, sep } from 'node:path'

const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
// ![alt](path) or ![alt](<path with spaces>), optionally file://-prefixed.
const MD_IMAGE = /!\[([^\]\n]*)\]\(\s*(?:<((?:file:\/\/)?\/[^>\n]{1,4096})>|((?:file:\/\/)?\/[^)\s>]+))\s*\)/g

const inside = (file, dir) => {
  const d = resolve(dir)
  return file === d || file.startsWith(d.endsWith(sep) ? d : d + sep)
}

/**
 * Rewrite local screenshot images in `text`. `save({buffer, name, mime})`
 * stores one and returns {id, url}; `seen` maps a path to an upload already
 * made from it ({url}). Returns {text, uploads} (`uploads`: the ones saved here).
 */
export async function embedLocalImages(text, { allowedDirs = [], seen = new Map(), save, maxBytes = 15 * 1024 * 1024 }) {
  if (!text || !text.includes('![')) return { text, uploads: [] }
  const known = new Map([...seen].map(([f, up]) => [resolve(f), up]))
  const done = new Map()
  const uploads = []
  for (const m of text.matchAll(MD_IMAGE)) {
    const raw = (m[2] ?? m[3]).replace(/^file:\/\//, '')
    if (done.has(raw)) continue
    // The path as written first (a file may really be called "100% cotton.jpg"),
    // then URL-decoded (%20 for a space).
    const tries = [raw]
    try { const d = decodeURIComponent(raw); if (d !== raw) tries.push(d) } catch {}
    for (const t of tries) {
      const file = resolve(t)
      const mime = IMAGE_MIME[extname(file).toLowerCase()]
      if (!mime) continue
      // A file in the chat's own folders is read now, so an edit made after the
      // agent looked at it shows; anything else only as the agent saw it.
      if (!allowedDirs.some((d) => inside(file, d))) {
        if (known.has(file)) { done.set(raw, known.get(file).url); break }
        continue
      }
      const info = await stat(file).catch(() => null)
      if (!info?.isFile() || info.size > maxBytes) continue
      try {
        const up = await save({ buffer: await readFile(file), name: basename(file), mime })
        done.set(raw, up.url)
        uploads.push(up)
      } catch {}
      break
    }
  }
  if (!done.size) return { text, uploads }
  const out = text.replace(MD_IMAGE, (whole, alt, angled, bare) => {
    const url = done.get((angled ?? bare).replace(/^file:\/\//, ''))
    return url ? `![${alt}](${url})` : whole
  })
  return { text: out, uploads }
}
