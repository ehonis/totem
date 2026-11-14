# Search

One keyword search over everything Totem holds, with no model involved. "Where did I
mention the watches?" is a lookup, so it should cost milliseconds, not tokens.

## What it covers

| Kind | Source | One result is |
|---|---|---|
| `note` (shown as Memory) | the notes repo (`MEMORY_ROOT`), minus `inbox.md` and `inbox-prompts/` | one heading section, with the line it starts on |
| `journal` | voice journal entries | an entry's transcript |
| `chat` | chat threads, totem chats included | one message |
| `task` | the task database, deleted tasks excluded | a task with its notes, tags, area and due date |
| `goal` | goals | a goal with its period and notes |
| `list` | lists | a list with its items |
| `project` | chat projects | the project's instructions, or its memory |
| `totem` | totems | a totem's instructions, or its `memory.md` |

## How it works

`search/index.mjs` is SQLite FTS5 in an in-memory database: BM25 ranking, porter stemming
("watch" finds "watches"), prefix matching on every word, and title hits weighted five times
body hits. Every word must match; if no result has them all, any word does and the response
says `loose: true`. User input is quoted term by term, so FTS syntax in a query is searched
for rather than interpreted.

The index is rebuilt from `search/sources.mjs` when a search arrives more than 30 seconds
after the last build. A full rebuild over a real install (about 600 documents) takes around
60 ms, so there is no incremental bookkeeping. A source that throws is skipped for that build
and reported in `/api/search/status`; it never takes search down.

## Surfaces

- **Search tab** (`/search?q=…`, shortcut `g f`): filters by kind with counts, highlighted
  snippets, full text inline, Open (goes to the chat, project, totem or note; other kinds open
  their area, landing on the item: see below), and **Add to chat**.
- **Add to chat**: `POST /api/search/context {id}` saves the result as Markdown in a text
  upload (`chat/uploads.mjs`), the same thing a long paste becomes. The browser queues it
  (`web/src/chat/pendingContext.ts`) and the chat composer shows it as an attachment chip in a
  new chat or the chosen one. Nothing is sent until the owner sends it.
- **HTTP**: `GET /api/search?q=&kinds=note,chat&limit=`, `GET /api/search/doc?id=`,
  `GET /api/search/status`.
- **MCP**: `totem_search_everything` and `totem_search_read` on `/mcp`, and as
  `search__everything` / `search__read` through the gateway (`mcp-gateway.mjs` slices them
  from the bridge, so the gateway needs `BRIDGE_SECRET`, as with Strava). Snippets mark
  matches with `[brackets]`. The older `totem_search_brain` is unchanged. To browse or read
  whole chats rather than single messages, agents use `threads__list`/`threads__read`
  (`docs/chat.md` → Other chats), which use this index for their `query`.

## Landing on the match

Opening a result scrolls the page it opens to the thing that matched and flashes it for about a
second: an accent wash that fades, or, with less motion (the system's setting or Settings →
Appearance), a still outline that clears after the same second. On the web this is
`web/src/landing.ts`; in the iPhone app the same store and mapping are in
`mobile/src/lib/landing.ts` and the hook and flash in `mobile/src/ui/landing.tsx`.

- The opener calls `requestLanding(kind, id, extra)` (from `hitLanding(hit.target)`) and
  navigates. The request lives in memory, never in the URL, so a reload or Back flashes nothing.
- The destination calls `useLandOn(kind, …)`: once it is ready, `prepare` puts the item on screen
  (a tab, a fold, a period), then it waits for the item (web: an element marked
  `data-land="<kind>:<id>"`; app: `locate` scrolls a list to it), scrolls it into view and
  flashes it. Nothing is found within six seconds of the request: it gives up without a word.
- A target more than about two screens away is jumped to, a near one scrolled to smoothly
  (`isFar` on the web, `farIndex` in the app): a long pan used up the flash before the item
  arrived. The flash starts once the item has stopped moving.

| Hit | Lands on |
|---|---|
| `chat` | the message (`target.message`); the flash is on your bubble or the reply's text (with a margin), not the whole row. While it lands the chat does not follow its bottom (`web/src/chat/follow.ts`; the app's `ChatFrame` `followEnd`), so an image or code block growing the log cannot pull it back down; it goes back down if the message never shows. |
| `task` | its row, with the scope, search and Snoozed/Completed folds opened as needed. Archived tasks are not on the board: no landing. In the app a snoozed one isn't either. |
| `goal` | its card, on the tab of its period (`target.period`; a step's is its goal's), stepped to the window it was filed under (`start`/`end`) unless that is the current one. A step lands on its own row on the web and on its goal's card (`parent`) in the app. |
| `list` | the list, then the item the query matched (`target.item`); a title match lands on the list's header. The app opens the list's own screen. |
| `journal` | the entry's card. |
| `note` | the heading its section starts at (`target.line`; text before the first heading lands on the note's start). The app shows a note as a sheet of that section, so nothing to scroll. |
| `project` | the Instructions or Memory tab (`target.section`), flashed. The app has no such tabs; it flashes the instructions on the project page. |
| `totem` | the totem's Settings tab at its instructions, or its Memory tab (`target.section`). |

`target.item` is chosen at search time: a source may give a doc `parts` (`[{ id, text }]`, a
list's items). They are stored with the doc and never returned; `matchPart()` in
`search/index.mjs` names the first part with every query word as a word prefix (else any word).
Settings search uses the same flash (web `flashElement`, app `LandFlash`).

## Adding a source

Add a loader to `search/sources.mjs` returning `{ id, title, body, date?, target?, parts? }`
docs, add its kind to `KINDS`, register it in the `searchIndex` block in `bridge.mjs`, and give
it a label and icon in `web/src/components/SearchView.tsx` (and the app's
`mobile/src/features/search/shared.tsx`). `target` is what Open navigates to; to land on the
item, map it in `hitLanding()` (both copies) and call `useLandOn` in the view it opens.
