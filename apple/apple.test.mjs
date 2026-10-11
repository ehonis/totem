import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { decodeAttributedBody, encodeAttributedBody } from './typedstream.mjs'
import { createContacts, handleKey, phoneKey } from './contacts.mjs'
import { createMessages } from './messages.mjs'
import { createPhotos, unpackLexemes } from './photos.mjs'
import { createSender, validHandle, explainOsascriptError } from './send.mjs'
import { createApple } from './index.mjs'

const EPOCH = 978307200
// chat.db stores nanoseconds since 2001 — bigger than a JS number holds exactly.
const appleNs = (iso) => BigInt(Date.parse(iso) / 1000 - EPOCH) * 1_000_000_000n
const appleS = (iso) => Date.parse(iso) / 1000 - EPOCH

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'totem-apple-'))

  // ---- Contacts ----
  const ab = join(home, 'Library', 'Application Support', 'AddressBook')
  mkdirSync(join(ab, 'Sources', 'S1'), { recursive: true })
  for (const file of [join(ab, 'AddressBook-v22.abcddb'), join(ab, 'Sources', 'S1', 'AddressBook-v22.abcddb')]) {
    const db = new DatabaseSync(file)
    db.exec(`
      CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT, ZNICKNAME TEXT);
      CREATE TABLE ZABCDPHONENUMBER (ZOWNER INTEGER, ZFULLNUMBER TEXT, ZLABEL TEXT);
      CREATE TABLE ZABCDEMAILADDRESS (ZOWNER INTEGER, ZADDRESS TEXT, ZLABEL TEXT);
      INSERT INTO ZABCDRECORD VALUES (1, 'Sam', 'Carter', NULL, NULL), (2, 'Jamie', 'Rivera', NULL, 'Mom'), (3, NULL, NULL, 'Acme Dental', NULL);
      INSERT INTO ZABCDPHONENUMBER VALUES (2, '+1 (555) 010-2233', '_$!<Mobile>!$_'), (3, '555-010-9999', NULL);
      INSERT INTO ZABCDEMAILADDRESS VALUES (1, 'alex@example.com', '_$!<Home>!$_');
    `)
    db.close()
  }

  // ---- Messages ----
  mkdirSync(join(home, 'Library', 'Messages'), { recursive: true })
  const chat = new DatabaseSync(join(home, 'Library', 'Messages', 'chat.db'))
  chat.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT, service_name TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER, is_from_me INTEGER,
      date INTEGER, date_read INTEGER DEFAULT 0, is_read INTEGER DEFAULT 1, service TEXT, cache_has_attachments INTEGER DEFAULT 0,
      associated_message_type INTEGER DEFAULT 0, associated_message_guid TEXT, error INTEGER DEFAULT 0);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT, transfer_name TEXT, total_bytes INTEGER, is_sticker INTEGER DEFAULT 0);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    INSERT INTO handle VALUES (1, '+15550102233', 'iMessage'), (2, 'alex@example.com', 'iMessage'), (3, '+15550104444', 'iMessage');
    INSERT INTO chat VALUES (1, 'any;-;+15550102233', '+15550102233', '', 'iMessage'),
      (2, 'any;+;chat123', 'chat123', 'Ride Crew', 'iMessage');
    INSERT INTO chat_handle_join VALUES (1, 1), (2, 2), (2, 3);
    INSERT INTO attachment VALUES (1, '~/Library/Messages/Attachments/aa/01/X/IMG_1.jpeg', 'image/jpeg', 'IMG_1.jpeg', 1234, 0),
      (2, '/etc/passwd', 'text/plain', 'passwd', 10, 0),
      (3, '~/Library/Messages/Attachments/aa/02/Y/0A1B.pluginPayloadAttachment', NULL, '0A1B.pluginPayloadAttachment', 900, 0);
  `)
  const msg = chat.prepare('INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, is_from_me, date, is_read, service, cache_has_attachments, associated_message_type, associated_message_guid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  const join_ = chat.prepare('INSERT INTO chat_message_join VALUES (?,?,?)')
  const rows = [
    [1, 'G1', 'Dinner at 7?', null, 1, 0, '2026-10-01T18:00:00Z', 1, 'iMessage', 0, 0, null, 1],
    [2, 'G2', null, encodeAttributedBody('Yes! See you there'), 0, 1, '2026-10-01T18:01:00Z', 1, 'iMessage', 0, 0, null, 1],
    [3, 'G3', null, null, 1, 0, '2026-10-01T18:02:00Z', 1, 'iMessage', 0, 2000, 'p:0/G2', 1],
    [4, 'G4', null, encodeAttributedBody('Ride Saturday at the reservoir ￼'), 2, 0, '2026-10-02T09:00:00Z', 0, 'iMessage', 1, 0, null, 2],
    [5, 'G5', null, encodeAttributedBody('I am in'), 3, 0, '2026-10-02T09:05:00Z', 0, 'iMessage', 0, 0, null, 2],
  ]
  for (const r of rows) {
    msg.run(r[0], r[1], r[2], r[3], r[4], r[5], appleNs(r[6]), r[7], r[8], r[9], r[10], r[11])
    join_.run(r[12], r[0], appleNs(r[6]))
  }
  chat.prepare('INSERT INTO message_attachment_join VALUES (4, 1), (4, 3)').run()
  chat.close()

  // ---- Photos ----
  const lib = join(home, 'Pictures', 'Photos Library.photoslibrary')
  mkdirSync(join(lib, 'database', 'search'), { recursive: true })
  mkdirSync(join(lib, 'resources', 'derivatives', 'A'), { recursive: true })
  const ph = new DatabaseSync(join(lib, 'database', 'Photos.sqlite'))
  ph.exec(`
    CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT);
    INSERT INTO Z_PRIMARYKEY VALUES (3, 'Asset'), (34, 'Album');
    CREATE TABLE ZASSET (Z_PK INTEGER PRIMARY KEY, ZUUID TEXT, ZDATECREATED REAL, ZKIND INTEGER, ZKINDSUBTYPE INTEGER, ZFILENAME TEXT, ZDIRECTORY TEXT,
      ZFAVORITE INTEGER, ZWIDTH INTEGER, ZHEIGHT INTEGER, ZDURATION REAL, ZLATITUDE REAL, ZLONGITUDE REAL, ZMOMENT INTEGER,
      ZADDITIONALATTRIBUTES INTEGER, ZTRASHEDSTATE INTEGER DEFAULT 0, ZHIDDEN INTEGER DEFAULT 0);
    CREATE TABLE ZMOMENT (Z_PK INTEGER PRIMARY KEY, ZTITLE TEXT, ZSUBTITLE TEXT);
    CREATE TABLE ZADDITIONALASSETATTRIBUTES (Z_PK INTEGER PRIMARY KEY, ZORIGINALFILENAME TEXT, ZTITLE TEXT);
    CREATE TABLE ZASSETDESCRIPTION (Z_PK INTEGER PRIMARY KEY, ZASSETATTRIBUTES INTEGER, ZLONGDESCRIPTION TEXT);
    CREATE TABLE ZPERSON (Z_PK INTEGER PRIMARY KEY, ZFULLNAME TEXT, ZDISPLAYNAME TEXT, ZFACECOUNT INTEGER);
    CREATE TABLE ZDETECTEDFACE (Z_PK INTEGER PRIMARY KEY, ZASSETFORFACE INTEGER, ZPERSONFORFACE INTEGER);
    CREATE TABLE ZGENERICALBUM (Z_PK INTEGER PRIMARY KEY, ZTITLE TEXT, ZKIND INTEGER, ZTRASHEDSTATE INTEGER DEFAULT 0);
    CREATE TABLE Z_34ASSETS (Z_34ALBUMS INTEGER, Z_3ASSETS INTEGER, Z_FOK_3ASSETS INTEGER);
    INSERT INTO ZMOMENT VALUES (1, 'Portland', 'Waterfront Park'), (2, 'Salem', NULL);
    INSERT INTO ZADDITIONALASSETATTRIBUTES VALUES (1, 'IMG_0001.HEIC', NULL), (2, 'IMG_0002.HEIC', 'Sunset'), (3, 'IMG_0003.MOV', NULL), (4, 'IMG_0004.PNG', NULL);
    INSERT INTO ZASSETDESCRIPTION VALUES (1, 2, 'Harbor at dusk');
    INSERT INTO ZPERSON VALUES (1, 'Sam Carter', 'Sam', 12), (2, '', 'Biscuit', 30);
    INSERT INTO ZGENERICALBUM VALUES (1, 'Trips', 2, 0);
  `)
  const asset = ph.prepare('INSERT INTO ZASSET (Z_PK, ZUUID, ZDATECREATED, ZKIND, ZKINDSUBTYPE, ZFILENAME, ZDIRECTORY, ZFAVORITE, ZWIDTH, ZHEIGHT, ZDURATION, ZLATITUDE, ZLONGITUDE, ZMOMENT, ZADDITIONALATTRIBUTES, ZTRASHEDSTATE) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const U = (n) => `A${String(n).padStart(7, '0')}-0000-0000-0000-000000000000`
  asset.run(1, U(1), appleS('2026-07-04T15:00:00Z'), 0, 0, `${U(1)}.heic`, 'A', 1, 4032, 3024, 0, 45.52, -122.68, 1, 1, 0)
  asset.run(2, U(2), appleS('2026-07-05T20:30:00Z'), 0, 0, `${U(2)}.heic`, 'A', 0, 4032, 3024, 0, -180, -180, 1, 2, 0)
  asset.run(3, U(3), appleS('2026-08-01T12:00:00Z'), 1, 0, `${U(3)}.mov`, 'A', 0, 1920, 1080, 12.4, 44.94, -123.03, 2, 3, 0)
  asset.run(4, U(4), appleS('2026-08-02T12:00:00Z'), 0, 10, `${U(4)}.png`, 'A', 0, 1179, 2556, 0, -180, -180, 2, 4, 0)
  asset.run(5, U(5), appleS('2026-08-03T12:00:00Z'), 0, 0, `${U(5)}.heic`, 'A', 0, 1, 1, 0, -180, -180, 2, null, 1) // trashed
  ph.exec(`INSERT INTO ZDETECTEDFACE VALUES (1, 1, 1), (2, 1, 2), (3, 3, 2); INSERT INTO Z_34ASSETS VALUES (1, 1, 1), (1, 3, 2);`)
  ph.close()
  writeFileSync(join(lib, 'resources', 'derivatives', 'A', `${U(1)}_1_105_c.jpeg`), Buffer.alloc(2000))
  writeFileSync(join(lib, 'resources', 'derivatives', 'A', `${U(1)}_1_102_o.jpeg`), Buffer.alloc(500))

  const leo = new DatabaseSync(join(lib, 'database', 'search', 'leo.sqlite'))
  leo.exec(`
    CREATE TABLE lexicon (pk INTEGER PRIMARY KEY, lexeme_id INTEGER, type INTEGER, category INTEGER, content TEXT, identifier TEXT, score REAL);
    CREATE TABLE items (pk INTEGER PRIMARY KEY, identifier TEXT, type INTEGER, lexeme_ids BLOB);
    INSERT INTO lexicon (lexeme_id, type, category, content) VALUES
      (10, 1, 4000, 'Dog'), (10, 2, 4000, 'Dogs'), (11, 1, 4000, 'Beach'), (12, 1, 4000, 'Sunset'),
      (13, 1, 2090, 'Portland'), (14, 1, 1030, 'Independence Day'), (15, 1, 4000, 'Dog Sport');
  `)
  const pack = (ids) => { const b = Buffer.alloc(ids.length * 4); ids.forEach((v, i) => b.writeUInt32LE(v, i * 4)); return b }
  const item = leo.prepare('INSERT INTO items (identifier, type, lexeme_ids) VALUES (?, 1, ?)')
  item.run(U(1), pack([10, 11, 13, 14]))
  item.run(U(2), pack([11, 12, 13]))
  item.run(U(3), pack([10]))
  leo.close()

  return { home, lib, U }
}

const fx = fixtureHome()
test.after(() => rmSync(fx.home, { recursive: true, force: true }))

test('attributedBody: decodes short, 0x81 and 0x82 lengths and refuses junk', () => {
  // A real blob from chat.db on macOS 27 (text "STOP").
  const real = Buffer.from('040b73747265616d747970656481e803840140848484124e5341747472696275746564537472696e67008484084e534f626a656374008592848484084e53537472696e67019484012b0453544f5086840269490104', 'hex')
  assert.equal(decodeAttributedBody(real), 'STOP')
  for (const text of ['hi', 'é'.repeat(200), 'x'.repeat(70_000)]) assert.equal(decodeAttributedBody(encodeAttributedBody(text)), text)
  assert.equal(decodeAttributedBody(null), null)
  assert.equal(decodeAttributedBody(Buffer.from('no marker here')), null)
  assert.equal(decodeAttributedBody(Buffer.concat([Buffer.from('NSString'), Buffer.from([0x01, 0x2b, 0x40, 0x41])])), null, 'length past the end')
})

test('contacts: phone and email keys, merged stores, search', () => {
  assert.equal(phoneKey('+1 (555) 010-2233'), '5550102233')
  assert.equal(handleKey('Alex@Example.com'), 'alex@example.com')
  assert.equal(phoneKey('12345'), '12345')
  const c = createContacts({ root: join(fx.home, 'Library', 'Application Support', 'AddressBook') })
  assert.equal(c.count(), 3, 'the same three cards in two stores merge')
  assert.equal(c.nameFor('+15550102233'), 'Jamie Rivera')
  assert.equal(c.nameFor('5550102233'), 'Jamie Rivera')
  assert.equal(c.nameFor('alex@EXAMPLE.com'), 'Sam Carter')
  assert.equal(c.nameFor('+15559999999'), null)
  assert.deepEqual(c.search('mom').map((p) => p.name), ['Jamie Rivera'])
  assert.deepEqual(c.search('acme').map((p) => p.name), ['Acme Dental'])
  assert.equal(c.search('jamie')[0].phones[0].label, 'Mobile')
})

test('messages: chats newest first with names, unread counts and tapback previews', () => {
  const contacts = createContacts({ root: join(fx.home, 'Library', 'Application Support', 'AddressBook') })
  const m = createMessages({ file: join(fx.home, 'Library', 'Messages', 'chat.db'), contacts, home: fx.home })
  const chats = m.listChats()
  assert.deepEqual(chats.map((c) => c.title), ['Ride Crew', 'Jamie Rivera'])
  assert.equal(chats[0].isGroup, true)
  assert.equal(chats[0].unread, 2)
  assert.equal(chats[0].last.text, 'I am in')
  assert.equal(chats[1].last.text, 'They loved a message', 'the latest row is a tapback')
  assert.equal(m.listChats({ query: 'jamie' }).length, 1)
  assert.equal(m.getChat('any;-;+15550102233').id, 1)
  assert.equal(m.getChat('+15550102233').id, 1, 'a one-to-one chat by its handle')
  assert.equal(m.getChat('nope'), null)
})

test('messages: a thread reads oldest-first, decodes bodies, folds tapbacks, lists attachments', () => {
  const contacts = createContacts({ root: join(fx.home, 'Library', 'Application Support', 'AddressBook') })
  const m = createMessages({ file: join(fx.home, 'Library', 'Messages', 'chat.db'), contacts, home: fx.home })
  const one = m.getMessages(1)
  assert.deepEqual(one.messages.map((x) => x.text), ['Dinner at 7?', 'Yes! See you there'])
  assert.equal(one.messages[0].senderName, 'Jamie Rivera')
  assert.equal(one.messages[1].fromMe, true)
  assert.deepEqual(one.messages[1].reactions, [{ by: 'Jamie Rivera', kind: 'loved' }])
  const group = m.getMessages(2)
  assert.equal(group.messages[0].text, 'Ride Saturday at the reservoir', 'U+FFFC stripped')
  assert.equal(group.messages[0].attachments[0].mime, 'image/jpeg')
  assert.equal(group.messages[0].attachments.length, 1, 'link-preview payloads are not listed')
  assert.equal(group.messages[0].senderName, 'Sam Carter')
  const older = m.getMessages(2, { before: 5 })
  assert.deepEqual(older.messages.map((x) => x.id), [4])
  assert.equal(m.attachmentFile(1).path, join(fx.home, 'Library/Messages/Attachments/aa/01/X/IMG_1.jpeg'))
  assert.equal(m.attachmentFile(2), null, 'paths outside ~/Library/Messages are never served')
})

test('messages: search decodes attributedBody and filters', () => {
  const m = createMessages({ file: join(fx.home, 'Library', 'Messages', 'chat.db'), home: fx.home })
  assert.deepEqual(m.search('reservoir saturday').map((h) => h.messageId), [4])
  assert.equal(m.search('reservoir')[0].chat, 'Ride Crew')
  assert.deepEqual(m.search('see you', { fromMe: true }).map((h) => h.messageId), [2])
  assert.deepEqual(m.search('dinner', { chat: 2 }), [])
  assert.deepEqual(m.search('dinner', { since: '2026-10-02' }), [])
  assert.ok(m.findRecentOutgoing({ text: 'Yes! See you there', sinceMs: Date.parse('2026-10-01T17:00:00Z') }))
  assert.equal(m.findRecentOutgoing({ text: 'Yes! See you there', sinceMs: Date.parse('2026-10-02T00:00:00Z') }), null)
})

test('photos: index search, filters, people, albums and image files', async () => {
  assert.deepEqual(unpackLexemes(Buffer.from([1, 0, 0, 0, 0, 1, 0, 0])), [1, 256])
  const p = createPhotos({ library: fx.lib, cacheDir: join(fx.home, 'cache') })
  const dogs = p.search({ text: 'dogs' })
  assert.deepEqual(dogs.photos.map((x) => x.id).sort(), [fx.U(1), fx.U(3)])
  assert.deepEqual(dogs.understoodAs[0].matches, ['Dogs'])
  assert.ok(!p.get(fx.U(1)).labels.includes('Dogs'), 'labels are the primary words, not every synonym')
  assert.deepEqual(p.search({ text: 'dog at the beach' }).photos.map((x) => x.id), [fx.U(1)], 'words ANDed, stopwords dropped')
  assert.deepEqual(p.search({ text: 'independence day' }).photos.map((x) => x.id), [fx.U(1)], 'a phrase Photos knows stays whole')
  assert.equal(p.search({ text: 'zebra' }).total, 0)
  assert.deepEqual(p.search({ person: 'biscuit' }).photos.map((x) => x.id), [fx.U(3), fx.U(1)])
  assert.deepEqual(p.search({ album: 'trips', kind: 'video' }).photos.map((x) => x.id), [fx.U(3)])
  assert.deepEqual(p.search({ kind: 'screenshot' }).photos.map((x) => x.kind), ['screenshot'])
  assert.deepEqual(p.search({ from: '2026-07-05', to: '2026-07-05' }).photos.map((x) => x.id), [fx.U(2)])
  assert.equal(p.search({ favorite: true }).total, 1)
  assert.equal(p.search({}).total, 4, 'trashed assets are excluded')
  const first = p.get(fx.U(1))
  assert.deepEqual(first.people.sort(), ['Biscuit', 'Sam Carter'])
  assert.deepEqual(first.albums, ['Trips'])
  assert.deepEqual(first.location, { lat: 45.52, lon: -122.68 })
  assert.equal(first.place, 'Portland · Waterfront Park')
  assert.ok(first.labels.includes('Dog'))
  assert.equal(p.get(fx.U(2)).location, null, '-180/-180 means no location')
  assert.equal(p.get(fx.U(2)).caption, 'Harbor at dusk')
  assert.equal(p.get(fx.U(3)).durationSec, 12)
  assert.deepEqual(p.people().map((x) => x.name), ['Biscuit', 'Sam Carter'])
  assert.deepEqual(p.albums(), [{ title: 'Trips', items: 2 }])
  const img = await p.imageFile(fx.U(1))
  assert.match(img.path, /_1_105_c\.jpeg$/, 'the largest derivative wins')
  assert.equal(await p.imageFile(fx.U(2)), null, 'no local copy, nothing to convert')
  assert.equal(await p.imageFile('../../etc/passwd'), null)
})

test('send: handles are validated and the text travels as argv', async () => {
  assert.equal(validHandle('+1 (555) 010-2233'), '+15550102233')
  assert.equal(validHandle('alex@example.com'), 'alex@example.com')
  assert.equal(validHandle('"; do shell script "rm -rf ~"'), null)
  const calls = []
  const exec = (cmd, args, opts, cb) => {
    calls.push({ cmd, args })
    setImmediate(() => cb(null, 'sent', ''))
    return { stdin: { end: (script) => calls.at(-1).script = script } }
  }
  const s = createSender({ exec, platform: 'darwin' })
  await s.send({ chatGuid: 'any;+;chat123' }, 'He said "hi" & left')
  assert.deepEqual(calls[0].args, ['-', 'chat', 'any;+;chat123', '', 'He said "hi" & left'])
  assert.ok(!calls[0].script.includes('He said'), 'the message is never part of the script')
  await s.send({ handle: '555 010 2233', service: 'SMS' }, 'yo')
  assert.deepEqual(calls[1].args, ['-', 'handle', '5550102233', 'SMS', 'yo'])
  await assert.rejects(s.send({ handle: 'not a handle' }, 'x'), /not a phone number/)
  await assert.rejects(s.send({ chatGuid: 'x' }, '   '), /Nothing to send/)
  await assert.rejects(createSender({ exec, platform: 'linux' }).send({ chatGuid: 'x' }, 'hi'), /needs macOS/)
  assert.equal(explainOsascriptError('execution error: Not authorized to send Apple events to Messages. (-1743)').code, 'automation_denied')
})

test('createApple: off unless enabled on macOS; resolves recipients to existing chats; confirms sends', async () => {
  assert.equal(createApple({ enabled: true, platform: 'linux', home: fx.home }).status().state, 'unsupported')
  assert.equal(createApple({ enabled: false, platform: 'darwin', home: fx.home }).status().state, 'off')
  assert.throws(() => createApple({ enabled: false, platform: 'darwin', home: fx.home }).listChats(), /off/)
  const sent = []
  const exec = (cmd, args, opts, cb) => { sent.push(args); setImmediate(() => cb(null, 'sent', '')); return { stdin: { end() {} } } }
  const apple = createApple({ enabled: true, platform: 'darwin', home: fx.home, env: {}, exec })
  const st = apple.status()
  assert.equal(st.state, 'ready')
  assert.equal(st.sources.messages.messages, 5)
  assert.equal(st.sources.photos.photos, 3)
  assert.equal(apple.resolveTarget({ to: '(555) 010-2233' }).target.chatGuid, 'any;-;+15550102233', 'an existing one-to-one chat is reused')
  assert.deepEqual(apple.resolveTarget({ to: 'new@example.com' }).target, { handle: 'new@example.com', service: 'iMessage' })
  assert.equal(apple.resolveTarget({ chat: 2 }).chat.title, 'Ride Crew')
  assert.equal(apple.resolveTarget({ to: 'Mom' }).target.chatGuid, 'any;-;+15550102233', 'a contact name with one mobile number')
  assert.deepEqual(apple.resolveTarget({ to: 'Sam Carter' }).target, { handle: 'alex@example.com', service: 'iMessage' }, 'or their only email')
  assert.throws(() => apple.resolveTarget({ to: 'not a handle' }), /not a phone number, email or contact name/)
  assert.throws(() => apple.resolveTarget({ to: 'Jamie' }), /not a phone number, email or contact name/, 'a partial name is not a recipient')
  const out = await apple.send({ chat: 2, text: 'On my way', confirmMs: 2000, sleep: async () => {} })
  assert.deepEqual(sent[0], ['-', 'chat', 'any;+;chat123', '', 'On my way'])
  assert.equal(out.sent, true)
  assert.equal(out.recorded, false, 'nothing new in chat.db, so not confirmed')
  assert.equal(out.to, 'Ride Crew')
  const noAccess = createApple({ enabled: true, platform: 'darwin', home: join(fx.home, 'nowhere'), env: {} })
  assert.equal(noAccess.status().sources.messages.state, 'missing')
})
