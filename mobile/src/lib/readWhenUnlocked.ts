// Reading the keychain at launch without mistaking a locked phone for a signed-out one.
//
// iOS starts the app in the background for a silent push (the bridge sends one to
// take a read chat's notification off the phone). If the phone is locked then,
// the keychain refuses the read (errSecInteractionNotAllowed) and
// expo-secure-store throws. Read as "no secret", that showed Connect, and the
// process stayed alive on it until the owner swiped the app away.
//
// So a failed read is retried: in the background it waits until the app is
// active (opened, so unlocked), and in the foreground it tries a few times before
// giving up. A read counts as a foreground failure only if the app was active
// both when it started and when it failed, so a phone locked mid-read waits too.
// A missing item is not a failure: `read` returns it as empty.

export interface AppActivity {
  /** True while the app is in the foreground. */
  isActive(): boolean
  /** Settles the next time the app is in the foreground (at once if it is now). */
  untilActive(): Promise<void>
  delay(ms: number): Promise<void>
}

export type ReadOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

/**
 * Run `read` until it succeeds. A failure in the background (at the start or the
 * end of the read) waits for the foreground and does not count; `foregroundTries`
 * failures in the foreground give up and return the last error.
 */
export async function readWhenUnlocked<T>(
  read: () => Promise<T>,
  app: AppActivity,
  { foregroundTries = 3, retryMs = 400 }: { foregroundTries?: number; retryMs?: number } = {},
): Promise<ReadOutcome<T>> {
  let failures = 0
  for (;;) {
    const activeAtStart = app.isActive()
    try {
      return { ok: true, value: await read() }
    } catch (error) {
      if (!activeAtStart || !app.isActive()) {
        await app.untilActive()
        continue
      }
      failures += 1
      if (failures >= foregroundTries) return { ok: false, error }
      await app.delay(retryMs)
    }
  }
}
