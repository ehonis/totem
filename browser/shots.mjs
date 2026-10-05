// A model shows the owner a screenshot the way it would in T3 Code: it saves one
// (preview_snapshot save:true) and writes ![what it shows](/abs/path.png) in its
// reply. The browser in the chat can't load a path on the box, so when the turn
// ends each such image is copied into the chat's uploads and its path replaced
// with the upload's signed URL. Only files under `allowedDirs` are taken — a
// reply can't smuggle an arbitrary file off the disk by naming it.

import { readFile, stat } from 'node:fs/promises'
import { basename, extname, resolve, sep } from 'node:path'

const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
// ![alt](path) or ![alt](<path with spaces>), optionally file://-prefixed.
const MD_IMAGE = /!\[([^\]\n]*)\]\(\s*<?((?:file:\/\/)?\/[^)\s>]+)>?\s*\)/g

const inside = (file, dir) => {
  const d = resolve(dir)
  return file === d || file.startsWith(d.endsWith(sep) ? d : d + sep)
}

/**
 * Rewrite local screenshot images in `text`. `save({buffer, name, mime})`
 * stores one and returns {id, url}. Returns {text, uploads}.
 */
export async function embedLocalImages(text, { allowedDirs = [], save, maxBytes = 15 * 1024 * 1024 }) {
  if (!text || !text.includes('![')) return { text, uploads: [] }
  const done = new Map()
  const uploads = []
  for (const m of text.matchAll(MD_IMAGE)) {
    const raw = m[2].replace(/^file:\/\//, '')
    if (done.has(raw)) continue
    let file
    try { file = resolve(decodeURIComponent(raw)) } catch { continue }
    const mime = IMAGE_MIME[extname(file).toLowerCase()]
    if (!mime || !allowedDirs.some((d) => inside(file, d))) continue
    try {
      const info = await stat(file)
      if (!info.isFile() || info.size > maxBytes) continue
      const up = await save({ buffer: await readFile(file), name: basename(file), mime })
      done.set(raw, up.url)
      uploads.push(up)
    } catch {}
  }
  if (!done.size) return { text, uploads }
  const out = text.replace(MD_IMAGE, (whole, alt, p) => {
    const url = done.get(p.replace(/^file:\/\//, ''))
    return url ? `![${alt}](${url})` : whole
  })
  return { text: out, uploads }
}
