// The request policy of a read-only page load (readPage in manager.mjs). Kept on
// its own so the change flow can protect it (dev/change.mjs PROTECTED_FILES): the
// LinkedIn connector's promise never to act on LinkedIn rests on it.

/**
 * What readPage lets out of its page: only GET and HEAD, only https, only the
 * hosts it was given (a host or any subdomain of one), and no images, media or
 * fonts. Everything else is aborted before it is sent, so a page read this way
 * cannot post, react, mark read or send anything, whatever its own script tries.
 */
export function readOnlyRequestDecision({ method, url, resourceType } = {}, hosts = []) {
  const verb = String(method || '').toUpperCase()
  if (verb !== 'GET' && verb !== 'HEAD') return 'abort'
  let host
  try {
    const u = new URL(String(url || ''))
    if (u.protocol !== 'https:') return 'abort'
    host = u.hostname.toLowerCase()
  } catch { return 'abort' }
  if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) return 'abort'
  if (resourceType === 'image' || resourceType === 'media' || resourceType === 'font') return 'abort'
  return 'continue'
}
