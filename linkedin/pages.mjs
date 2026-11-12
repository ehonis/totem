// What the connector reads off a LinkedIn page, run inside the page itself.
//
// `extractLinkedinPage` is serialised into the page by Playwright, so it must not
// use anything outside its own body. It reads, never touches: no clicks, no typing,
// no form submission. It favours the page's visible text plus the links worth
// acting on over exact selectors, because LinkedIn renames its classes often and
// a model reading text copes with a redesign where a selector would return nothing.
// Where LinkedIn marks a post with its urn (data-urn / data-id), each post is also
// returned on its own with a link built from that urn.

export const PAGE_URLS = Object.freeze({
  notifications: 'https://www.linkedin.com/notifications/',
  messages: 'https://www.linkedin.com/messaging/',
  feed: 'https://www.linkedin.com/feed/',
})

export function extractLinkedinPage({ mode = 'page', limit = 10, textCap = 12000 } = {}) {
  const clean = (s) => String(s || '').replace(/[ \t ]+/g, ' ').replace(/ *\n[\s]*/g, '\n').trim()
  const root = document.querySelector('main') || document.body
  const full = clean(root ? root.innerText : '')
  const text = full.length > textCap ? `${full.slice(0, textCap)}\n… (${full.length - textCap} more characters)` : full
  const canon = (href) => {
    try {
      const u = new URL(href, location.href)
      if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null
      return `https://www.linkedin.com${u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`}`
    } catch { return null }
  }
  const WANT = /^\/(feed\/update\/urn:li:(activity|share|ugcPost):\d+|posts\/[^/]+|in\/[^/]+|messaging\/thread\/[^/]+|company\/[^/]+|pulse\/[^/]+)\/$/
  const links = []
  const seen = new Set()
  for (const a of (root ? root.querySelectorAll('a[href]') : [])) {
    if (links.length >= 80) break
    const url = canon(a.getAttribute('href'))
    if (!url || seen.has(url) || !WANT.test(new URL(url).pathname)) continue
    seen.add(url)
    links.push({ url, text: clean(a.innerText).split('\n')[0].slice(0, 160) })
  }
  const posts = []
  if (mode === 'feed' || mode === 'notifications' || mode === 'profile') {
    for (const el of document.querySelectorAll('[data-urn^="urn:li:activity:"], [data-id^="urn:li:activity:"]')) {
      if (posts.length >= limit) break
      const urn = el.getAttribute('data-urn') || el.getAttribute('data-id')
      if (!/^urn:li:activity:\d+$/.test(urn || '') || posts.some((p) => p.urn === urn)) continue
      const body = clean(el.innerText)
      const actor = el.querySelector('.update-components-actor__title, .update-components-actor__name, .feed-shared-actor__title')
      posts.push({
        urn,
        url: `https://www.linkedin.com/feed/update/${urn}/`,
        author: clean(actor ? actor.innerText : '').split('\n')[0].slice(0, 120) || body.split('\n')[0].slice(0, 120),
        text: body.slice(0, 1500),
      })
    }
  }
  const conversations = []
  if (mode === 'messages') {
    const urls = new Set()
    for (const a of document.querySelectorAll('a[href*="/messaging/thread/"]')) {
      if (conversations.length >= limit) break
      const url = canon(a.getAttribute('href'))
      if (!url || urls.has(url)) continue
      urls.add(url)
      const item = a.closest('li') || a
      const lines = clean(item.innerText).split('\n').filter(Boolean)
      conversations.push({
        url,
        name: (lines[0] || '').slice(0, 120),
        preview: lines.slice(1).join(' · ').slice(0, 400),
        unread: Boolean(item.querySelector('[class*="unread"], .notification-badge')) || /\bunread\b/i.test(item.className || ''),
      })
    }
  }
  return { text, links, posts, conversations }
}

/** Where LinkedIn sends a browser it does not consider signed in. */
export function signedOutPath(url) {
  try {
    const u = new URL(url)
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return true
    return /^\/(login|authwall|checkpoint|uas\/login|signup|start\/join|m\/login)(\/|$)/.test(u.pathname)
  } catch { return true }
}
