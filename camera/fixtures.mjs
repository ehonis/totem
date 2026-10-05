// Synthetic camera files for the tests. Not shipped code — but not test code
// either, since both exif.test.mjs and sync.test.mjs need it.

/**
 * Build a JPEG head with an Exif APP1 segment carrying the given tags.
 *
 * Entries are `[tag, type, value]`, type 2 = ASCII and type 4 = LONG. A value of
 * `null` on the Exif-IFD pointer (0x8769) means "fill in wherever the sub-IFD
 * actually landed", so no test has to restate the layout arithmetic.
 */
export function jpegWithExif({ little = true, ifd0 = [], exif = [], order = null, magic = 42, pad = 0 } = {}) {
  const u16 = (n) => { const b = Buffer.alloc(2); little ? b.writeUInt16LE(n) : b.writeUInt16BE(n); return b }
  const u32 = (n) => { const b = Buffer.alloc(4); little ? b.writeUInt32LE(n) : b.writeUInt32BE(n); return b }

  // Layout inside the TIFF block: header(8) | IFD0 | ExifIFD | heap.
  const ifd0Size = 2 + ifd0.length * 12 + 4
  const exifSize = exif.length ? 2 + exif.length * 12 + 4 : 0
  const ifd0At = 8
  const exifAt = ifd0At + ifd0Size
  let heapAt = exifAt + exifSize
  const heap = []

  // ASCII values of 4 bytes or fewer are inlined in the entry; longer ones (a
  // 20-byte date always is) store a heap offset instead.
  const entry = (tag, type, value) => {
    const head = Buffer.concat([u16(tag), u16(type)])
    if (type === 4) return Buffer.concat([head, u32(1), u32(value)])
    const bytes = Buffer.from(`${value}\0`, 'latin1')
    if (bytes.length <= 4) {
      const inline = Buffer.alloc(4)
      bytes.copy(inline)
      return Buffer.concat([head, u32(bytes.length), inline])
    }
    const at = heapAt
    heap.push(bytes)
    heapAt += bytes.length
    return Buffer.concat([head, u32(bytes.length), u32(at)])
  }

  const buildIfd = (entries, next) => Buffer.concat([
    u16(entries.length), ...entries.map(([t, ty, v]) => entry(t, ty, v)), u32(next),
  ])

  // ExifIFD is built first so its heap offsets are allocated before IFD0's.
  const exifBlock = exif.length ? buildIfd(exif, 0) : Buffer.alloc(0)
  const ifd0Block = buildIfd(ifd0.map(([t, ty, v]) => [t, ty, t === 0x8769 && v === null ? exifAt : v]), 0)

  const tiff = Buffer.concat([
    Buffer.from(order ?? (little ? 'II' : 'MM'), 'latin1'), u16(magic), u32(ifd0At),
    ifd0Block, exifBlock, ...heap,
  ])
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]), // segment length is big-endian always
    payload,
  ])
  // `pad` appends filler so two otherwise-identical fixtures hash differently —
  // the sync tests need distinct content, not distinct metadata.
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), app1,
    Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.alloc(pad, 0x5a),
  ])
}

export const TAG_DATETIME = 0x0132
export const TAG_EXIF_IFD = 0x8769
export const TAG_DATETIME_ORIGINAL = 0x9003

/** A camera JPEG shot at the given EXIF datetime, with unique content. */
export function photo(taken, { pad = 64, little = true } = {}) {
  return jpegWithExif({
    little,
    ifd0: [[TAG_EXIF_IFD, 4, null]],
    exif: [[TAG_DATETIME_ORIGINAL, 2, taken]],
    pad,
  })
}
