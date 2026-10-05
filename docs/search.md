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
  their area), and **Add to chat**.
- **Add to chat**: `POST /api/search/context {id}` saves the result as Markdown in a text
  upload (`chat/uploads.mjs`), the same thing a long paste becomes. The browser queues it
  (`web/src/chat/pendingContext.ts`) and the chat composer shows it as an attachment chip in a
  new chat or the chosen one. Nothing is sent until the owner sends it.
- **HTTP**: `GET /api/search?q=&kinds=note,chat&limit=`, `GET /api/search/doc?id=`,
  `GET /api/search/status`.
- **MCP**: `totem_search_everything` and `totem_search_read` on `/mcp`, and as
  `search__everything` / `search__read` through the gateway (`mcp-gateway.mjs` slices them
  from the bridge, so the gateway needs `BRIDGE_SECRET`, as with Strava). Snippets mark
  matches with `[brackets]`. The older `totem_search_brain` is unchanged.

## Adding a source

Add a loader to `search/sources.mjs` returning `{ id, title, body, date?, target? }` docs,
add its kind to `KINDS`, register it in the `searchIndex` block in `bridge.mjs`, and give it a
label and icon in `web/src/components/SearchView.tsx`. `target` is what Open navigates to.
