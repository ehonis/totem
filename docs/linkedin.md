# LinkedIn

Totem reads the owner's LinkedIn (notifications, conversations, feed, profiles) through
its own browser, and proposes small things for him to do there: a like, a repost, a
comment, a reply, a connection. **It never acts on LinkedIn.** Each proposal is a card in
the Totem inbox with the link and a draft; he opens the post, does it if he agrees, and
marks the card done, or denies it.

Code: `linkedin/` (URLs, the in-page reader, the reader with its sign-in and page budget,
the proposal rules, the tools, the totem's instructions), `browser/read-only.mjs` and
`readPage` in `browser/manager.mjs` (the GET-only page load), the "LinkedIn" blocks in
`bridge.mjs` (the `linkedin` inbox kind), `web/src/components/InboxView.tsx` and
`mobile/src/features/inbox/InboxScreen.tsx` (`LinkedinCard`).

## Why it works this way

- **No API.** LinkedIn's official API does not let a personal account read its feed,
  notifications or messages, or react to posts; those are partner-only. So the connector
  reads the pages a signed-in browser sees.
- **No automation.** Automated activity breaks LinkedIn's terms and gets accounts
  restricted. The connector reads slowly, sends nothing, and leaves every action to the
  owner's own hand.
- **No cookie pasted in.** Community MCP servers ask for the `li_at` cookie. Here the owner
  signs in himself, in a chat's browser panel, and Totem keeps what that sign-in left.

## Signing in

In any dashboard chat, say "connect my LinkedIn". The agent opens
`https://www.linkedin.com/login` in the chat's browser (`preview_open`) and hands it to the
owner (`preview_handoff`); he signs in in the panel, including any two-step check, and
presses Done. The agent then calls `linkedin__sign_in`, which copies **only LinkedIn's
cookies and storage** from that chat's browser and checks them with one read of the feed.

They are kept in `data/linkedin-tokens.json` (0600; `LINKEDIN_SESSION_FILE` overrides).
Being a `data/*-tokens.json` file, it is under the same rules as the other credential
files: Claude's file tools are denied it, and the change flow refuses to commit anything
that holds its values. Another agent with a shell can still read it, as it can every
token Totem holds (AGENTS.md → Gotchas, "Agents can read what the bridge's user can read").
`linkedin__sign_out` deletes it.

When LinkedIn ends the session (it sends the browser to `/login`, `/authwall` or
`/checkpoint`), the reader marks the sign-in ended and every tool says to sign in again.
LinkedIn rotates cookies as it goes; the reader saves the newest after each read.

## Reading, read-only

Every read is one page in a fresh browser context made from the saved sign-in, through
`readPage`. Its request policy (`readOnlyRequestDecision`, `browser/read-only.mjs`) lets
out **only GET and HEAD requests over https to `linkedin.com` and `licdn.com`**, and no
images, media or fonts. Everything else the page's own script tries is aborted before it is
sent: a reaction, a comment, a "seen" or read receipt, a tracking beacon. WebSockets are
closed, service workers blocked, popups closed, downloads refused. The connector's code
never clicks, types or submits; `linkedin/linkedin.test.mjs` checks its source for any of
that, and that the browser is used through `readPage` alone.

A read returns the page's visible text (capped near 12,000 characters), the links worth
acting on (posts, profiles, conversations), and, where LinkedIn marks posts with their
urn, each post on its own (`posts`: author, text, url). Text and links rather than exact
selectors, because LinkedIn renames its classes often and a model reading text copes with
a redesign where a selector would return nothing. If a redesign empties `posts`, `text`
and `links` still carry the page.

**Slowly.** At most 20 page loads an hour (`LINKEDIN_MAX_PAGES_PER_HOUR`), one at a time,
each after a pause of 1.5 to 5 seconds. Nothing polls in the background: a page loads only
when a tool is called, by a chat or by the totem on its schedule. Each read is a
`linkedin` run in the source-health log (Settings → Connections › Data sources), so a
LinkedIn that stopped answering shows there; not signed in shows as not set up.

## Tools

On `/mcp` they are `totem_linkedin_*`; through the gateway they are `linkedin__*`. They
register only where Totem has a browser (Chromium found and `BROWSER_ENABLED` not off).

| Tool | Does |
|---|---|
| `get_status` | Signed in or not, why not, and the hour's page budget |
| `sign_in` | From a chat: saves the LinkedIn sign-in in that chat's browser, then checks it |
| `sign_out` | Deletes the saved sign-in |
| `get_notifications` | The notifications page |
| `get_messages` | The conversation list (`conversations`: name, preview, unread, url) |
| `get_conversation` | One conversation, by its `/messaging/thread/…` URL |
| `get_feed` | Recent feed posts (`count` 1 to 25) |
| `get_profile` | One profile, by its `/in/…` URL |
| `propose_action` | Stages a `linkedin` card in the inbox |
| `list_proposals` | Every card so far, newest first: open, done or denied |

Without a sign-in every read fails with "not connected" and `propose_action` stages
nothing.

## Cards

`propose_action` takes `kind` (`like`, `repost`, `comment`, `reply`, `connect`),
`targetUrl` (a post for like, repost and comment; a conversation or post for reply; a
profile for connect), `authorName`, `postExcerpt`, `draftText` (required for comment and
reply, optional for repost and connect, whose note is 300 characters at most) and
`reason`. The card is a JSON file beside the inbox line (`inbox-prompts/P<n>.linkedin.json`),
read back and checked against the line's `target:` on every listing.

- **Once per target, ever.** The URL is made canonical (`https://www.linkedin.com/…/`, no
  query or hash) and a target already proposed (open, done or denied) is never staged
  again: `alreadyProposed` names the earlier card. A denial is final.
- **At most five wait.** With five open LinkedIn cards nothing more is staged (`capped`),
  so a run cannot flood the inbox.
- The draft is screened for hidden characters like any staged text; the post excerpt and
  author name only have them dropped, since they are shown and go nowhere.

The card shows the action, the author, what they wrote, the draft in an editable box,
**Open on LinkedIn** (a new tab) and **Copy**. Editing the draft changes only what is
copied; nothing is sent. **Mark done** (the accept) records that he did it, and is taken
only from the dashboard (web or app), never from an agent's approval session; it is low
risk at the approval gate, since nothing leaves the box. **Deny** skips it.

## The totem

"LinkedIn networking" (`linkedin-networking` in `SEED_JOB_DEFS`) is an agent totem, off
unless `LINKEDIN_NETWORKING_ENABLED` or switched on in Totems. Monday and Wednesday at
09:00 it checks the status, reads `list_proposals` and keeps what he took up and skipped in
its memory, reads notifications, messages and the feed, and stages at most three to five
cards, fewer when little is worth it. Drafts are in the owner's voice (a voice skill, where
the agent has one). It ends `QUIET` when it staged nothing, and notifies once when the
sign-in needs renewing. Its instructions (`linkedin/totem.mjs`) are editable in the
totem's settings like any other's; edits are kept.

## Gotchas

- **Untested against every LinkedIn layout.** The reader reads text and links, so a
  redesign degrades it rather than breaking it, but `posts` and `conversations` depend on
  LinkedIn's markup (`data-urn`, `/messaging/thread/` links). Check after a LinkedIn
  redesign with `linkedin__get_feed` from a chat.
- **A page that needs a POST to show its content shows less.** Blocking every non-GET is
  what guarantees nothing is sent, and it is kept even if some panel then fails to load.
- **Sign in from the machine Totem runs on.** The chat's browser runs on the box, so
  LinkedIn sees the sign-in coming from it; a new location may bring a two-step check,
  which the owner completes in the panel.
