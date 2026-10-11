# Apple: Messages, Contacts and Photos

When Totem runs on a Mac, it can read the owner's Messages (iMessage and SMS), Contacts and
Photos library, show the conversations in a Messages tab, and send messages through the Messages
app. Agents get the same data as tools and can draft a message, but only the owner sends one.

Off unless `APPLE_ENABLED=true`, and only on macOS. Code: `apple/`, the "Apple" block and
`appleApi` in `bridge.mjs`, the `totem_apple_*` tools, and the Messages tab in `web/src/messages/` (shown only when enabled; `/messages?chat=<id>` opens a conversation).

## How it works

Nothing is synced or copied. Each read opens the app's own SQLite database read-only and closes it:

| Source | File | Notes |
|---|---|---|
| Messages | `~/Library/Messages/chat.db` | Dates are nanoseconds since 2001-01-01. Most rows keep their text only in `attributedBody` (an archived NSAttributedString); `apple/typedstream.mjs` pulls the string out. Tapbacks are separate rows pointing at their target's guid and are folded onto it. Search decodes every body once into memory and then only reads new rows. |
| Contacts | `~/Library/Application Support/AddressBook/**/AddressBook-v22.abcddb` | One store per account plus a merged one; people are merged across them. Used to name message threads (matched on the last ten digits of a number, or the email). |
| Photos | `~/Pictures/Photos Library.photoslibrary/database/Photos.sqlite` and `search/leo.sqlite` | `Photos.sqlite` has dates, places, people, albums and favourites. The search index `leo.sqlite` (`psi.sqlite` on older macOS) maps each photo to the words Photos search knows for it: scene labels ("Dog", "Beach"), places, people, holidays, text in the image. That is how "dog at the beach" is answered without a model. Album join tables carry Core Data entity numbers that change between macOS releases, so they are looked up in `Z_PRIMARYKEY`. |

Images come from the library's JPEG derivatives (`resources/derivatives`), because with
"Optimize Mac Storage" most originals are not on disk. HEIC originals and HEIC message attachments
are converted with `sips` into `data/apple-cache/`.

Sending runs `osascript` against the Messages app (`apple/send.mjs`). The recipient and text are
passed as arguments, never pasted into the script. A message to a person with an existing
one-to-one conversation goes to that conversation. Otherwise it starts a new one with the handle.
After the send, Totem watches `chat.db` for up to eight seconds for the outgoing row, and reports
`recorded: false` if Messages has not written it yet.

## Setup on the Mac

1. **Messages history.** A new Mac only has messages from after it signed in. Open Messages →
   Settings → iMessage and turn on **Enable Messages in iCloud**, then wait for it to download.
   SMS (green bubbles) needs Text Message Forwarding to this Mac on the iPhone:
   Settings → Apps → Messages → Text Message Forwarding.
2. **Full Disk Access for node.** The databases above are protected by macOS privacy controls,
   and the grant belongs to the binary running Totem, not to Totem. With `APPLE_ENABLED=true`,
   the Messages tab (and `GET /api/apple/status`) names the exact path (for Homebrew, something
   like `/opt/homebrew/Cellar/node@24/<version>/bin/node`). In System Settings → Privacy & Security
   → Full Disk Access, click +, press ⌘⇧G, paste the path, enable it, and restart Totem.
3. **Automation for sending.** The first send asks, on the Mac's screen, whether node may control
   Messages. Click Allow. Until then sends fail with "macOS has not allowed Totem to control
   Messages". The setting lives under Privacy & Security → Automation. On a headless Mac, do the
   first send while connected with Screen Sharing.
4. Set `APPLE_ENABLED=true` in `.env` and restart.

Both grants are tied to the binary's real path. A `brew upgrade node` that installs a new Cellar
version silently drops them. The status reports `no-access` and names the new path to add.

## Sending, and who can

- **The owner**, from the Messages tab (`POST /api/apple/send`), sends directly. The action log
  records the recipient, not the words.
- **Agents** (chat, phone requests, totems, MCP clients) cannot send.
  `totem_apple_propose_message` stages an `imessage` proposal in the inbox, with the text in
  `inbox-prompts/P<n>.message.txt`. The recipient is resolved when the draft is staged, so a bad
  number fails then rather than after the owner says yes. Accepting it in the dashboard sends it.
  `totem_resolve_inbox` refuses to accept one, even with an active approval session: words sent to
  another person in the owner's name need the owner's own click.

## Agent tools

Registered on `/mcp` only when enabled, and re-served by the gateway as `apple__*`.

| Tool | Preset | Does |
|---|---|---|
| `totem_apple_get_status` | `readLocal` | per source: ready / no-access (with the fix) / missing, and counts |
| `totem_apple_get_chats` | `readLocal` | conversations, newest first, with names, unread count, last message |
| `totem_apple_get_messages` | `readLocal` | one conversation oldest-first, with tapbacks and attachments; `before` pages back |
| `totem_apple_search_messages` | `readLocal` | messages containing all the words; chat, date and from-me filters |
| `totem_apple_find_contacts` | `readLocal` | people by name, nickname, company, number or email |
| `totem_apple_search_photos` | `readLocal` | Photos search words plus person, album, place, dates, favourite, kind; `understoodAs` says what each word matched |
| `totem_apple_get_photo` | `readLocal` | one item with albums and labels, and `imagePath`, a JPEG the agent can open and look at |
| `totem_apple_get_photo_collections` | `readLocal` | named people and pets, and albums, with counts |
| `totem_apple_propose_message` | `stageLocal` | draft a message into the inbox; never sends |

## HTTP

`GET /api/apple/status`, `GET /api/apple/chats?q=`, `GET /api/apple/chats/<id>?before=&limit=`,
`GET /api/apple/search?q=&chat=`, `POST /api/apple/send {chat | to, service?, text}`,
`GET /api/apple/attachments/<id>`, `GET /api/apple/contacts?q=`,
`GET /api/apple/photos?q=&person=&album=&place=&from=&to=&favorite=&kind=`,
`GET /api/apple/photos/<uuid>`, `GET /api/apple/photos/<uuid>/image`.
Every route answers 404 when Apple data is off. A missing permission is a 403 with
`code: "no_access"`, and the error text contains the fix.

## Privacy

Everything stays on the Mac until an agent reads it. A tool result goes to whichever model
provider that agent uses, like any other Totem data. The agent rule asks agents to quote only what
a request needs. Totem never writes to the Messages, Contacts or Photos databases.

## Settings

| Variable | Default | |
|---|---|---|
| `APPLE_ENABLED` | `false` | Turn the whole thing on (macOS only) |
| `APPLE_MESSAGES_DB` | `~/Library/Messages/chat.db` | Override for tests or another user |
| `APPLE_CONTACTS_DIR` | `~/Library/Application Support/AddressBook` | |
| `APPLE_PHOTOS_LIBRARY` | `~/Pictures/Photos Library.photoslibrary` | A library elsewhere (an external drive) |
