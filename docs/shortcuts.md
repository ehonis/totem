# Keyboard shortcuts — a leader key, and sequences under it

Press <kbd>G</kbd>, let go, then press another key. <kbd>G</kbd> <kbd>T</kbd> opens
Todos; <kbd>G</kbd> <kbd>T</kbd> <kbd>T</kbd> opens Todos *and* pops the new-todo
composer. <kbd>G</kbd> <kbd>?</kbd> lists everything.

The global quick panels use one nested family: <kbd>G</kbd> <kbd>U</kbd> opens
AI usage limits immediately, <kbd>G</kbd> <kbd>U</kbd> <kbd>A</kbd> switches to
Totem activity, and <kbd>G</kbd> <kbd>U</kbd> <kbd>R</kbd> opens repositories.
While AI limits is open, the dashboard holds `GET /api/ai-usage/stream` so bars
move as the poller refreshes (after a Totem turn, and every 15s while someone
is watching). Re-poll is only a force credential refresh.

Nothing is held down. You type the keys one after another, and a grace period
(1.2s by default) decides how long a half-typed sequence stays live — so
<kbd>G</kbd> followed by <kbd>B</kbd> a minute later does nothing at all.

Everything is rebindable in **Settings → Shortcuts**: the leader key, the grace
period, and the sequence behind each action.

## Why it looks like this

A leader key, a panel listing what one more press would do, and plain letters rather
than modifier chords.
The property worth copying is that **you don't have to remember the second half**:
the panel appears the moment the leader lands, so the shortcut system is
discoverable by pressing one key rather than by reading a manual.

Two additions over a plain leader-key scheme:

- **Sub-sequences.** A sequence can extend another one. `t` is Todos, `tt` is "new
  todo on the Todos tab". Muscle memory nests instead of competing for letters.
- **Full customisation.** Every binding is user-owned, including the leader.

## Files

| Thing | Location |
|---|---|
| Action registry, bindings, matcher, command bus | `web/src/shortcuts.ts` |
| Quick-panel commands, defaults, and polling lifecycle | `web/src/quickPanels.ts` |
| The key state machine (`useShortcuts`, `useCommand`) | `web/src/useShortcuts.ts` |
| Hint panel + cheat sheet | `web/src/components/ShortcutOverlay.tsx` |
| Settings editor | `web/src/components/ShortcutsSettings.tsx` |
| Wiring (hook + overlay + terminal command) | `web/src/App.tsx` |

Config lives in the shared `app_settings` localStorage blob under `shortcuts` —
client-side only, per device, like every other entry in `web/src/settings.ts`.

## Actions

Two flavours, and the difference matters for how a sequence resolves:

- **nav** — a route. `onNavigate` is App's own `navigate`, so a shortcut and a
  sidebar click land on exactly the same place, including the "return to the pane
  you left" memory in `router.ts`.
- **command** — a view-level action, broadcast to whichever view claims it with
  `useCommand(COMMANDS.todoNew, …)`.

Adding one is a single entry in `ACTIONS` plus a default in `DEFAULT_BINDINGS`. A
command additionally needs its `useCommand` call in the view that owns it.

## How a sequence resolves

Each key extends a buffer that's matched against the binding table:

| Buffer state | What happens |
|---|---|
| Exact match, nothing longer shares the prefix | Fire it, reset |
| Exact match, **and** a longer sequence shares the prefix | See below |
| No match, but something longer starts with it | Keep waiting |
| No match at all | Reset — unless the key was the leader, which restarts the chord |

The ambiguous row is the interesting one. `t` is both "go to Todos" and the prefix
of `tt`. Navigation actions and reversible quick panels can be marked `chainable`:
they fire **immediately**, then stay armed. Going to Todos on the way to "new todo,"
or opening limits on the way to activity, is what you wanted either way. Anything
with a real side effect is held until the grace period expires, so a longer chord
can still supersede it.

The leader-restarts-on-a-dead-end rule exists because `g t` leaves the chord armed
for the grace period. Without it, changing your mind and pressing `g b` inside
that window would dead-end on `tg` and then drop the `b`.

## Not stealing your keystrokes

The failure mode this feature has to avoid is navigating away while someone types
"**g**o get the groceries" into a composer. `isTypingTarget` (in `useShortcuts.ts`)
excludes:

- `input` (except checkbox/radio/button/range/color/file — nobody types into those),
  `textarea`, `select`, and any `contenteditable` ancestor
- anything under `[data-shortcuts-off]` — which is how `TerminalPanel` keeps its
  keystrokes, since xterm's hidden textarea would otherwise need a tag-name
  special case

Also passed through untouched: any keystroke with Ctrl/Meta/Alt, IME composition,
and <kbd>Esc</kbd> (which cancels an open chord but still reaches whatever dialog
is listening for it). Window blur and any mousedown drop an armed chord.

The rebinding field in Settings is a real `<input>` for exactly this reason — it
inherits the guard, so the shortcut you're rebinding can't fire while you rebind
it.

## Defaults

| | Sequence | | Sequence |
|---|---|---|---|
| Overview | `g o` | Settings · Skills | `g s k` |
| Chat | `g c` | Settings · Connections | `g s n` |
| Todos | `g t` | Settings | `g ,` |
| Calendar | `g a` | Settings · Providers | `g , p` |
| Habits | `g h` | Settings · Shortcuts | `g , s` |
| Code | `g e` | New todo | `g t t` |
| Inbox | `g i` | New chat | `g c c` |
| Logs | `g l` | AI usage limits | `g u` |
| Brain | `g b` | Totem usage | `g u a` |
| Totems | `g s` | Repositories | `g u r` |
| Toggle terminal | `g k` | Show all shortcuts | `g ?` |

Code is `e`, not `g`, so the default set has no sequence whose first key is also
the leader — that would work (press it twice) but it greets a fresh install with a
warning for no reason.

## Gotchas

- **A rebind that duplicates a sequence is allowed, and flagged.** The editor shows
  which actions collide and `bindingIndex` is first-writer-wins, so the winner is
  always the one listed first rather than whatever `Object.entries` felt like.
- **Bindings for actions that no longer exist are dropped on read**, not migrated.
  Renaming an action id orphans its binding and it falls back to the default.
- **The hint panel is hidden under 720px.** Phones have no leader key to press and
  it would cover the bottom nav bar.
- **`chat.new` is claimed even when Chat isn't the visible tab** — `ChatView` stays
  mounted so its conversation survives tab switches. Harmless, because `cc` is
  prefixed by `c`, which navigates to Chat first.
- **A command whose view isn't mounted yet is parked for 1.5s**, not dropped.
  `g t t` fires `todo.new` one keydown after the navigation that mounts `TodosView`,
  which is normally enough — but a slow render shouldn't silently eat the action.
- **`g u` is intentionally a chainable command.** It opens limits immediately
  instead of waiting 1.2 seconds, then leaves the chord armed long enough for `a`
  or `r` to switch to the other quick panels.
