// The app's waking moments. iOS suspends the app's sockets in the background, so
// requests in flight when it leaves, and the first ones fired as it comes back
// (or starts cold), can fail with "Network request failed" before the network is
// usable again. Those failures are not worth a toast: the next sync succeeds.
import { AppState } from 'react-native'

/** How long after launch or coming back a network failure is treated as waking up. */
const GRACE_MS = 8000

let wokeAt = Date.now()
AppState.addEventListener('change', (s) => { if (s === 'active') wokeAt = Date.now() })

const NETWORK = /network request failed|network connection was lost|could not connect|not connected to the internet|request timed out|failed to fetch|aborted|load failed/i

/** A network failure that only happened because the app was asleep or still waking. */
export function isWakeNetworkError(text: string) {
  if (!NETWORK.test(text)) return false
  return AppState.currentState !== 'active' || Date.now() - wokeAt < GRACE_MS
}
