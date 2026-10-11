// Message text out of chat.db's `attributedBody`.
//
// Since macOS Ventura most rows leave `message.text` NULL and keep the text only
// inside `attributedBody`: an NSAttributedString archived with NSArchiver's
// "typedstream" format. Decoding the whole format is not needed for the text.
// The first object archived is the NSString, written as the class name, then a
// '+' (0x2B, "C string follows"), then a length, then the UTF-8 bytes:
//
//   …"NSString" 01 94 84 01 2B <len> <bytes…>
//
// The length is one byte below 0x80; 0x81 means a little-endian uint16 follows,
// 0x82 a uint32. That is the whole trick, and it is how every chat.db reader
// that works on current macOS does it.

const NSSTRING = Buffer.from('NSString')

export function decodeAttributedBody(blob) {
  if (!blob || !blob.length) return null
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  const at = buf.indexOf(NSSTRING)
  if (at < 0) return null
  // The '+' sits a few bytes after the class name (version and class-chain
  // markers in between). Look a short way only, so a '+' inside the text of a
  // malformed blob is never mistaken for the marker.
  let i = at + NSSTRING.length
  const stop = Math.min(buf.length, i + 12)
  while (i < stop && buf[i] !== 0x2b) i += 1
  if (i >= stop) return null
  i += 1
  if (i >= buf.length) return null
  let len = buf[i]
  i += 1
  if (len === 0x81) {
    if (i + 2 > buf.length) return null
    len = buf.readUInt16LE(i)
    i += 2
  } else if (len === 0x82) {
    if (i + 4 > buf.length) return null
    len = buf.readUInt32LE(i)
    i += 4
  } else if (len >= 0x80) {
    return null
  }
  if (i + len > buf.length) return null
  return buf.subarray(i, i + len).toString('utf8')
}

// Build a minimal blob in the same shape, for tests and fixtures.
export function encodeAttributedBody(text) {
  const body = Buffer.from(String(text), 'utf8')
  let len
  if (body.length < 0x80) len = Buffer.from([body.length])
  else if (body.length <= 0xffff) { len = Buffer.alloc(3); len[0] = 0x81; len.writeUInt16LE(body.length, 1) }
  else { len = Buffer.alloc(5); len[0] = 0x82; len.writeUInt32LE(body.length, 1) }
  return Buffer.concat([
    Buffer.from('040b73747265616d747970656481e803840140848484124e5341747472696275746564537472696e67008484084e534f626a656374008592848484', 'hex'),
    Buffer.from([0x08]), NSSTRING, Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
    len, body,
    Buffer.from('8684026949', 'hex'),
  ])
}
