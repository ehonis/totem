// When the app looks for, and applies, an over-the-air update (otaUpdates.ts). Pure, so
// the rules are tested on their own (otaPolicy.test.mjs).
//
// expo-updates on its own checks only at a cold start and applies what it fetched at the
// next one. iOS keeps a suspended app for days, so a merge could take a week to show up
// ("the phone didn't get today's change"). So the app also checks as it comes back to the
// foreground, and applies a fetched update on a later return after a long absence, but
// only where a reload loses nothing: on the Overview or an open chat, the two pages whose
// every input is saved as it changes or holds the reload (never a sheet, an editor or any
// other page, whose edits may live only in memory), with nothing being typed, and only once
// the return has settled, so a notification or quick action that brought the app back
// keeps its screen. Those two are where he comes back to, so the update still lands.

/** Away at least this long, a fetched update may be applied as he comes back. */
export const APPLY_AFTER_AWAY_MS = 30 * 60_000
/** At most one check for a new update this often. */
export const CHECK_EVERY_MS = 10 * 60_000
/** How long after coming back the app waits for a push or quick action to land. */
export const SETTLE_MS = 1500

/**
 * The Overview or the chat: every input there saves as it changes (the composer's draft, a
 * habit's number on blur) or holds the reload while it has unsent words (holdReload), so a
 * reload, and the resume after it, gives the page back as it was. Anything else may not.
 */
export function safePage(path: string) {
  return path === '/' || path === '/chat'
}

/**
 * Reload into the fetched update on this return? Never while something would be lost:
 * voice or a recording (`held`), a page with an editor on top, or an input being typed in
 * (`typing`), except in a chat, whose composer saves its draft as the app leaves. A chat
 * not started yet (`newChat`) is left alone too, since only the draft text is saved.
 */
export function shouldApply({ pending, awayMs, held, path, typing, newChat = false }: {
  pending: boolean; awayMs: number; held: boolean; path: string; typing: boolean
  /** A chat not started yet is on screen: where it was placed (a project, a task) lives in memory. */
  newChat?: boolean
}) {
  if (!pending || held || awayMs < APPLY_AFTER_AWAY_MS) return false
  if (!safePage(path) || (path === '/chat' && newChat)) return false
  return !typing || path === '/chat'
}

/** Still nothing else moving SETTLE_MS later: the same page and chat, and no push or quick action arrived. */
export function stillSettled({ pathBefore, pathNow, chatBefore, chatNow, arrived }: {
  pathBefore: string; pathNow: string; chatBefore: string | null; chatNow: string | null; arrived: boolean
}) {
  return !arrived && pathBefore === pathNow && chatBefore === chatNow
}

/** Ask the update server again? */
export function shouldCheck({ lastCheckAt, now, busy }: { lastCheckAt: number; now: number; busy: boolean }) {
  return !busy && now - lastCheckAt >= CHECK_EVERY_MS
}
