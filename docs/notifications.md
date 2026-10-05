# Notifications — getting Totem onto your lock screen

Everything Totem interrupts you for: a reminder you set, a task due, the daily
digest, a goal nearly finished, a job that broke. One queue, one ledger, one
place that says why something did or did not arrive.

Design and rationale: [the push notifications spec](superpowers/specs/2026-09-11-totem-push-notifications-design.md).

## The one constraint everything else follows from

**iOS only delivers push to a web app that has been added to the Home Screen.**
Not to a Safari tab, on any iOS version. The APIs exist in a tab and subscribing
appears to work; nothing ever arrives.

So the first-time setup is, in order:

1. `node notify/cli.mjs keys` on the box, paste the three lines into `.env`,
   restart the bridge (`npm run service:restart`).
2. On the phone, open `https://<your-host>` **in Safari**, tap Share →
   **Add to Home Screen**.
3. Open Totem **from the new icon**, go to Settings → Notifications, tap
   **Turn on**, and allow the permission prompt.
4. Tap **Send test** — from the phone or from your computer; it goes to every
   registered device either way.

Step 3 has one shot. iOS asks for notification permission once, and a refusal
sticks until the web app is removed from the Home Screen and re-added. The panel
says so rather than leaving you with a toggle that does nothing.

## Where things live

| Thing | Location |
|---|---|
| Slots, quiet hours, spacing, expiry (pure, tested) | `notify/schedule.mjs` |
| The routing table — one row per category | `notify/categories.mjs` |
| Ranking a day's facts into a plan | `notify/plan.mjs` |
| The facts themselves | `notify/signals.mjs` |
| Quota facts from the usage poller | `notify/usage.mjs` |
| Turning a release into an inbox item you can fire off | `notify/updates.mjs` |
| Is it still true, seconds before sending? | `notify/revalidate.mjs` |
| Queue, devices, ledger, feedback log | `notify/store.mjs` |
| RFC 8291 encryption + RFC 8292 VAPID, no dependencies | `notify/push.mjs` |
| The single place a push goes out | `notify/notifier.mjs` |
| The receipt + answer summary for a phone request | `notify/shortcut.mjs` |
| `/api/push*` routes | `notify/http.mjs` |
| Service worker | `web/public/sw.js` (served at `/sw.js`) |
| Manifest + icons | `web/public/manifest.webmanifest`, `web/public/icons/` |
| Client subscription | `web/src/push.ts` |
| Settings panel | `web/src/components/NotificationsSettings.tsx` |
| Preview / key generation | `node notify/cli.mjs preview` \| `facts` \| `keys` |
| Queue state | `data/notification-queue.json` (gitignored) |
| Devices | `data/push-subscriptions.json` (gitignored — **secret**) |
| The bell's record | `data/notification-ledger.json` (gitignored) |
| Feedback | `data/notification-feedback.jsonl` (gitignored, append-only) |

## The test button is the real path

`POST /api/push/test` calls the same `notifier.deliver` the scheduled drain
calls. There is no demo path. A test that reaches the phone proves the digest
will too, which is the entire reason it was built that way.

## The phone's two pushes around a Shortcut request

`notify/shortcut.mjs`, wired into `handleAskText` in `bridge.mjs`. A request from
the iOS Shortcut is the one front door with no screen: the popup appears when the
answer does — thirty seconds to two minutes of nothing on a real request — and
it's gone the moment it's dismissed. So the phone gets two:

| | When | What it says | AI |
|---|---|---|---|
| `shortcut.received` | Before the agent starts | "Totem got it" + what you asked, flattened to one line | **None** |
| `shortcut.answered` | After the reply | A one- or two-sentence summary, linked to the transcript thread | Haiku |

**The receipt carries no AI, deliberately.** Its whole job is to land in the
second the request does — "it's running, put the phone away" — and a model can
only add latency to that plus the chance of it saying something other than what
was asked. It is sent, not awaited: a receipt that delays the work it announces
is worse than no receipt.

**The summary is the opposite case.** A full `http` answer is paragraphs of plain
text, and a lock screen truncates it mid-sentence — so something has to choose
the sentence. That's the whole reason this exists, and it's the one place a model
is involved. The prompt is the editable `shortcut-summary` skill; the wording
rules (title is a label, body is the content) are the same ones in
`notify/text.mjs`.

The summariser is **not** `runAgent`, and that is not an oversight:

- `runAgent` resolves the configured default provider and model, and an id
  outside the catalog is quietly replaced by Opus — Haiku is deliberately absent
  from the picker, so asking for it through there gets you the expensive model.
- It renders Totem's persona and the memory/inbox rules in front of the prompt
  and hands the model the whole toolbox. The last thing a summariser should be
  able to do is *act* on what it's summarising.

So it spawns `claude -p --model haiku` directly, with `--strict-mcp-config`,
`--no-session-persistence`, `--setting-sources user` and the write tools denied,
from `$HOME` rather than the repo — everything else is cold-start latency it
doesn't need. Same bargain as the digest's wording call: if it fails, times out,
or comes back unparseable, **the answer's own opening ships instead** and the
notification still goes out. A title over 32 characters is dropped for the
generic label rather than truncated, because the phone cuts the end and the end
is the point.

Neither push replaces the Shortcut's own reply. The popup still returns the full
text, and the transcript still lands in a temporary web chat — which is what the
answer notification deep-links to.

`SHORTCUT_NOTIFY=false` turns both off; Settings → Notifications can too, per
category. Both categories override quiet hours and are pinned: he is standing
there holding the phone, so a receipt that waits until 07:00 is not a receipt.

## The voice journal's push

`journal.ingested` goes out the moment a journal entry's digest finishes — a few minutes after he
saved it, so he is usually still holding the phone. The body is built from what the digest
reported ("2 memory updates · 1 proposal in the inbox · 1 habit logged") and the link is `/inbox`
when there is something to decide, the Journal otherwise. It is deferred in quiet hours but not
pinned: a morning ritual he already knows happened is the one thing here he might reasonably
learn to silence. `journal.failed` (transcription or digest broke; the entry keeps what it can and
offers Retry) *is* pinned. Both go through `jobStore.notify`, so they land in the same ledger as a
failed job. See `docs/journal.md`.

## The feed — news, releases, people

`notify/feed.mjs`. Everything else here reads the owner's own data, where a fact is
true or it is not. A feed is an unbounded stream of things that are all true and
mostly uninteresting, so the design is mostly restraint:

- **A watermark per source.** Something is news the first time it is seen and
  never again. **The first scan of a source says nothing** — it records a
  baseline. Announcing the version he has been running for a week, the first time
  the feature runs, is how it loses credibility on day one.
- **A points floor**, not a relevance guess. Hacker News with no floor is a
  firehose; with one it is a front page.
- **A cap per scan.** Forty new items produce one notification about forty
  things, not forty notifications.
- **No AI in the loop.** A model asked "is this big?" says yes, because that
  sounds more helpful. Points, version numbers and keyword matches do not
  flatter anyone.

Shipped sources, all public and unauthenticated — an API key is a thing that
expires silently, and silence is this feature's failure mode:

| Source | What it watches |
|---|---|
| `t3-code` | npm `t3` stable tag. The nightly moves most days and is noise by design. |
| `claude-code` | npm `@anthropic-ai/claude-code` stable tag |
| `theo` | Theo's YouTube Atom feed |
| `ai-models` | Hacker News ≥150 points, filtered on model/lab keywords |
| `hn-big` | Hacker News ≥800 points, unfiltered |
| `world` | AP, Reuters and BBC World — three headlines at 07:15 and 18:00 |
| `good` | Good News Network, Positive News, Reasons to be Cheerful — two at 12:30 |

Feed items go **straight to the queue**, not into the day's plan: a model release
at 2pm is stale by the evening digest. Quiet hours still apply through the
category, so nothing here arrives at 3am. The last two are the exception — see
below.

### The two roundups — world news and good news

The rules above are sized for something that happens a few times a week. World
news happens continuously, and a story-by-story stream of it is the one thing
this was asked never to be: *"nothing too complicated as I don't want it to ruin
my day, but I want to know what is happening in the world."* So a source can set
`bundle: n` and `deliverSlots`, and then it behaves completely differently — it
collects quietly all day and lands as **one notification at a fixed hour**, n
headlines in the body:

| | Hour | What lands |
|---|---|---|
| `news.world` | 07:15 and 18:00 | Three headlines, one per desk, each credited |
| `news.good` | 12:30 | Two stories, uncredited |

Three pushes a day, each bounded and predictable, each independently switchable
off. The rest of the design follows from that:

- **Wire services, because "unbiased" is not something a source can be.** AP and
  Reuters sell the same copy to outlets across the whole political spectrum,
  which is a commercial reason to report what happened rather than what to think
  about it. Neither publishes a public RSS feed any more — AP's 403s and Reuters
  retired its own in 2020 — and both still syndicate through Google News, so
  those two are search queries rather than URLs. BBC World is the third because
  it is a real feed, it is not American, and a story all three carry is a story.
- **One story per desk, in turn.** The first live roundup was three Reuters
  headlines: Google News stamps a wire firehose fresher than the BBC's feed, so a
  straight newest-first sort hands the whole bundle to whoever publishes fastest,
  which quietly undoes the reason three of them are being read.
- **The same event from three desks is one headline.** Word overlap, not a model
  — "is this the same story?" is exactly the question an AI answers agreeably,
  and a wrong yes silently deletes a real headline. `sameStory` is strict for
  that reason: three shared significant words *and* half the shorter headline.
- **A later scan rewrites the waiting roundup rather than stacking a second.**
  The bundle is keyed on the hour it is for, so the 09:00 scan replaces the
  07:00 scan's entry — which is why an undelivered bundle's stories stay
  **un-watermarked**. Watermarking them at scan time is the bug this design is
  shaped around: the replacement would silently drop every headline the earlier
  scan had found. Once the hour passes, they become history and can never come
  back.
- **No "…and 26 more."** The burst rule for an unbundled source exists to say
  "you are missing things", which is right about a release. Said about the world
  it is a number he cannot act on attached to the exact feeling this feature was
  asked not to give him. Three headlines and a tap through to the wire is the
  whole promise.
- **A failed scan delays a roundup, it does not lose one.** The 07:00 scan is
  the only one that can build the 07:15 bundle, so a network blip costs the
  morning roundup — but the stories it would have carried are still unseen and
  still inside the source's own age window, so they turn up in the 18:00 one.
- **A bigger watermark.** Eight scans a day across three fast feeds evicts a
  story from the standard 200-id history while it is still sitting on the wire,
  and it comes back as news. `world` keeps 800.
- **Good news is its own push, deliberately.** Stapled to the bottom of a world
  bundle it is a story nobody reads, and one that could not be turned off
  separately would be advertising. The three sources are solutions-and-progress
  desks rather than the viral-animal genre — they report things that actually
  happened, which is the only reason they sit beside the wire services.

### A release you can actually act on

`notify/updates.mjs`. "Claude Code 2.1.275 is out" names a version and leaves the
work to later, which usually means never. So for the two tools this box runs, a
release it is **behind** stages a confirm-only `command` proposal in the inbox —
the update command, screened and explained — and the push deep-links straight to
it at `/inbox#P12`. The card opens with its details already showing, because the
point of the link is to read what will run before saying yes.

| Source | What the box is asked | What accepting runs |
|---|---|---|
| `claude-code` | `claude --version` | `claude update` |
| `t3-code` | `activeVersion` in `~/.t3/runtime/service-state.json` | `npx -y t3@latest service update` |

Three rules keep this honest:

- **The box is asked what it is running.** npm's `latest` tag is not what is
  installed. Claude Code here is the **native installer** under
  `~/.local/share/claude`, not a global npm package — `npm i -g` would leave two
  copies and a symlink pointing at the old one. The old feed line "you were on
  2.1.273" actually meant *the version npm published before this one*, which is a
  different fact that read exactly like this one.
- **The channel is respected.** `t3 service update` writes the same
  `t3code.service` unit whichever channel it runs from, so pointing the stable tag
  at a nightly install is a silent channel swap, not an update. A prerelease build
  raises no proposal at all (and closes one staged before the switch).
- **The proposal closes itself when it stops being worth having.** Every scan
  reconciles, not just the ones that find a release: update Claude Code from a
  terminal and the open proposal is resolved on the next pass. A newer release
  supersedes a proposal targeting an older one rather than stacking a second.

If the installed version cannot be read, nothing is staged and the notification
is the plain release line — "I could not check" is never treated as "you are up
to date".

## Quota — what the subscriptions are doing

`notify/usage.mjs`, fed by the ai-usage poller's last snapshot (no network call:
the collection runs on every drain tick to revalidate). Four facts, three
categories:

| Fact | When | Category |
|---|---|---|
| `usage.low` | a window past `NOTIFY_USAGE_LOW_PCT` (default 80%) | `usage.limit` |
| `usage.spent` | a window at 99%+ — work on that provider is blocked | `usage.blocked` |
| `usage.burning` | spending ≥1.6× an even pace, with time left to act on it | `usage.limit` |
| `usage.idle` | a long window about to roll over mostly unspent | `usage.idle` |

**Only windows measured in days may say anything but "spent."** A five-hour
window at 82%, planned at 12:30 and delivered at 15:30, is a sentence about a
window that has already reset — see the revalidation rules above. A five-hour
window that is *spent* stays spent until it refills, so that one is allowed, and
it expires at `resetsAt` rather than at midnight.

`usage.burning` ignores the first tenth of any window: one busy hour on a Monday
is a 10× ratio and means nothing. `usage.idle` is `suppress` in quiet hours and
unpinned — "you are not using what you pay for" is the most reasonable thing here
to get tired of hearing.

### About X

There is no source for X/Twitter, and that is not an oversight. X has no free
API and no reliable public feed; the usual workarounds (Nitter instances, RSS
bridges) get blocked and then fail silently, which is the one failure mode this
feature cannot afford. Theo's YouTube feed is the honest proxy. If literal X
posts are wanted, that needs a paid X API key, and it should be added as a
source with the key in `.env` rather than scraped.

## Gotchas

- **Rotating `VAPID_PRIVATE_KEY` silently kills every subscription.** Every
  device must re-subscribe. Nothing errors; notifications just stop.
- **`aud` is the endpoint's origin, not the endpoint.** The most common VAPID
  rejection, and the push services' error text never says so. `audienceFor()`
  handles it; don't hand-build the JWT.
- **A push that shows no notification can cost you the subscription.** iOS
  revokes subscriptions that receive pushes silently, which is why `sw.js` calls
  `showNotification` on every path including a malformed payload.
- **404/410 from the push service means the web app was removed from the Home
  Screen.** The device is marked `expired` and stays visible in Settings rather
  than being deleted, so "why did I stop getting these" has an answer.
- **Cloudflare Access gates the origin, not the push.** Delivery goes from the
  bridge to Apple and never touches the tunnel. Access only matters when a
  notification is *tapped* and the app opens — an expired Access session shows a
  login instead of the deep link.
- **`/api/push/rotate` is mounted before the auth gate**, because a service
  worker has no bearer token. It authorises itself by naming an endpoint the
  server already knows. Don't move it behind `authorized()` — subscription
  rotation will start failing silently, which looks exactly like nothing.
- **The `Topic` header must be ≤32 URL-safe-base64 characters** (RFC 8030 §5.4).
  Apple answers `400 BadWebPushTopic` and drops the push entirely. Totem's dedupe
  keys are neither short nor legal, so `normalizeTopic()` hashes them. This bit in
  production: the test button sends no topic, so it worked while every *scheduled*
  push failed.
- **Only 429 and 5xx are retried.** Any other 4xx is this server's bug and will
  fail identically next time; "no devices" and "no VAPID keys" are not transient
  either. All of them fail the entry on the first attempt so the error reaches the
  logs instead of being retried three times.
- **The service worker caches nothing, deliberately.** Totem is a live dashboard
  behind an authenticated API; an offline copy would be a stale, confusing
  version of a personal assistant.
- **Algolia has no boolean `OR`.** `query=Claude OR Anthropic OR OpenAI` matches
  none of them and returns whatever it thinks is close — in testing, an OCR post
  and a YC launch. Fetch wide on the points floor and filter on keywords in
  `readSource`, which is what `match` does.
- **A queue entry must carry its `subject`.** The revalidator looks the goal or
  habit up by it at delivery. Without it the goals resolver looked up `undefined`,
  found no goal, and reported the goal *finished* — a congratulation for something
  sitting at 73%.
- **A fact key with a number in it and no identity beside it goes silent, not
  stale-proof.** That is the old behaviour: any change dropped the notification.
  If you add a collector, give every fact both keys.
- **`sw.js` must stay in `web/public/`** so Vite copies it to the origin root
  unhashed. A bundled service worker cannot claim the scope it needs.

## Scheduled notifications

Two seed jobs, editable and deletable in Totems like any other:

| Job | Default | What it does |
|---|---|---|
| `daily-digest` | 07:15 | Collects the day's facts, words them, and schedules them across the day |
| `evening-digest` | 20:30 | Re-plans what is left of tonight, superseding the morning's undelivered entries |

Both off until `DIGEST_ENABLED=true`. Neither sends anything: they build a plan,
and the queue drain — on the job engine's existing 30-second tick, so there is no
second scheduler — sends each entry at its own time.

**Every run re-plans the whole day.** A digest collects the facts afresh, ranks
them, and replaces every *undelivered* planned entry for that day, whichever run
planned it. So the evening run is not an addition to the morning's plan, it is a
correction of it: a fact that stopped being true simply does not come back, and a
new one slots in. Three rules keep that from turning into repetition:

- **Already delivered today is never re-planned.** The evening run sees the same
  birthday the morning run sent and skips it.
- **The cap is a budget for the day, not per run.** Four sent this morning means
  the evening run plans nothing.
- **Ad-hoc reminders are never touched.** They carry no plan date, so re-planning
  cannot cancel the thing you asked to be reminded about.

### Nothing goes out of date

**Every entry is re-checked seconds before it goes out** (`notify/revalidate.mjs`),
because a plan built at 07:15 fires all day and the ride may have happened at
13:00. Four verdicts:

| Verdict | What it means | What is sent |
|---|---|---|
| `fresh` | still true, numbers and all | what was planned, in Totem's voice |
| `changed` | same fact, different numbers | the collector's **current** sentence |
| `resolved` | it stopped being true because he did it | the other copy — "done for the week, 4 of 4" |
| `stale` | it stopped being true, and there is nothing nice to say | nothing |

`changed` is the one that earns the file. A real notification read *"50 Miles
Biked — at 73%, 3 days left"*, planned at 07:15 for 18:00, after a ride that had
already taken it past 73%. So a fact now carries **two** revalidation keys:

- **`identity`** — which notification this is (`near:<goalId>:<date>`). No numbers.
- **`factKey`** — what was true when it was planned (`near:<goalId>:<date>:73`).

Identity matches and the fact key doesn't → the fact moved, so it is re-rendered
from the fresh collector output and sent with the number it has *now*. Identity
gone entirely → the resolver decides between `resolved` and `stale`.

Two consequences worth knowing:

- **A re-rendered entry loses its AI wording.** The rewrite was written at plan
  time against the old figure and cannot be trusted to describe the new one, and
  the model is deliberately not on the delivery path. Flat and correct beats
  fluent and wrong.
- **The queue row is updated to what was actually sent**, not what was planned.
  A queue that still says 73% after sending 91% is the thing that made this look
  broken in the first place.

The same rule shapes what is allowed to be *raised* at all: **only raise a nudge
whose truth outlives the gap between planning it and delivering it.** That is why
`notify/usage.mjs` will not schedule "your 5-hour window is at 82%" — by the time
it lands, that window has reset.

Anything that cannot be verified is still treated as stale, including a collector
that throws: a notification that could not be checked is exactly the one not
worth the trust it spends.

The AI has one job — wording — and it runs at *plan* time, hours before anything
is due, on a 90-second budget (`DIGEST_AI_BUDGET_MS`). If it fails, times out, or
drops a fact, the collectors' own wording ships instead. Facts are never invented
and never lost: `keepsFacts()` requires every number and name in the template to
survive the rewrite, per line.
