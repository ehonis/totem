// Reloads an open dashboard after a deploy. A merge rebuilds and restarts the
// server, but a window that stays open (the desktop app, a pinned tab, the Home
// Screen app) keeps running the bundle it loaded days ago and never sees it.
//
// The bridge's /version names the bundle its index.html loads now; this page knows
// the one it is running. When they differ the page reloads, but only when that
// costs nothing: while hidden, or after a quiet spell with no half-typed text.
// Chat runs live on the server and unsent messages sit in the outbox, so a reload
// loses nothing else.

const CHECK_MS = 5 * 60_000
const IDLE_MS = 2 * 60_000

export function runningBuild(doc: Document = document): string | null {
  for (const s of Array.from(doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'))) {
    const m = new URL(s.src, doc.baseURI).pathname.match(/\/assets\/index-[\w-]+\.js$/)
    if (m) return m[0]
  }
  return null
}

// Text the owner has typed and not sent: a reload would throw it away.
export function hasUnsentText(doc: Document = document): boolean {
  for (const el of Array.from(doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('textarea, input[type="text"], input:not([type])'))) {
    if (el.value.trim()) return true
  }
  return Array.from(doc.querySelectorAll<HTMLElement>('[contenteditable="true"]')).some((el) => !!el.textContent?.trim())
}

export function shouldReload(o: { running: string | null; served: string | null; hidden: boolean; idleMs: number; unsentText: boolean }): boolean {
  if (!o.running || !o.served || o.running === o.served) return false
  if (o.hidden) return true
  return o.idleMs >= IDLE_MS && !o.unsentText
}

export function watchForNewBuild(): void {
  const running = runningBuild()
  // The Vite dev server serves /src/main.tsx, not a hashed bundle.
  if (!running) return
  let served: string | null = null
  let lastInput = Date.now()
  let reloading = false

  const decide = () => {
    if (reloading) return
    if (shouldReload({ running, served, hidden: document.visibilityState === 'hidden', idleMs: Date.now() - lastInput, unsentText: hasUnsentText() })) {
      reloading = true
      location.reload()
    }
  }
  const check = async () => {
    try {
      const res = await fetch('/version', { cache: 'no-store' })
      if (res.ok) served = (await res.json()).build || null
    } catch {
      // Offline or mid-restart: try again on the next check.
    }
    decide()
  }

  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, () => { lastInput = Date.now() }, { passive: true, capture: true })
  }
  document.addEventListener('visibilitychange', () => { void check() })
  window.addEventListener('focus', () => { void check() })
  window.setInterval(() => { void check() }, CHECK_MS)
  // Once a new build is known, a quiet minute is enough; no need to wait for the next check.
  window.setInterval(decide, 30_000)
}
