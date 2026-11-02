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
  200 that is not JSON (a captive Wi-Fi page). Every caller gets its own parsed copy. Screens draw the stored
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
- `src/theme.ts` holds the web's CSS variables (`--bg` → `colors.bg`). `src/ui/` holds the building blocks:
  `T` (text), and `kit.tsx` with Btn, IconBtn, Card, Chip, Segmented, Input, Toggle and Empty. `menu.ts` has native
  menus/confirms, `haptics.ts` has haptics, `Markdown.tsx` renders markdown, and `ToastHost` reads the same toast store.
- `src/shell/` is the frame: `AppDrawer` (the sidebar: tabs + chats), `Screen` (top bar + voice/new-chat
  buttons), `nav.ts` (`navigateTo` takes the web's tab/app ids, `openChat`, `newChat`, `startVoice`),
  `quickActions.ts` (home-screen long-press).
- `src/app/` holds routes only. `(app)/` is the drawer with one screen per web tab. Pushed screens and sheets
  are files directly under `src/app/` and set their own presentation with `<Stack.Screen options>`.
- `src/features/<area>/` holds the screens. Productivity is a pager of apps (`features/productivity`), each
  `{ active }`.

## Rules

- **The web is the spec.** Same sections, copy, order, colours and states as the web's phone layout
  (`@media (max-width: 720px)`). A difference must be deliberate and native (a sheet, a swipe, a system
  menu), not drift.
- **Never hand-draw an icon.** Heroicons via `src/lib/icons.tsx` (the web's names), Tabler via deep
  per-icon imports (`@tabler/icons-react-native/dist/esm/icons/IconX.mjs`, default export). Brand art is
  rendered to PNG from the web's SVGs (`assets/images/`).
- **Keep the bridge contract aligned with `bridge.mjs`.** The app has no API of its own.
- Scrolling screens pad their foot by `FAB_CLEARANCE` so the floating buttons never cover the last row.

## Running, building, shipping

```sh
cd mobile && npm install                      # its own install; app.local.json first (README)
npx tsc --noEmit                                   # typecheck
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
- `react-native-nitro-markdown`, `react-native-pager-view` and `@react-native-menu/menu` are native-only.
  They need a dev build; Expo Go cannot run this app.
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
- **A remote push's `content.data` is only its `body` key.** expo-notifications (iOS) builds
  `notification.request.content.data` from the APNs payload's `body` dictionary and ignores every
  other top-level key, so `notify/apns.mjs` puts `url`, `entryId`, `category` and `tag` under `body`.
  With them only at the top level every tap opened the app wherever it was. Read them through
  `pushData()` (`src/shell/pushDismiss.ts`), which falls back to the raw `trigger.payload`.
  A tap's `url` is mapped by the pure `src/features/notifications/destination.ts`.
