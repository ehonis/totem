# Voice journal

Productivity → Journal (<kbd>G</kbd> <kbd>J</kbd>; <kbd>G</kbd> <kbd>J</kbd> <kbd>J</kbd> starts recording).

A red button, and the entries under it. The owner records a spoken journal entry — usually in the
morning, about the previous day — and Totem does the rest: transcribes it on the box, waits ten
minutes in case he changes his mind, then digests it into the brain, logs the habits it mentions,
and stages everything that would change the future as a confirm-only inbox proposal. The phone
gets one push saying what was filed and where.

This is the third journal path. The paper three-year journal stays. The nightly Plaud ingest
(`journal-ingest` skill) stays for recordings made on the Plaud. This one exists because a
recording made *in* Totem can be transcribed here, digested minutes later rather than the next
morning, and shown with a countdown he can stop.

## The rules

**The transcript is the record; the audio is a grace period.** A recording is kept for
`keepAudioDays` (default 14) after it has been transcribed, then swept. That is deliberately *not*
the original design — this shipped deleting the audio the moment the words existed, and the owner
changed it so there is a fortnight in which to listen back, save a copy, or hear a passage whisper
mangled. Three overrides live on the entry's ⋯ menu: **Keep the recording** pins it so no sweep can
take it, **Delete the recording** takes it now (the transcript is untouched), and a failed
transcription always keeps its audio at least 24 h so **Retry** has something to work with.

`keepUntil` is stamped on the entry when it is saved, from the setting in force at that moment, so
changing the setting later never retroactively destroys audio that was promised a longer life.
Unpinning starts a fresh window rather than expiring it immediately — "stop keeping" must not be a
surprise delete button. A 20-minute entry is roughly 10–20 MB, so a fortnight of daily entries is a
few hundred MB; set the window to 0 for the original delete-on-transcribe behaviour.

**Save starts a ten-minute clock.** The digest (the agent run) waits `ingestDelayMinutes` from the
moment he taps Save, and **Don't ingest** on the card wins any time before it starts. The clock runs
from save rather than from the end of transcription, because save is when he lets go of it. If
whisper takes longer than the window — it can, for a long entry on the CPU — the digest follows
transcription immediately. **Now** skips the rest of the countdown. The window is a setting in the
view (default 10 minutes; 0 means straight away).

**The words go into the brain before any model reads them.** At digest time the transcript is
appended to `MEMORY_ROOT/journal/YYYY-MM-DD.md` — a dated page, one `##` block per entry, in
paragraphs — and only then does the `voice-journal-ingest` skill run. The digest can fail, be
re-run, be edited; the record of what he said is on disk either way. A skipped entry writes
nothing: "don't ingest" means the brain never sees it. A re-run never appends the words twice (the
page carries an HTML-comment marker per entry).

**Everything that changes the future is a proposal.** Memory writes and habit completions are
things that already happened, so the skill does them. Tasks, calendar events, GitHub issues and
goal progress are things that *would* happen, so they land in `inbox.md` as `P<N>` lines — the
same inbox, the same accept/deny — with `src: voice journal YYYY-MM-DD`. The new inbox kind is
`goal`: `goal: <id or title> | metric: <id or label> | delta: 22` (or `value:`), accepted through
`goalService.updateMetric`; it is resolved leniently by title/label and refuses anything
ambiguous rather than logging a number on the wrong goal. Nothing scheduled completes or
postpones a goal here either.

**Morning entries are about yesterday.** The skill is handed both dates (`{{entryDate}}` and
`{{previousDate}}`) and told to read the transcript for "yesterday"/"this morning" cues, default
to the previous day when he is clearly recapping, and note the assumption on the event line.

## Where things live

| Thing | Location |
|---|---|
| Lifecycle | `journal/service.mjs` — save → transcribing → transcribed → (grace) → ingested / skipped |
| Storage | `journal/store.mjs` — one JSON per entry under `data/journal/entries/`, `data/journal/settings.json` |
| Speech to text | `journal/transcribe.mjs` — `ffmpeg` (from the `ffmpeg-static` package) → 16 kHz mono WAV → `whisper-cli` `-oj` |
| Text helpers | `journal/text.mjs` — paragraphing, the brain block, `JOURNAL_RESULT` parsing |
| HTTP | `journal/http.mjs` — `/api/journal*`, mounted in `bridge.mjs` beside todos and goals |
| Digest prompt | `skills/seeds/voice-journal-ingest/SKILL.md` → editable at `data/skills/voice-journal-ingest/` |
| Web | `web/src/components/JournalView.tsx`, `web/src/journal/{types,format,useRecorder,Waveform}.ts(x)` |
| Install | `scripts/install-whisper.sh` — cmake (portable tarball if the box has none), whisper.cpp, model |
| Waveform | `web/src/journal/Waveform.tsx` — canvas bars off the recorder's refs, no React renders |
| Card menu | `web/src/journal/EntryMenu.tsx` — the bare ⋯ popover; items are built by the card |
| Settings | `web/src/journal/JournalSettings.tsx` — modal, including the digest's model picker |
| Push categories | `journal.ingested`, `journal.failed` in `notify/categories.mjs` |
| Tests | `node --test journal/*.test.mjs`; `cd web && npx vitest run src/journal` |

### Entry shape

```json
{
  "id": "j_20260916110000_3f9a1c",
  "recordedAt": "2026-09-16T11:00:00.000Z", "date": "2026-09-16", "durationSec": 241,
  "source": "voice", "title": "Gym, dinner out, client demo",
  "audio": { "file": "j_….m4a", "mime": "audio/mp4", "bytes": 1893211, "keepUntil": "2026-09-30T…", "pinned": false, "deletedAt": null },
  "transcript": { "text": "…", "segments": [{ "start": 0, "end": 4.2, "text": "…" }], "language": "en", "model": "small", "ms": 61230 },
  "status": "transcribed",
  "ingest": { "state": "done", "at": "2026-09-16T11:10:00.000Z", "journalFile": "journal/2026-09-16.md",
              "result": { "title": "…", "summary": "…", "memory": ["events/2026-09.md"], "habits": ["gym"], "proposals": ["P41"], "goals": [], "mood": "tired" } }
}
```

`status` is transcription (`transcribing | transcribed | failed`); `ingest.state` is the digest
(`queued | running | done | skipped | failed`). The dashboard sees `publicEntry()`: no server
paths, and the audio reduced to `{ mime, bytes, kept, pinned, keepUntil, deletedAt }`.

### API

| Route | Does |
|---|---|
| `GET /api/journal` | entries (newest first) + engine status + settings |
| `POST /api/journal/entries` with `Content-Type: audio/*` and `?recordedAt=&duration=&mime=` | save a recording; transcription starts in the background |
| `POST /api/journal/entries` with JSON `{ text, recordedAt? }` | a typed entry — no whisper, straight to the grace window |
| `GET / PATCH / DELETE /api/journal/entries/:id` | read; edit `title` / `transcript`; delete (and any kept audio) |
| `POST …/:id/skip` | don't ingest |
| `POST …/:id/ingest` | now — or again, after a skip, a failure, or an earlier digest |
| `POST …/:id/retry` | run whisper again on a kept recording |
| `POST …/:id/keep-audio`, `POST …/:id/unkeep-audio` | pin the recording past every sweep, or put it back on the clock |
| `GET / DELETE /api/journal/entries/:id/audio` | the recording's bytes (`no-store`, with a filename), or delete just the audio |
| `GET / PATCH /api/journal/settings` | `{ ingestDelayMinutes, keepAudioDays, vocabulary, provider, model, effort }` |
| `GET /api/agent-models` | every provider with its live model catalog, health, and whether it takes a reasoning level |

The upload is raw bytes rather than multipart or base64: the phone already holds a `Blob`, and
there is nothing to decode on either side. `JOURNAL_MAX_AUDIO_MB` (default 100) is checked
against `Content-Length` before a byte is stored.

### The skill's contract

**Which agent runs it** is a journal setting (`provider` / `model` / `effort`, all empty by
default, meaning "whatever the Providers tab says"). Every other scheduled job simply takes the
default, and for most that is right — but this one reads twenty minutes of rambling and has to come
back with the right five facts, which is a different job from answering a phone request quickly. The
picker in the settings modal is fed by `GET /api/agent-models`. Cursor takes its model as
`cursorModel` (its ids can carry parameters like `composer-2.5[fast=true]`, which `bareModelId`
would strip); everything else takes `model`. A reasoning level is only offered for codex and claude.
The model id is deliberately **not** validated on save: cursor and opencode accept ids this process
never enumerates, and `resolveModelChoice` already corrects a stale one at run time.

`voice-journal-ingest` gets `{{transcript}}`, `{{recordedAt}}`, `{{entryDate}}`,
`{{entryDateLong}}`, `{{previousDate}}`, `{{previousDateLong}}`, `{{journalFile}}`,
`{{durationMin}}` (declared in `SKILL_CONTEXT_VARS`; `skills/seeds.test.mjs` mirrors the list). It
runs on the default provider through `runSkillAgent`, so it inherits the persona, `MEMORY_RULES`,
`INBOX_RULES`, `HABIT_RULES`, `GOAL_RULES` and the gateway tools like every other job. It must end
its reply with one line:

```
JOURNAL_RESULT: {"title": "…", "summary": "…", "memory": [...], "habits": [...], "proposals": ["P41"], "goals": [...], "mood": "…"}
```

`parseIngestResult` finds the *last* marker and reads the JSON by balanced-brace matching (the
prose may contain braces). A reply with no marker is still recorded — `parsed: false`, summary
from the prose — because the digest *did* run; the card just says "unstructured reply" and cannot
count what changed. The push body is built from the counts: "2 memory updates · 1 proposal in
the inbox · 1 habit logged", linked to `/inbox` when there is something to decide.

## Transcription

`scripts/install-whisper.sh` builds whisper.cpp with a portable cmake (the box has none and no
sudo), statically, tuned for the host CPU, and downloads `ggml-small.en.bin` (466 MB) to
`~/.local/share/totem/whisper/`. The bridge defaults `JOURNAL_WHISPER_BIN` and
`JOURNAL_WHISPER_MODEL` to those paths. `ffmpeg` comes from the `ffmpeg-static` npm package (a
root dependency now, ~78 MB static binary) unless `JOURNAL_FFMPEG_BIN` points elsewhere.

Whisper's *initial prompt* is the `vocabulary` setting — names it keeps mishearing (the field in
the view's settings panel). It biases spelling toward those words; "Robin" came out as "greasy"
without it. Product names ship as the default; people and places belong in `data/`, not code.

**Speed.** `small.en` on a six-core desktop CPU runs at roughly 1.5–2× realtime, so a
five-minute entry is two or three minutes of CPU, well inside the ten-minute window. `base.en` is
about three times faster and noticeably worse on names; `medium.en` is better and too slow to be
pleasant. The install script builds for the CPU only: a CPU build that always works beats a GPU
build that depends on the graphics driver staying in step with its libraries.

**Engine status.** `GET /api/journal` carries `engine: { ready, missing, fix, model, threads }`. The
view shows a red pill and a hint under the button when the engine is not installed; recordings
still save and sit as failed with a Retry button, so nothing is lost by recording before setup.

## The view

- **The button.** 76 px red disc; a live halo scaled by the RMS level from an `AnalyserNode` on the
  recording stream. Tap → recording (the disc becomes a stop square, the timer turns red),
  Pause/Resume, tap the square → review: duration, the waveform, a playback control, Discard or
  Save. A screen wake lock is requested while recording (a locked iPhone suspends the tab and
  the recording with it), and leaving the page mid-recording asks first.
- **The waveform** (`web/src/journal/Waveform.tsx`) answers one question: *is it hearing me?* A
  21-minute entry that turns out to be silence is 21 minutes you cannot get back. Rounded bars on a
  canvas, one per 50 ms of audio (`SAMPLE_MS`), peak-per-bucket so a single loud moment in a quiet
  stretch survives the squash. While recording it **pads**: bars arrive at the right edge and march
  left, so the newest moment is always in the same place. In review it **stretches** the whole
  take across the full width, in blue, so a flatline in the middle is visible *before* Save.
  It is a canvas rather than wavesurfer.js because ~50 kB on an already 1.5 MB bundle is a poor
  trade for sixty lines against an `AnalyserNode` that is already wired up. The level and the
  sample history are **refs, not state**: the loop reads them inside its own `requestAnimationFrame`
  and writes `--level` straight onto the stage element, so a moving waveform costs zero React
  renders. Pushing the level through `useState` re-rendered every card and every countdown sixty
  times a second.
- **Type an entry instead** under the button — no microphone, no whisper, the same digest.
- **Cards**, grouped Today / Yesterday / weekday-and-date, newest first: time, length, an audio
  chip counting down the days left (`audio 14d`, or `audio kept` when pinned, or `audio deleted`),
  the state chip, the title (his, else the agent's, else the opening sentence; pencil to rename), an
  excerpt, and after the digest: the summary and chips for memory updates, habits logged, and
  "N in Inbox" (a link). "Show transcript" opens the paragraphs, a player for the recording while it
  is still kept, "Fix the transcript" (editing drops the timestamps, which no longer line up) and
  "What the digest said" (the agent's reply). The player fetches the bytes through the authed API
  and holds them as an object URL — an `<audio src>` cannot send a bearer header.
- **One ⋯ menu per card**, and only one permanent button beside it. Everything state-dependent
  lives in the menu: *Digest now* / *Digest again* / *Retry*, *Rename*, *Keep the recording* /
  *Delete the recording*, *Delete entry*. The exception is **Don't ingest**, which stays a real
  button while the countdown runs — it is the one action here with a deadline, and burying a
  time-boxed decision behind a menu is how you miss it. A permanent Delete sitting next to a
  permanent Again was the action wanted least often in the spot easiest to hit by accident, which
  is the same reasoning `GoalCard` already follows.
- **Polling** is driven by `pollIntervalMs`: 4 s while something is transcribing or digesting,
  20 s during a countdown, 90 s otherwise, plus a reload on tab focus. The countdown itself ticks
  client-side once a second.

## Gotchas

- **Recording needs a secure context.** `getUserMedia` is unavailable on plain `http://` except
  `localhost`. The dashboard is already reached over HTTPS (Web Push needs it too), but a bare
  Tailscale IP will show the "can't record here" notice — type instead, or use the HTTPS name.
- **Safari records `audio/mp4`, Chrome `audio/webm`.** `pickMimeType` tries MP4 first; ffmpeg reads
  both. Don't pass a `timeslice` to `MediaRecorder.start()` — Safari's fragmented MP4 chunks are not
  always concatenable, and one Blob on stop is a file every decoder agrees on.
- **iOS suspends a backgrounded tab.** A locked phone or a switch to another app can end the
  recording. The wake lock keeps the screen on while recording; there is no fix for switching apps.
- **The bridge restarting mid-transcription** leaves entries saying "transcribing". `recover()`
  runs at boot: audio still on disk → re-queued; gone → marked failed with a reason.
- **The whisper binary is not portable.** It is built with `GGML_NATIVE=ON` for this CPU. A new box
  runs the install script again; that is the whole point of it being a script.
- **Node 22 vs 24.** The service pins Node 24; the shell has 22. Both run the module (nothing here
  needs anything newer than 20), but `npm install` at the root after pulling is now required for
  `ffmpeg-static`, same as `node-pty` and `ws`.
- **The digest has its own timeout, and it is not `AGENT_TIMEOUT_MS`.** That one is three minutes,
  sized for a phone request someone is standing there waiting for. The first real entry — 21
  minutes of audio, a 19k-character transcript — was SIGKILLed at exactly 180 s, every time.
  Worse, **cursor answers a killed run with prose** ("Agent finished without a final response."),
  not an error, so the entry went green and said "Digested" having filed nothing at all. Two things
  now prevent that: `JOURNAL_INGEST_TIMEOUT_MS` (default 30 min) is passed per-run through
  `runAgent` → the backend → the spawn, and `ingestFailure()` in `journal/text.mjs` treats every
  known non-answer as a failed digest with a Retry button and a push. If you add a caller whose job
  is genuinely long, pass `timeoutMs`; do not raise the global.
- **A re-digest does not undo the first one.** "Again" re-runs the skill, which is told not to
  duplicate facts already present; the brain page is not rewritten. If the first run filed
  something wrong, fix the brain, not the button.
