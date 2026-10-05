// Run with: node --test camera/
//
// The parser reads raw byte offsets out of a format with two possible byte
// orders and pointers relative to a block that isn't the start of the file.
// Every one of those is silently wrong rather than loudly wrong — a bad offset
// yields a plausible-looking string, not a crash — so the fixtures here are
// built byte by byte in both orders.
import test from 'node:test'
import assert from 'node:assert/strict'
import { exifDateFromBuffer, parseExifDate, dateFolder, partsFromMtime } from './exif.mjs'
import { jpegWithExif } from './fixtures.mjs'

const DTO = 0x9003
const DT = 0x0132
const EXIF_PTR = 0x8769

test('reads DateTimeOriginal from a little-endian JPEG', () => {
  const buf = jpegWithExif({
    little: true,
    ifd0: [[EXIF_PTR, 4, null]],
    exif: [[DTO, 2, '2011:04:03 18:22:07']],
  })
  assert.deepEqual(exifDateFromBuffer(buf), {
    year: '2011', month: '04', day: '03', hour: '18', minute: '22', second: '07',
  })
})

test('reads DateTimeOriginal from a big-endian JPEG', () => {
  // Olympus writes little-endian, but a card can hold photos from any camera
  // and the two orders are separate code paths.
  const buf = jpegWithExif({
    little: false,
    ifd0: [[EXIF_PTR, 4, null]],
    exif: [[DTO, 2, '2019:12:25 06:05:04']],
  })
  assert.equal(dateFolder(exifDateFromBuffer(buf)), '2019-12-25')
})

test('falls back to IFD0 DateTime when there is no Exif sub-IFD', () => {
  const buf = jpegWithExif({ little: true, ifd0: [[DT, 2, '2008:01:02 03:04:05']] })
  assert.equal(dateFolder(exifDateFromBuffer(buf)), '2008-01-02')
})

test('DateTimeOriginal wins over IFD0 DateTime', () => {
  // A photo edited after the fact has a later DateTime; the shutter press is
  // what should decide the folder.
  const buf = jpegWithExif({
    little: true,
    ifd0: [[DT, 2, '2020:06:06 00:00:00'], [EXIF_PTR, 4, null]],
    exif: [[DTO, 2, '2011:04:03 18:22:07']],
  })
  assert.equal(dateFolder(exifDateFromBuffer(buf)), '2011-04-03')
})

test('returns null rather than a garbage date for junk input', () => {
  assert.equal(exifDateFromBuffer(Buffer.alloc(0)), null)
  assert.equal(exifDateFromBuffer(Buffer.from('not a jpeg at all')), null)
  assert.equal(exifDateFromBuffer(null), null)
  // SOI but no APP1 — a JPEG with the metadata stripped.
  assert.equal(exifDateFromBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02])), null)
  // Right structure, wrong TIFF magic.
  assert.equal(exifDateFromBuffer(jpegWithExif({ ifd0: [[DT, 2, '2008:01:02 03:04:05']], magic: 43 })), null)
  // Unknown byte order.
  assert.equal(exifDateFromBuffer(jpegWithExif({ ifd0: [[DT, 2, '2008:01:02 03:04:05']], order: 'XX' })), null)
})

test('a dead clock battery is treated as no date, not as year zero', () => {
  // This is the one that matters: an XZ-1 whose coin cell has died writes
  // all-zero dates, and a 0000-00-00 folder is worse than falling back to mtime.
  assert.equal(parseExifDate('0000:00:00 00:00:00'), null)
  const buf = jpegWithExif({ little: true, ifd0: [[DT, 2, '0000:00:00 00:00:00']] })
  assert.equal(exifDateFromBuffer(buf), null)
})

test('parseExifDate rejects out-of-range components', () => {
  assert.equal(parseExifDate('2011:13:03 18:22:07'), null)
  assert.equal(parseExifDate('2011:04:32 18:22:07'), null)
  assert.equal(parseExifDate('2011:04:03 24:22:07'), null)
  assert.equal(parseExifDate('2011:04:03 18:60:07'), null)
  assert.equal(parseExifDate(''), null)
  assert.equal(parseExifDate(undefined), null)
  // A leap second is legal in the field and shouldn't be thrown away.
  assert.ok(parseExifDate('2016:12:31 23:59:60'))
})

test('parseExifDate tolerates the ISO-ish separator some editors write', () => {
  assert.equal(dateFolder(parseExifDate('2011:04:03T18:22:07')), '2011-04-03')
})

test('partsFromMtime pads single digits so folders sort', () => {
  const parts = partsFromMtime(new Date(2011, 3, 3, 6, 5, 4).getTime())
  assert.equal(dateFolder(parts), '2011-04-03')
  assert.equal(parts.hour, '06')
  assert.equal(partsFromMtime(NaN), null)
})
