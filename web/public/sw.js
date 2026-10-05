// Totem's service worker. Deliberately tiny.
//
// It caches nothing. Totem is a live dashboard behind an authenticated API, and
// an offline copy of it would be a stale, confusing version of a personal
// assistant — the only thing worse than no offline mode is one that lies. Its
// whole job is to receive pushes, open the right view when one is tapped, and
// recover its subscription when iOS rotates it.
//
// Lives in web/public/ so Vite copies it verbatim to /sw.js. A bundled, hashed
// service worker cannot claim the scope it needs.

// iOS revokes a subscription that receives a push and shows nothing, so every
// path through this handler ends in showNotification — including the ones where
// the payload is missing or unparseable.
self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event))
})

async function handlePush(event) {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    // Not JSON. Fall through to the fallback notification rather than throwing,
    // which would show nothing at all.
  }

  const notification = payload.notification || {}
  const data = payload.data || {}
  // A declarative payload carries `notification`; a service-worker payload carries
  // only `data`. Either way the fields are the same.
  const title = notification.title || data.title || 'Totem'
  const body = notification.body || data.body || ''
  const url = notification.navigate || data.url || '/'

  const badge = Number(data.badge ?? notification.app_badge ?? 0)
  if (self.navigator && 'setAppBadge' in self.navigator) {
    try {
      if (badge > 0) await self.navigator.setAppBadge(badge)
      else await self.navigator.clearAppBadge()
    } catch {
      // Badging is best effort; never let it cost the notification.
    }
  }

  await self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    // Replaces an earlier notification about the same thing instead of stacking
    // two. The server sends the dedupe key as the tag.
    tag: data.tag || data.entryId || undefined,
    data: { url, entryId: data.entryId || null, category: data.category || null },
  })
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  // The entry id rides on the URL so the app can report the open back to the
  // bridge. That single fact is the strongest feedback signal there is, and it
  // costs the user nothing.
  const target = data.entryId
    ? `${data.url || '/'}${(data.url || '/').includes('?') ? '&' : '?'}n=${encodeURIComponent(data.entryId)}`
    : (data.url || '/')

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    // Focus a window that is already open rather than opening a second copy of
    // the app, which on iOS is a jarring way to answer a tap.
    for (const client of clients) {
      if ('focus' in client) {
        await client.focus()
        if ('navigate' in client) {
          try { await client.navigate(target) } catch { /* cross-origin or closing */ }
        }
        return
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target)
  })())
})

// iOS rotates subscriptions on its own schedule. Without this the app goes quiet
// and nothing says why.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const old = event.oldSubscription || null
      let next = event.newSubscription || null
      if (!next) {
        const key = old?.options?.applicationServerKey
        if (!key) return
        next = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        })
      }
      // No bearer token is available in a service worker, so this endpoint accepts
      // a rotation only when it can name the old endpoint it is replacing.
      await fetch('/api/push/rotate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          oldEndpoint: old ? old.endpoint : null,
          subscription: next.toJSON ? next.toJSON() : next,
        }),
      })
    } catch {
      // Nothing useful to do here; Settings will show the device as expired the
      // next time a send fails against it.
    }
  })())
})
