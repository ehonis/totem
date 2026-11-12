// One board read that only lands on a board nobody changed while it was out. The
// store bumps a version on every local change (an optimistic tick, a saved task, a
// shelf move); a fetch that saw the version move answers for the board before that
// change, so it is fetched again rather than applied, and the promise the caller
// awaits only settles once a fetch that saw every local change has been applied.
// After `tries` fetches it applies the last one anyway, so a board that keeps
// changing still loads, and tells `apply` it was stale so the caller can read again.
export async function readUntilStable<T>(
  fetch: () => Promise<T>,
  version: () => number,
  apply: (result: T, stale: boolean) => void,
  tries = 3,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const seen = version()
    const result = await fetch()
    const stale = version() !== seen
    if (!stale || attempt >= tries) { apply(result, stale); return }
  }
}
