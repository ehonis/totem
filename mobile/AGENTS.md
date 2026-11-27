# AGENTS.md — Totem for iPhone

The native client for the Totem bridge. It recreates the web dashboard's **phone** layout
(`../web`, served by `../bridge.mjs`) one to one, and uses native mechanics where a phone
has them: the push drawer follows your finger, detail views are page sheets, "…" menus are system menus,
lists swipe, and toggles and completions give haptic feedback.

## Expo has changed — do not trust memory

This is Expo SDK 57 (React Native 0.86, expo-router). Before touching an Expo API, read the versioned docs:
append `.md` to any docs.expo.dev URL, starting from https://docs.expo.dev/llms.txt.
Use `npx expo install <pkg>` for dependencies so versions match the SDK.

## How it fits together

- `src/lib/` holds the web's logic, ported nearly verbatim at the **same relative paths** as
  `web/src/`: `api.ts` (every bridge call, same names), `chat/store.ts` (threads, SSE streaming, outbox,
  resume, steer), `todos/`, `goals/`, `journal/`, `settings.ts`, `toast.ts`. When the web changes one of
  these, port the change the same way. Only fix what React Native needs (no `window`, `document`,
  `navigator`; no `Blob` object URLs).
- `localStorage` is real: `src/lib/boot.ts` installs expo-sqlite's synchronous localStorage before
  anything else loads, so the ported code's caches and outbox persist unchanged.
- `src/lib/connection.ts` holds the bridge base URL and the secret. The secret lives in the keychain
  (expo-secure-store), never in localStorage. Every request goes through `bridgeFetch`/`bridgeUrl`.
- Every GET in `api.ts` goes through the on-disk cache (`src/lib/httpCache.ts`, its own SQLite file via
  `httpCacheStorage.ts`, memory only in the web preview). An answer is kept only when the bridge tagged it
  with an ETag (`http/etag.mjs`'s allow list), keyed by bridge URL, a hash of the secret, and path; 200
  entries at most, the least recently used evicted first. Each GET sends `If-None-Match`. A 304 answers the
  stored body (its new savedAt reaches the disk at most every ten minutes). So does anything that is not the
  bridge's answer: a network failure, no answer within 8 s, a 502/503/504, a Cloudflare Access response, or a
  200 that is not JSON (a captive Wi-Fi page). React Native's `fetch` resolves only once the whole body is
  in, so the 8 s covers the download too. A caller that holds something newer than the disk passes
  `{ stored: false }`: the stored body still answers a 304, the 8 s deadline is off (its own `deadlineMs`,
  45 s for the list, fails instead), and a failure throws as if nothing were stored. The chat list (`getThreadSummaries`) does: its stored copy is older than the
  store's own, and answering it once dropped every chat begun since it was saved, from the drawer and its
  folders, until a list came through. The projects list (`listProjects`) does too, for the same reason, but its
  stored copy is what the store starts from (`lib/chat/projectList.ts`, `seed()` in `initChat`), so the drawer's
  projects and folders, and the chats filed in them, are there on a cold start before a weak connection answers.
  A list asked for before the phone's own change to a project (made, renamed, deleted: `takeChange`) is dropped,
  and one that is not a list (a captive page) keeps what the store has. A chat's latest window
  (`getThreadPage` without `before`) does too, 45 s: a window with sub-agents runs to hundreds of KB, missed
  the 8 s on a phone connection every time, and each read answered the copy stored when the chat was opened
  mid-reply, so a finished reply showed its sub-agents "running" for hours. The store paints the stored
  window itself (`peekThreadPage`) only when it holds none, and `mergeSummary` keeps an opened chat stale
  (it keeps its own `updatedAt` and count, and a reply it holds `streaming` that the summary shows finished counts too) until a window is actually taken.
  Every caller gets its own parsed copy. Screens draw the stored
  body first through the `peek*` twins beside the getters (`peekTodos`, `peekHabits`, …; Overview and the
  todos, habits, lists and goals stores), then revalidate. While any screen shows a stored answer, the top bar
  (`Screen.tsx`) says "Offline · updated 5m ago"; the web has no such line. It goes once a call that began
  after the failure gets the bridge's own answer (a fresh GET of that path, or any write answered with JSON;
  not a captive or Access page). A 304 that lands after a newer answer leaves the newer one in place. Signing out or switching
  bridge or secret empties the cache (`subscribeConnection` in `api.ts`): disk writes run in one queue, so the
  clear lands after any write already under way, and a GET still out then rejects with `AccountChangedError`
  (named `AbortError`) rather than answering for the old account; screens and stores drop it silently
  (`isAccountChanged` in `api.ts`). Its tests run under the bridge's `npm test`
  (`src/lib/httpCache.test.mjs`): keep `httpCache.ts` free of React Native imports.
- The chat list is pulled one at a time (`syncThreads` is `oneAtATime(pullThreads)`): a call while one is out
  waits, then one more pull runs for every caller in between, so slow downloads queue rather than throw each
  other's answers away. A chat this device followed a run in stays when a list asked for before that run
  ended leaves it out (`runLeft`); a later list is the word.
- Chats load as the web's do (docs/chat.md → Loading chats): the drawer from summaries, a chat's
  latest window on opening (`loadThread` in `lib/chat/store.ts`, drawn first from the stored answer via
  `peekThreadPage`), "Load earlier messages" as the list's header, and the scroll position per chat
  (`lib/chat/scrollMemory.ts`, `ChatFrame`'s `openAt`/`onPosition`). `lib/chat/history.ts` is the
  web's file byte for byte (`features/chat/history.shared.test.mjs`): change it on the web and copy it.
  A chat stream silent past 50 s is dropped and re-attached (`lib/chat/api.ts`). The Overview's
  Recent chats (`features/overview/RecentChats.tsx`, `lib/chat/recents.ts`) puts chats with a composer
  draft first, then the ones opened (`totem.chat.opened.v1`) or answered last.
- Saved drafts are the web's (docs/chat.md → Drafts → On the iPhone): `lib/chat/drafts.ts`, `draftsShared.ts` and
  `refs.ts` are the web's files byte for byte (`features/chat/drafts.shared.test.mjs`): change the logic on the web
  and copy it. `lib/chat/draftsApp.ts` is the app's storage (a record per bridge, saved as the app leaves the
  foreground; tested by `draftsApp.test.mjs`), one store in `features/chat/appDrafts.ts`, the chat screen's draft in
  `features/chat/useChatDrafts.ts`, the drawer's rows in `features/chat/ChatsNavDrafts.tsx`. A new way to write a
  draft goes through that store, never localStorage. `lib/chat/storeDrafts.test.mjs` runs the real chat store in
  node behind loader hooks that stand in for React Native and the bridge calls.
- The approval code (`src/lib/approvalCode.ts`, ported from `web/src/approvalCode.ts`) is kept in the
  keychain beside the secret and sent by `api()` as `x-totem-approval-code`, on the approval routes
  only. The app signs in with the bridge secret, and the bridge refuses that alone on every approval
  route, so **approving anything from the phone needs the code**, even on an install that still
  approves from the web's signed-in session. Settings → Security sets one (with the password) or takes
  one set elsewhere; the Inbox shows a banner when this phone cannot approve. It is stored with the base
  URL it was entered for and dropped when the app connects to another server; signing out forgets it.
  An accept sends back the inbox item's `digest`, so a proposal that changed since it was listed is refused.
  The approval card in a chat (`features/chat/InboxCardRow.tsx`, the web's twin; `docs/chat.md` → Approval
  cards) accepts the same way, through the same `resolveInboxItem`, with the owner's optional note.
- `src/theme.ts` holds the web's CSS variables (`--bg` → `colors.bg`). `src/ui/` holds the building blocks:
  `T` (text), and `kit.tsx` with Btn, IconBtn, Card, Chip, Segmented, Input, Toggle and Empty. `menu.ts` has native
  menus/confirms, `haptics.ts` has haptics, `Markdown.tsx` renders markdown, `BridgeWebView.tsx` shows a bridge page
  in a locked-down WebView (Gotchas), and `ToastHost` reads the same toast store
  but draws errors only (a deliberate difference from the web: success and info toasts, Undo included, are dropped as
  they arrive, a success keeping its haptic; anything that needs the owner to act, like Access asking to sign in
  again, is pushed as an error). The inline Undo line (`features/todos/detail/bits.tsx` `UndoLine`) closes
  after 8 s, except while a screen reader runs: then VoiceOver is moved onto it, it stays two minutes unless
  replaced or dismissed with the escape gesture, and the magic tap runs its Undo.
- The keyboard goes down as the drawer starts to open, by swipe or Menu, in one place: `DrawerContent` in
  `(app)/_layout.tsx` watches the drawer's progress (`useDrawerProgress`) and calls `KeyboardController.dismiss()`
  on the step `shell/drawerKeyboard.ts` names. The composer rides the keyboard over the drawer, so a keyboard left up
  covered half of it. KeyboardController resigns whatever holds the keyboard, not only the input React Native's focus
  tracker knows, which is all `Keyboard.dismiss()` blurs. A new way to open the drawer needs nothing more.
- `src/shell/` is the frame: `AppDrawer` (the sidebar, the whole screen wide, with a close button in its head: Search,
  which opens the Search page, by the wordmark; Overview (a dot while a totem's report waits, as on the Overview's
  Totems tile), the Productivity tools as a
  4 + 3 grid the heading's chevron folds away, remembered per device, then the chats, all in one scroll; a foot floating
  over the scroll's end with the list's Snoozed and Settled buttons, which open `features/chat/ShelfSheet.tsx`, and New
  chat and Settings on the right; no Totems row: totems' chats are not in the list, and the Totems page opens from the
  Overview's app row), `Screen` (top bar with the AI usage pill on the right, where the web phone bar has new chat; plus
  the corner new-chat button; voice mode starts from the home-screen quick action, not a corner button), `nav.ts` (`navigateTo` takes the
  web's tab/app ids, `openChat`, `newChat`, `startVoice`), `routes.ts` (where each id lands, pure and
  tested by `routes.test.mjs`), `ToolIcon` (each tool's mark), `quickActions.ts` (home-screen long-press).
- `src/app/` holds routes only. `(app)/` is the drawer with one screen per web tab. Pushed screens and sheets
  are files directly under `src/app/` and set their own presentation with `<Stack.Screen options>`.
- `src/features/<area>/` holds the screens. **Each Productivity tool is its own drawer page** at the web's
  path (`(app)/productivity/todos.tsx` is `/productivity/todos`, and so on for calendar, habits, goals,
  lists, recs, journal): `ToolPage` in `features/productivity/ProductivityScreen.tsx` gives it a `Screen`
  titled with the tool's name (`TOOL_LABELS`: Tasks, not Todos; the ids stay the web's) and its own glow,
  and mounts the tool's `features/productivity/<Tool>View.tsx` with `active` = the page is focused
  (`useIsFocused`, so it is false under a pushed sheet too, and a tool that reloads on becoming active
  revalidates when its sheet closes; the old pager kept it true). They are drawer screens, not a stack over
  the hub, because a drawer keeps a visited page mounted: switching back is instant and keeps scroll, drafts
  and a recording in progress, and the left-edge swipe always opens the drawer. A mounted page's glow
  holds still while it is out of view. `/productivity` itself is the hub, one tile per tool with a number
  (`glance.ts`, Overview's rules) read from the tool's own store once its page has loaded, else from the
  GET cache, and never from a bridge call of its own; a cached answer from an earlier day or week shows no
  number. It forwards the old pager's `/productivity?app=<id>` to that page.
  `navigateTo('todos')`, `{ tab: 'productivity', app }`, notification links (`destination.ts`) and the
  landing-tab preference all go through `routes.ts`.

- **Liquid glass** (`src/ui/glass.tsx`, `expo-glass-effect`, already in the build): the drawer's foot, the corner
  new-chat button, the composer and the shelf sheet. `GlassButton` is a pressable glass shape with a solid `fallback`
  for iOS before 26, and `GlassGroup` (a `GlassContainer`) melts shapes within `spacing` into one, so neighbouring
  buttons read as one piece; keep a row of floating buttons in one group. A sheet is glass when its route uses
  `glassSheet` in `src/app/_layout.tsx` (a formSheet over a clear screen, which iOS 26 draws in glass) and its content
  is clear too; rows on it pass `glass` to `ThreadItem`, which is clear at rest and takes its solid fill the
  frame it starts to move (its swipe progress copied on the UI thread), so the actions never show through its text.
- **Over-the-air updates arrive without a cold start** (`shell/otaUpdates.tsx`, rules in `shell/otaPolicy.ts`):
  expo-updates on its own checks only at launch and applies at the next launch, and iOS keeps the app suspended for
  days, so a merge once seemed not to reach the phone. Coming back to the foreground checks (at most every 10 minutes)
  and fetches an update or a rollback; a fetched one is applied on a return after 30 minutes away, only on the
  Overview or an open chat (`safePage`: the pages whose every input saves as it changes or holds the reload; any other
  page, sheet or editor may keep edits only in memory), with no input focused (a chat excepted: its drafts are flushed
  just before, `onBeforeReload`), and only if nothing lands in the 1.5 s after (a
  tapped notification, a quick action calling `noteArrival`, a link that moves the page or chat). Before reloading it
  notes the page and chat, and the next launch goes back there (`resumedFromUpdate`) and skips the quick action the
  app was first cold-launched from, which the native module never clears. Anything else a reload would lose takes
  `holdReload()` while it lasts (voice mode, dictation, a journal take or typed entry, the Overview's ask box, a queued
  message or sent message being edited, an inbox card's note, unsent answers to an agent's questions, an edited
  LinkedIn draft); a chat not started yet is never reloaded under. An input added to the Overview or the chat screen
  that keeps unsent words only in React state takes a hold too; widening `safePage` needs the same audit of that page. A build from
  before this code needs two cold starts once to pick it up.
- **The drawer's chats** (`features/chat/ChatsNav.tsx`, docs/chat.md → The chats panel): the web chats panel, T3 Code's
  flat list. Every chat in every project and folder on one list (unsent drafts, Pinned, the chats still in play latest
  first, then Working), each a card with its place, its status in words and its linked task (`features/work/TaskBadge.tsx`,
  a tap opens the task's page); Snoozed and Settled are the foot's buttons, which open `ShelfSheet.tsx` on one shelf for
  the whole scope. The shelves and scope are `lib/chat/sidebar.ts`, the web's file byte for byte
  (`features/chat/history.shared.test.mjs`, with `settle.ts`). The scope button (All chats, Home, a project or folder;
  a native menu, so folders are indented rows, never a submenu) is kept per device in `features/chat/chatsScope.ts`
  under the web's key, and New chat (`shell/nav.ts` `newChat`) starts in the scoped project, else at Home. A chat whose
  linked task is done settles once read, as T3 settles a merged PR (`settle.ts` `taskDoneSince`, from the bridge's
  `taskDoneAt`); every task status call in `lib/api.ts` goes through `toldTasks`, which makes the chat store read the
  list again (`onTaskStatus` in `initChat`), so a new call that finishes or reopens a task goes through it too.
  Recent / By task at the top (`features/chat/chatsOrder.ts`, By task by default) is the web's order:
  `lib/tasksnav/lists.ts` is the web's `tasksnav/lists.ts` byte for byte (`features/work/shared.test.mjs`), and
  `features/chat/TaskRows.tsx` draws a task's group and the next tasks (ring = Done, tap = new chat for it, swipe
  right = Done, swipe left = Snooze and Open, long-press = all four; `snoozeTask` in `features/work/state.ts`).
- **Tasks and chats** (`src/features/work/`): the task store the Tasks page uses (`features/work/state.ts` derives the
  WorkTasks, it keeps no copy; `lib/work/groups.ts` is the web's `work/groups.ts` byte for byte,
  `features/work/shared.test.mjs`). A task opens its page (`todo/[id]`), whose Chats section is the web card's;
  a chat's task strip and Link to task… sheet (`chat/task`) link chats to tasks through `linkTask`/`startTaskDraft`
  in `lib/chat/store.ts`. The drawer's Undo line is docked in its foot (`undoDock.tsx`).
- **Sub-habits**: `lib/habits/groups.ts` is the web's file byte for byte
  (`lib/habits/groups.test.mjs`). A habit with sub-habits is a group: every view reads the payload through
  `foldGroups` (a group becomes a daily habit counting its sub-habits done) and lists rows with `habitTree`, so a group
  is one row in every count (the Habits page's Today bar, `rowsProgress`; the Overview; the hub tile, `glance.ts`). Its
  card holds its sub-habits' rows (`features/habits/HabitRow.tsx` `group`/`nested`), its check (`GroupCheck`) logs
  `complete` and its undo line sends `groupToggle(...).undo`; its streaks count whole days (`wholeDays`), and a day
  picked in its grid steps the page to that day. The form's "Part of" files a habit under one; `/habit/new?parentId=`
  starts one there. The morning check-in asks a group's sub-habits, never the group.
- **CLIProxy** (`src/features/cliproxy/`, docs/cliproxy.md → On the iPhone): the web's `/cliproxy` page as a drawer page, reached
  from the Overview's app row and the usage sheet's "Forecast and logins", both only once the bridge has a proxy set up
  (`useCliproxyConfigured`). The graphs first, then each login's windows; **read only**: every change to a login is an
  approval route the app does not send, so the foot opens the dashboard. The pool model, the chart's layout and the cards'
  figures are the web's files byte for byte (`lib/cliproxy/pool/`, `lib/usagePools.ts`; `features/cliproxy/shared.test.mjs`):
  change them on the web and copy them. `PoolChart.tsx` draws that layout with react-native-svg. In the page a press-and-hold
  then drag walks the crosshair (so a swipe still scrolls; the page stops scrolling while a finger works a chart), a tap reads
  a moment, two fingers pinch and slide (`chartGestures.ts`), a double tap shows the whole range. Each card's corner button
  opens `LandscapeGraphs.tsx`: the chart a quarter turn round, full screen, where a drag walks the crosshair at once. The app is
  portrait-only, so nothing native rotates: the view is drawn turned and the owner turns the phone (which way is a button,
  kept per phone), so it ships over the air and no other screen can end up sideways. History is read on focus and every five
  minutes in view (the web: two), gzipped by the bridge.
- **Settings** (`src/features/settings/`) is the web's sections in its groups and order (`lib/components/settings/sections.ts`
  and `searchIndex.ts` are byte-for-byte copies of the web's), drawn as iOS grouped lists from `features/settings/ui.tsx`
  (`Section`, `Row`, `Switch`, `Picker`, `Field`, `Notice`): a row keeps the web's id, so a search hit or a
  `/settings/<pane>#<row>` link (`paneRoutes.ts`, which also sends retired panes where they went: AI → Providers,
  Integrations → General, Jobs → Totems) scrolls to it. Keyboard is left out (leader keys need a physical keyboard), and
  so are Voice's Reading aloud (the app has no read-aloud) and Appearance's Compact density (no screen has a denser
  layout); `search.ts` lists them. Notification history follows Notifications. Detail screens are routed from
  `app/settings/*` and live under `features/settings/` (an account, a skill, a connection, Edit tracking, the log sheet).
  A screen with unsaved edits asks before Back or the edge swipe drops them (`useDiscardGuard`). Appearance › Background is
  read once at launch by `theme.ts` (StyleSheets are built at import), so a new palette restarts the app (the native splash keeps Original's colour until a new build); the app starts on
  Original where the web starts on True black, so an update repaints no phone. `paneRoutes.test.mjs` checks that every
  search id the app keeps is drawn by its pane, and that the ported files still match the web's.

## Rules

- **The web is the spec.** Same sections, copy, order, colours and states as the web's phone layout
  (`@media (max-width: 720px)`). A difference must be deliberate and native (a sheet, a swipe, a system
  menu), not drift.
- **Except Productivity, where the phone leads its own UX** (epic #176). The tools there (Tasks, Calendar,
  Habits, Goals, Lists, Recs, Journal) are designed for the phone first: own pages, layouts and gestures
  that need not match the web. What stays shared is the logic ported into `src/lib/**` (`todos/board.ts`, `todos/format.ts` and `todos/parse.ts`,
  byte-for-byte copies of the web's, which `features/todos/` re-exports; `todos/state.ts`,
  `todos/types.ts`, goals, journal, the habit check-in…): new helpers may sit beside it, but an existing
  helper keeps returning what the web's does. The bridge contract does not move either: the same `api.ts`
  calls with the same payloads, and nothing that deletes, completes or snoozes loses its undo or its way
  back (recycle bin, snoozed, archive).
- **Never hand-draw an icon.** Heroicons via `src/lib/icons.tsx` (the web's names), Tabler via deep
  per-icon imports (`@tabler/icons-react-native/dist/esm/icons/IconX.mjs`, default export). A page's own glyph
  (the drawer's Overview, Search and Settings, the Overview's app row) comes from `src/lib/navIcons.tsx`,
  the web rail's Lucide table (`web/src/navIcons.tsx`); change both together. Brand art is
  rendered to PNG from the web's SVGs by `scripts/build-logo-assets.mjs` (the app icon, splash and
  `assets/images/`); never edit those PNGs by hand.
- **Keep the bridge contract aligned with `bridge.mjs`.** The app has no API of its own.
- Scrolling screens pad their foot by `FAB_CLEARANCE` so the floating buttons never cover the last row.

## Running, building, shipping

```sh
cd mobile && npm install                      # its own install; app.local.json first (README)
npx tsc --noEmit                                   # typecheck
node --test src/shell/*.test.mjs src/features/*/*.test.mjs src/features/*/*/*.test.mjs  # pure logic outside src/lib (also in the root npm test)
npx expo export --platform ios --output-dir /tmp/x # proves the JS bundles
npm run start:tailscale                            # Metro on the Tailscale IP, for the dev client
```

- **Dev client:** `npx eas-cli build -p ios --profile development`, install it on the phone, then
  `npm run start:tailscale`. Rebuild it whenever a native module is added or `app.json` plugins change.
- **TestFlight:** `npx eas-cli build -p ios --profile production --auto-submit` (build number auto-increments).
- **Over-the-air:** `npx eas-cli update --channel production -m "…"` ships JS-only changes to installed
  TestFlight builds. `runtimeVersion` uses the fingerprint policy, so an update only reaches binaries
  whose native code matches. If native code changed, build again instead.
- The EAS project's slug is `vesper-mobile` (from before the rename). Keep it; the project id is bound to it.
- Web preview (layouts only): `npx expo export --platform web`, served beside a proxy to the bridge
  (it sends no CORS headers). Native-only modules need a Platform guard or a `.web.tsx` fallback.

## Gotchas

- iOS ATS allows plain http (`NSAllowsArbitraryLoads`) because the bridge is usually reached over
  Tailscale at `http://<100.x>:8787`.
- A 401 from the chat store's sync loop signs out (forgets the secret, keeps the address).
- The entry is `index.ts`, not `expo-router/entry`: a silent push launches the bundle headless,
  so the notification background task (`src/shell/pushDismiss.ts`) must be defined before the
  router loads. Keep that import first.
- A locked phone is not a signed-out app. A silent push can start the app in the background
  while the phone is locked, when the keychain refuses every read. A refused read taken as
  "no secret" once showed Connect, and the app stayed there until it was swiped away.
  `loadConnection` reads through `readWhenUnlocked` (`src/lib/readWhenUnlocked.ts`), which waits
  for the app to be opened and reads again. Only after reads keep failing with the app open
  (three tries) does it log, count the refused items as absent and show Connect; never sooner.
- `react-native-nitro-markdown`, `react-native-pager-view`, `@react-native-menu/menu` and `react-native-webview`
  are native-only. They need a dev build; Expo Go cannot run this app.
- **`ui/BridgeWebView.tsx` is the one WebView for bridge pages** (rules in `lib/bridgePage.ts`, tested by
  `lib/bridgePage.test.mjs`; `docs/chat.md` → Charts in replies). Charts in replies use it; so should any screen that
  shows a page the bridge serves. Its one credential, the Access token, is the source's
  header, built once per mount for a bridge target only, so it goes with the first request and nowhere else: never
  attach a header, rebuild the source or reload the view. Keep `incognito`, `originWhitelist={['*']}` (otherwise the
  library hands other schemes to `Linking.openURL` before any guard runs) and every navigation through
  `bridgeNavigation` (the source URL loads once); inject no script, and read no message but the height, which only
  `onHeight` asks for. Never send the bridge secret: pages may be agent-written, and load from a signed URL.
- Building and submitting non-interactively needs the App Store Connect API key in the environment
  (`EXPO_ASC_API_KEY_PATH`, `EXPO_ASC_KEY_ID`, `EXPO_ASC_ISSUER_ID`, `EXPO_APPLE_TEAM_ID`,
  `EXPO_APPLE_TEAM_TYPE`); the owner keeps them outside the repo. Set `EXPO_NO_CAPABILITY_SYNC=1`:
  EAS's capability sync fails on an Apple API error, and Push Notifications is already enabled on the
  bundle id.
- **The install's identity is not in the repo.** The bundle id and the EAS project id live in the gitignored
  `app.local.json`, which `app.config.js` merges into `app.json`. The repo-root `.easignore` uploads only
  `mobile/` to EAS, including that file. Never put an account, bundle id or project id back in a tracked
  file: this directory is published with the rest of Totem.
- `eas.json` is part of the runtime fingerprint. Editing it (even the `submit` block) after a build
  gives later `eas update`s a runtime the installed build doesn't have, and they never arrive. Check
  `npx expo-updates runtimeversion:resolve --platform ios` against the build's runtime before
  publishing; change `eas.json` only alongside a new build. `eas update` needs `--environment production`.
- `mobile/.gitignore` is in the fingerprint too (`bareGitIgnore`), byte for byte, comments included.
  Changing `node_modules/` to `node_modules` there moved the runtime off the installed build's and
  would have stranded every update after it, so ignore rules for the whole repo go in the root
  `.gitignore`, whose patterns already reach `mobile/`.
- The bridge's data changes shape with the web (e.g. a totem watch became `sources: []` in
  totem-private #60; the app still read `source` and crashed). When porting, read the current
  `web/src` on totem-private `main`, not an old checkout, and normalise old shapes the way the web
  does. Every screen sits under an error boundary (`src/shell/ScreenError.tsx`), so a mismatch shows
  an error on that screen instead of closing the app.
- **A link or file in a chat never opens a bridge URL in the in-app browser.** SFSafariViewController
  (expo-web-browser) can't send the bearer or the Cloudflare Access token, so behind Access it showed
  Access's login page unless Safari happened to hold a cookie. Every tapped link goes through
  `lib/links.ts` `classifyLink` (the web's `web/src/links.ts`) and `features/chat/openLink.ts`: a path
  on the box is signed by `/api/chat/files/link` and opened like a file, an `/api/` path is HEADed and
  opened, a dashboard path goes to its app screen (one the app has no screen for, like Dev or Messages,
  still opens in the in-app browser, as a notification's link does), mailto:/tel:/sms: go to
  `Linking.openURL`, and other sites reach the browser. Text files read in `FileSheet`, the rest in `FileViewer`: a picture
  through expo-image, a PDF in the app's one web view (`ui/BridgeWebView.tsx`, by its signed URL), anything else
  as a download for the share sheet. Never load an HTML or SVG file in the web view by URL
  (`webViewSource`): the bridge serves those as downloads without a sandbox, and WebKit would run one as a
  page on the bridge's origin. `Markdown`'s
  `onLinkPress` always returns false: left to `react-native-nitro-markdown`, mailto: and tel: went to
  `Linking.canOpenURL`, which answers false for any scheme Info.plist doesn't declare, and every other
  href it can't parse was dropped, so the tap did nothing. The bearer and the Access token go to the
  bridge's own origin only (`headersFor`; `bridgeFetch` refuses any other), decided by one strict
  `originOf` (links.ts, also used by `destination.ts`): an authority with `\`, `@`, `%`, whitespace or a
  control character is never the bridge, because iOS's RFC 3986 parser and WHATWG URL read those
  differently. `FileViewer` and `FileSheet` take only a `/`-relative bridge path as their `url` param (a
  deep link can reach them). Tested in `lib/links.test.mjs`.
- **A reply's long-press menu is React Native's, not `@react-native-menu/menu`.** That `MenuView` is a
  native UIButton with a context-menu interaction; a reply's links, tables and code sat inside it, and
  its touch tracking swallowed sideways swipes and some link taps. `ReplyMenu` (Message.tsx) is a
  `Pressable` long press that opens the same items as an action sheet. The bubble keeps `MessageMenu`.
- **A sideways scroller inside a touchable needs its content to take the touch.** On iOS a ScrollView
  refuses to start a drag while a view above it is the JS responder (`_shouldDisableScrollInteraction` in
  RN's `RCTScrollViewComponentView`), so `ReplyMenu`'s Pressable stopped every table and code block in a
  reply scrolling sideways. Their content claims the touch itself (`OWN_TOUCHES` in `ui/Markdown.tsx`),
  over the whole content, padding included; that is also why tables are drawn by the app (`MdTable`)
  rather than by `react-native-nitro-markdown`. Any new horizontal ScrollView inside a Pressable needs
  the same.
- **A sheet you read in keeps its header out of the scroller.** In a formSheet, a drag on a scroll view
  only moves the sheet once the scroll view is at its top, so a header inside the scroller (sticky or
  not) left nothing to grab halfway down a document. `FileSheet` and `SearchResultSheet` put the title,
  buttons and Close above a `flex: 1` ScrollView, as `SheetFrame` does.
- **A message's text is selected in a sheet, not in place.** A press on a message opens its menu (the bubble's
  `MessageMenu`, the reply's `ReplyMenu`), and RN's `<Text selectable>` on iOS offers only Copy for the whole
  block, so both menus have **Select text**: `features/chat/selectText.ts` hands the text to
  `SelectTextSheet.tsx` (`/chat/select`), a non-editable multiline `TextInput` (a UITextView: iOS's own
  selection handles, Copy, Look Up). A reply goes through `lib/chat/plainText.ts` first, so it reads as its
  words, not its Markdown. Its tests are `lib/chat/plainText.test.mjs` (the root `npm test` runs
  `mobile/src/lib/*/*.test.mjs` too).
- **A remote push's `content.data` is only its `body` key.** expo-notifications (iOS) builds
  `notification.request.content.data` from the APNs payload's `body` dictionary and ignores every
  other top-level key, so `notify/apns.mjs` puts `url`, `entryId`, `category` and `tag` under `body`.
  With them only at the top level every tap opened the app wherever it was. Read them through
  `pushData()` (`src/shell/pushDismiss.ts`), which falls back to the raw `trigger.payload`.
  A tap's `url` is mapped by the pure `src/features/notifications/destination.ts`.
