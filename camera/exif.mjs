// Pull DateTimeOriginal out of a JPEG, with no exiftool on the box.
//
// The sync runs from udev as root, where PATH is close to empty and nvm's node
// isn't on it (see docs/camera-sync.md). Every external binary that path depends
// on is one more thing that can be missing at 11pm when a camera gets plugged in,
// so the one piece of metadata we actually need — the shot date, for foldering —
// is parsed here instead.
//
// Deliberately partial. This reads two tags and understands one container. It is
// not an EXIF library and shouldn't grow into one: anything it can't parse falls
// back to the file's mtime, which for a camera card is nearly always the shot
// time anyway.

const SOI = 0xffd8
const APP1 = 0xffe1
const SOS = 0xffda // start of scan — image data begins, no more metadata

const TAG_DATETIME = 0x0132 // IFD0, "file changed" — the fallback
const TAG_EXIF_IFD = 0x8769 // IFD0, pointer to the Exif sub-IFD
const TAG_DATETIME_ORIGINAL = 0x9003 // Exif sub-IFD, shutter time — what we want

// How much of the file to read looking for the Exif block. The APP1 segment is
// the first thing after SOI in every camera JPEG, and its length field is 16-bit,
// so it cannot exceed 64KB. 128KB is that plus room for a JFIF/ICC segment ahead
// of it.
export const EXIF_HEAD_BYTES = 128 * 1024

// "2011:04:03 18:22:07" — EXIF's own format, which is not ISO 8601 and not
// parseable by Date. Colons in the date part, no timezone at all.
const EXIF_DATE_RE = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/

/**
 * Parse an EXIF datetime string into calendar parts.
 *
 * There is no timezone in the tag — an XZ-1 records the camera's local wall
 * clock and nothing else. So this returns the parts as written rather than a
 * Date, because turning them into an instant would mean inventing an offset,
 * and the only thing we do with them is name a folder. A photo taken at 00:30
 * belongs in that day's folder regardless of where the box syncing it is.
 *
 * @returns {{year:string, month:string, day:string, hour:string, minute:string, second:string}|null}
 */
export function parseExifDate(value) {
  const m = EXIF_DATE_RE.exec(String(value || '').trim())
  if (!m) return null
  const [, year, month, day, hour, minute, second] = m
  // Cameras with a dead clock battery write all-zero dates. That's not a date,
  // it's a "I don't know", and it must not become a 0000-00-00 folder.
  if (year === '0000' || month === '00' || day === '00') return null
  if (Number(month) > 12 || Number(day) > 31 || Number(hour) > 23) return null
  if (Number(minute) > 59 || Number(second) > 60) return null
  return { year, month, day, hour, minute, second }
}

/** `2011-04-03` from parsed parts. The folder name. */
export function dateFolder(parts) {
  return `${parts.year}-${parts.month}-${parts.day}`
}

// Walk the JPEG marker chain to find the APP1 segment holding "Exif\0\0".
// Markers are FF <type> <2-byte length, big-endian, including itself>, except
// the standalone ones (D0-D9) which carry no payload.
function findExifSegment(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== SOI) return null
  let at = 2
  while (at + 4 <= buf.length) {
    if (buf[at] !== 0xff) return null // desynced from the marker chain
    const marker = buf.readUInt16BE(at)
    if (marker === SOS) return null // image data — metadata is behind us
    const length = buf.readUInt16BE(at + 2)
    if (length < 2) return null
    const body = at + 4
    const end = at + 2 + length
    if (marker === APP1 && body + 6 <= buf.length) {
      if (buf.toString('latin1', body, body + 6) === 'Exif\0\0') {
        // The TIFF block starts after the "Exif\0\0" tag. Truncate to what we
        // actually read: a segment can claim more than the head buffer holds.
        return buf.subarray(body + 6, Math.min(end, buf.length))
      }
    }
    at = end
  }
  return null
}

// Read one IFD's entries. Offsets throughout EXIF are relative to the start of
// the TIFF block, not the file and not the IFD, which is the classic way to get
// this wrong.
function readIfd(tiff, offset, little, want) {
  const found = {}
  if (offset < 0 || offset + 2 > tiff.length) return found
  const count = little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset)
  for (let i = 0; i < count; i++) {
    const entry = offset + 2 + i * 12
    if (entry + 12 > tiff.length) break
    const tag = little ? tiff.readUInt16LE(entry) : tiff.readUInt16BE(entry)
    if (!want.has(tag)) continue
    const type = little ? tiff.readUInt16LE(entry + 2) : tiff.readUInt16BE(entry + 2)
    const size = little ? tiff.readUInt32LE(entry + 4) : tiff.readUInt32BE(entry + 4)
    const valueAt = entry + 8

    if (type === 4) {
      // LONG — a pointer to another IFD.
      found[tag] = little ? tiff.readUInt32LE(valueAt) : tiff.readUInt32BE(valueAt)
    } else if (type === 2) {
      // ASCII. Values of 4 bytes or fewer are inlined in the entry itself;
      // anything longer (a 20-byte date always is) stores an offset instead.
      const start = size <= 4 ? valueAt : (little ? tiff.readUInt32LE(valueAt) : tiff.readUInt32BE(valueAt))
      if (start < 0 || start + size > tiff.length) continue
      const raw = tiff.toString('latin1', start, start + size)
      found[tag] = raw.replace(/\0.*$/s, '') // NUL-terminated, padded
    }
  }
  return found
}

/**
 * Extract the shot date from the head of a JPEG.
 *
 * @param {Buffer} head first EXIF_HEAD_BYTES of the file (fewer is fine)
 * @returns {{year,month,day,hour,minute,second}|null} null if absent or unparseable
 */
export function exifDateFromBuffer(head) {
  if (!Buffer.isBuffer(head)) return null
  const tiff = findExifSegment(head)
  if (!tiff || tiff.length < 8) return null

  const order = tiff.toString('latin1', 0, 2)
  if (order !== 'II' && order !== 'MM') return null
  const little = order === 'II'
  if ((little ? tiff.readUInt16LE(2) : tiff.readUInt16BE(2)) !== 42) return null

  const ifd0At = little ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4)
  const ifd0 = readIfd(tiff, ifd0At, little, new Set([TAG_DATETIME, TAG_EXIF_IFD]))

  // DateTimeOriginal is the shutter press. DateTime in IFD0 is "when the file
  // was last written", which in-camera is the same instant but after an edit is
  // not — so it's only ever the fallback.
  if (ifd0[TAG_EXIF_IFD] !== undefined) {
    const sub = readIfd(tiff, ifd0[TAG_EXIF_IFD], little, new Set([TAG_DATETIME_ORIGINAL]))
    const original = parseExifDate(sub[TAG_DATETIME_ORIGINAL])
    if (original) return original
  }
  return parseExifDate(ifd0[TAG_DATETIME])
}

/** Calendar parts from a millisecond timestamp, in the box's local zone. */
export function partsFromMtime(ms) {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  const pad = (n) => String(n).padStart(2, '0')
  return {
    year: String(d.getFullYear()),
    month: pad(d.getMonth() + 1),
    day: pad(d.getDate()),
    hour: pad(d.getHours()),
    minute: pad(d.getMinutes()),
    second: pad(d.getSeconds()),
  }
}
