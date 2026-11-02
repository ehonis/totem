// The app's GET cache (#159): every bridge response that came with an ETag is
// kept in memory and on disk, keyed by account and path. A screen draws the
// stored body at once (peek), and every GET asks the bridge with If-None-Match,
// so an unchanged answer is a bodiless 304. When the bridge cannot be reached,
// the stored body is answered instead and `status` says the app is offline and
// since when its data dates.
//
// The bridge decides what may be kept: it tags only its allow-listed read routes
// (http/etag.mjs), and a response without an ETag is never written here.
//
// Nothing here imports React Native, so node's test runner can load it; api.ts
// gives it the storage and the request.

export interface CacheStorage {
  getItemSync(key: string): string | null
  setItemAsync(key: string, value: string): Promise<void>
  removeItemAsync(key: string): Promise<unknown>
  clearAsync(): Promise<unknown>
}

// The body is held as JSON text, so every caller parses its own copy and a
// caller's sort() cannot change what the next one is given. `storedAt` is the
// savedAt the disk has.
interface Entry { etag: string; text: string; savedAt: number; storedAt: number }

export interface CacheStatus {
  /** A GET could not reach the bridge and a screen shows its stored answer. */
  offline: boolean
  /** When the oldest stored answer on show last came from the bridge. */
  updatedAt: number | null
}

/** A GET whose account signed out or switched while it was out: its answer is not for this screen. */
export class AccountChangedError extends Error {
  constructor() {
    super('The account changed while this request was out.')
    this.name = 'AbortError'
  }
}

// A proxy in front of a stopped bridge (Cloudflare, Tailscale Serve) answers these.
const UNREACHABLE = new Set([502, 503, 504])
// The keys on disk, least recently used first, so the oldest go when it is full.
const INDEX_KEY = '#index'
const isJson = (r: Response) => /\bjson\b/i.test(r.headers.get('content-type') || '')

export interface CacheOptions {
  now?: () => number
  /** A cached GET waits this long before the stored copy answers instead (iOS gives up after ~60 s). */
  timeoutMs?: number
  maxEntries?: number
  /** A 304 only moves savedAt; the disk copy is rewritten for it this rarely. */
  persistEveryMs?: number
  /** A response that is the network's, not the bridge's (a Cloudflare Access login). */
  blocked?: (r: Response) => boolean
}

export function createHttpCache(storage: CacheStorage, {
  now = Date.now, timeoutMs = 8_000, maxEntries = 200, persistEveryMs = 10 * 60_000, blocked = () => false,
}: CacheOptions = {}) {
  let account = ''
  // Bumped by clear(): a GET begun before it answers nothing.
  let epoch = 0
  const memory = new Map<string, Entry>()
  let index: Map<string, true> | null = null
  // Disk writes run one at a time, in order, so clear() lands after any write started before it.
  let disk: Promise<unknown> = Promise.resolve()

  // Paths answered from the cache, with the savedAt on show and the order they failed in.
  let seq = 0
  const stale = new Map<string, { savedAt: number; at: number }>()
  let status: CacheStatus = { offline: false, updatedAt: null }
  const listeners = new Set<() => void>()
  function publish() {
    const savedAts = [...stale.values()].map((s) => s.savedAt)
    const next = { offline: savedAts.length > 0, updatedAt: savedAts.length ? Math.min(...savedAts) : null }
    if (next.offline === status.offline && next.updatedAt === status.updatedAt) return
    status = next
    for (const fn of listeners) fn()
  }
  // The bridge answered a call begun at `mark`: what went stale before then is
  // live again. A failure while the call was out stays.
  function reached(mark: number, path?: string) {
    for (const [p, s] of stale) if (p === path || s.at < mark) stale.delete(p)
    publish()
  }

  const keyOf = (owner: string, path: string) => `${owner}|${path}`
  function keys() {
    if (!index) {
      index = new Map()
      try { for (const k of JSON.parse(storage.getItemSync(INDEX_KEY) || '[]')) index.set(k, true) } catch { /* rebuilt as it fills */ }
    }
    return index
  }
  function touch(key: string) { const idx = keys(); idx.delete(key); idx.set(key, true) }

  function read(path: string): Entry | null {
    if (!account) return null
    const key = keyOf(account, path)
    if (!keys().has(key)) return null
    let entry = memory.get(key)
    if (!entry) {
      try {
        const raw = JSON.parse(storage.getItemSync(key) || 'null')
        if (raw) entry = { etag: raw.etag, text: raw.text, savedAt: raw.savedAt, storedAt: raw.savedAt }
      } catch { /* unreadable: refetch */ }
      if (!entry) { keys().delete(key); return null }
      memory.set(key, entry)
    }
    touch(key)
    return entry
  }

  function write(owner: string, path: string, entry: Entry | null) {
    if (!owner || owner !== account) return
    const key = keyOf(owner, path)
    const idx = keys()
    if (entry) { memory.set(key, entry); touch(key) } else { memory.delete(key); idx.delete(key) }
    const evicted: string[] = []
    while (idx.size > maxEntries) {
      const oldest = idx.keys().next().value as string
      idx.delete(oldest)
      memory.delete(oldest)
      evicted.push(oldest)
    }
    const value = entry && JSON.stringify({ etag: entry.etag, text: entry.text, savedAt: entry.savedAt })
    const order = JSON.stringify([...idx.keys()])
    disk = disk.then(async () => {
      if (value) await storage.setItemAsync(key, value)
      else await storage.removeItemAsync(key)
      for (const k of evicted) await storage.removeItemAsync(k)
      await storage.setItemAsync(INDEX_KEY, order)
    }).catch(() => {})
  }

  return {
    /** Who the cache is for (bridge + secret); empty when signed out, which keeps nothing. */
    setAccount(next: string) { account = next },

    /** A copy of the stored body for a path, without asking the bridge. */
    peek<T = any>(path: string): T | undefined {
      const entry = read(path)
      return entry ? JSON.parse(entry.text) as T : undefined
    },

    /**
     * A GET through the cache. `send` makes the request with the extra headers
     * and abort signal given; `parse` turns a response into its body or throws
     * its error.
     */
    async get<T>(
      path: string,
      send: (headers: Record<string, string>, signal: AbortSignal) => Promise<Response>,
      parse: (r: Response) => Promise<T>,
    ): Promise<T> {
      const owner = account, began = epoch, mark = ++seq
      const entry = read(path)
      const ours = () => { if (owner !== account || began !== epoch) throw new AccountChangedError() }
      const fromCache = (e: Entry): T => {
        stale.set(path, { savedAt: e.savedAt, at: ++seq })
        publish()
        return JSON.parse(e.text)
      }

      let response: Response
      const abort = new AbortController()
      const timer = entry ? setTimeout(() => abort.abort(), timeoutMs) : null
      try {
        response = await send(entry ? { 'if-none-match': entry.etag } : {}, abort.signal)
      } catch (cause) {
        ours()
        if (entry) return fromCache(entry)
        throw cause
      } finally {
        if (timer) clearTimeout(timer)
      }
      ours()
      // Not the bridge's answer: a stopped bridge behind a proxy, a sign-in or captive page.
      if (entry && (UNREACHABLE.has(response.status) || blocked(response) || (response.status === 200 && !isJson(response)))) {
        return fromCache(entry)
      }
      if (entry && response.status === 304) {
        // A newer answer replaced this entry while the 304 was out: keep that one.
        const current = memory.get(keyOf(owner, path))
        if (current !== entry) { reached(mark, path); return JSON.parse((current ?? entry).text) }
        entry.savedAt = now()
        if (entry.savedAt - entry.storedAt >= persistEveryMs) write(owner, path, { ...entry, storedAt: entry.savedAt })
        reached(mark, path)
        return JSON.parse(entry.text)
      }
      const body = await parse(response)
      ours()
      if (!response.ok || !isJson(response)) return body
      reached(mark, path)
      const etag = response.headers.get('etag')
      const t = now()
      if (etag) write(owner, path, { etag, text: JSON.stringify(body), savedAt: t, storedAt: t })
      // The route stopped tagging (it left the bridge's list): stop keeping it.
      else if (entry) write(owner, path, null)
      return body
    },

    /** A non-GET call about to go out; give the mark and its response to `reached`. */
    begin: () => ++seq,
    /**
     * A call begun at `mark` was answered. Only the bridge's own answer, as a GET
     * would judge it (JSON, not an Access or captive page), proves it is back.
     */
    reached(mark: number, response: Response) {
      if (response.ok && isJson(response) && !blocked(response)) reached(mark)
    },

    /** Forget everything: sign-out, or another bridge or secret. Settles once the disk is empty. */
    clear() {
      epoch++
      memory.clear()
      index = new Map()
      stale.clear()
      publish()
      disk = disk.then(() => storage.clearAsync()).catch(() => {})
      return disk
    },

    getStatus: () => status,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
  }
}

export type HttpCache = ReturnType<typeof createHttpCache>
