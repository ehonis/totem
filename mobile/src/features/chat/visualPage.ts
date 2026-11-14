// Which chart a reply's `visual` part may load in the app (VisualCard.tsx, #260),
// pure so `node --test` runs it. The WebView's rules for any bridge page are in
// lib/bridgePage.ts; a chart narrows them to its signed upload URL, so a forged
// part can load nothing else, not even another bridge page.
import { bridgePageUrl } from '../../lib/bridgePage.ts'

const UPLOAD_PATH = /^\/api\/chat\/uploads\/[A-Za-z0-9_-]{8,64}(?:\?sig=[A-Za-z0-9_-]{1,128})?$/

/** The bridge path to load for a chart part, or null when its URL is not a chart upload on this bridge. */
export function visualPagePath(url: string | undefined, baseUrl: string): string | null {
  if (!url || !UPLOAD_PATH.test(url)) return null
  return bridgePageUrl(url, baseUrl) ? url : null
}
