// LinkedIn URLs, made canonical so one post, profile or conversation has one
// spelling: https://www.linkedin.com/<path>/ with no query, hash or tracking
// parameters. A proposal is deduplicated on this form, so a denied post is not
// proposed again under a different `?utm_source=`.

/** Hosts the connector's page loads may reach: LinkedIn and its static CDN. */
export const LINKEDIN_HOSTS = Object.freeze(['linkedin.com', 'licdn.com'])

const KINDS = {
  // A post in the feed, a share, or an article-style post.
  post: /^\/(feed\/update\/urn:li:(activity|share|ugcPost):\d+|posts\/[^/]+)\/$/,
  profile: /^\/in\/[^/]+\/$/,
  conversation: /^\/messaging\/thread\/[^/]+\/$/,
}

export class LinkedinUrlError extends Error {
  constructor(message) { super(message); this.name = 'LinkedinUrlError'; this.status = 400 }
}

/**
 * The canonical form of a LinkedIn URL, or a LinkedinUrlError. `kinds` limits
 * what it may point at (post, profile, conversation); empty means any of them.
 */
export function canonicalLinkedinUrl(raw, { kinds = [] } = {}) {
  const text = String(raw || '').trim()
  if (!text) throw new LinkedinUrlError('A LinkedIn URL is required.')
  if (text.length > 1000) throw new LinkedinUrlError('That URL is too long to be a LinkedIn link.')
  let u
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`) } catch { throw new LinkedinUrlError(`Not a URL: ${text.slice(0, 120)}`) }
  const host = u.hostname.toLowerCase()
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new LinkedinUrlError('Only https LinkedIn links are accepted.')
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) throw new LinkedinUrlError(`Not a LinkedIn link: ${host}`)
  let path
  try { path = decodeURIComponent(u.pathname) } catch { path = u.pathname }
  path = path.replace(/\/{2,}/g, '/')
  if (!path.endsWith('/')) path += '/'
  const kind = Object.entries(KINDS).find(([, re]) => re.test(path))?.[0] || null
  const allowed = kinds.length ? kinds : Object.keys(KINDS)
  if (!kind || !allowed.includes(kind)) {
    const want = allowed.map((k) => ({ post: 'a post (/feed/update/urn:li:activity:… or /posts/…)', profile: 'a profile (/in/…)', conversation: 'a conversation (/messaging/thread/…)' }[k])).join(' or ')
    throw new LinkedinUrlError(`That link must be ${want}, not ${path}.`)
  }
  // encodeURI keeps the urn's colons and a slug's letters readable, and escapes anything odd.
  return { url: `https://www.linkedin.com${encodeURI(path)}`, kind }
}
