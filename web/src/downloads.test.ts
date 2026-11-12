import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDownloads } from './downloads'
import { desktopRevealUrl } from './desktop'

let store: ReturnType<typeof createDownloads>
let saves: { url: string; name: string }[]
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve() }
const file = '/api/chat/files/raw?path=%2Ftmp%2Freport.csv&download=1'
function response(body: BodyInit | ReadableStream, headers: Record<string, string> = {}) {
  return new Response(body, { headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"', ...headers } })
}

beforeEach(() => {
  saves = []
  localStorage.clear()
  delete window.__TOTEM_DESKTOP__
  vi.stubGlobal('showSaveFilePicker', undefined)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { saves.push({ url: this.href, name: this.download }) })
  vi.stubGlobal('URL', URL)
  URL.createObjectURL = vi.fn(() => 'blob:http://localhost/report')
  URL.revokeObjectURL = vi.fn()
  store = createDownloads()
})
afterEach(() => {
  for (const d of store.getSnapshot()) store.cancel(d.id)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('download activity', () => {
  it('shows activity immediately, deduplicates active clicks, and measures the transfer', async () => {
    let stream: ReadableStreamDefaultController<Uint8Array>
    vi.stubGlobal('fetch', vi.fn(async () => response(new ReadableStream({ start(c) { stream = c } }), { 'content-length': '6' })))
    const id = store.start(file, 'report.csv')
    expect(store.getSnapshot()[0].state).toBe('starting')
    expect(store.start(file, 'report.csv')).toBe(id)
    await settle()
    stream!.enqueue(new Uint8Array([1, 2, 3]))
    await settle()
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'transferring', received: 3, total: 6 })
    stream!.enqueue(new Uint8Array([4, 5, 6]))
    stream!.close()
    await settle()
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'handed-off', received: 6, name: 'report.csv' })
    expect(saves).toEqual([{ url: 'blob:http://localhost/report', name: 'report.csv' }])
    expect(store.start(file, 'report.csv')).not.toBe(id)
  })

  it('keeps concurrent downloads distinct and does not invent a total', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(new ReadableStream({ start() {} }))))
    store.start(file, 'report.csv')
    store.start('/api/chat/uploads/fictional?sig=fixture', 'notes.txt')
    await settle()
    expect(store.getSnapshot()).toHaveLength(2)
    expect(store.getSnapshot().every((d) => d.state === 'transferring' && d.total === null)).toBe(true)
  })

  it.each([401, 403, 404, 500])('reports HTTP %s without downloading an error body', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('error', { status })))
    store.start(file, 'report.csv')
    await settle()
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'error' })
    expect(store.getSnapshot()[0].message).toMatch(/sign in|permission|no longer|retry/i)
    expect(saves).toHaveLength(0)
  })

  it('reports a broken stream and lets the owner retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(new ReadableStream({ start(c) { c.error(new Error('connection lost')) } }))))
    const id = store.start(file, 'report.csv')
    await settle()
    expect(store.getSnapshot()[0].state).toBe('error')
    vi.stubGlobal('fetch', vi.fn(async () => response('a,b')))
    store.retry(id)
    await settle()
    expect(store.getSnapshot()[0].state).toBe('handed-off')
  })

  it('rejects truncated content instead of claiming transfer completion', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('abc', { 'content-length': '12' })))
    store.start(file, 'report.csv')
    await settle()
    expect(store.getSnapshot()[0].state).toBe('error')
    expect(saves).toHaveLength(0)
  })

  it('preserves UTF-8 Content-Disposition filenames', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('abc', { 'content-disposition': "attachment; filename=report.csv; filename*=UTF-8''r%C3%A9sum%C3%A9.csv" })))
    store.start(file, 'report.csv')
    await settle()
    expect(saves[0].name).toBe('résumé.csv')
  })

  it('streams to a chosen file and reports saved only after the write closes', async () => {
    const written: Uint8Array[] = []
    let close!: () => void
    vi.stubGlobal('showSaveFilePicker', vi.fn(async () => ({ createWritable: async () => ({
      write: async (chunk: Uint8Array) => { written.push(chunk) },
      close: () => new Promise<void>((r) => { close = r }), abort: async () => {},
    }) })))
    vi.stubGlobal('fetch', vi.fn(async () => response('abc', { 'content-length': '3' })))
    store.start(file, 'report.csv')
    await settle()
    expect(written.map((c) => [...c])).toEqual([[97, 98, 99]])
    expect(store.getSnapshot()[0].state).toBe('transferring')
    close()
    await settle()
    expect(store.getSnapshot()[0].state).toBe('saved')
    expect(saves).toHaveLength(0)
  })

  it('handles a cancelled save dialog without fetching or showing an error', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('showSaveFilePicker', vi.fn(async () => { throw new DOMException('cancelled', 'AbortError') }))
    store.start(file, 'report.csv')
    await settle()
    expect(store.getSnapshot()[0].state).toBe('cancelled')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reports a disk write failure without claiming the file was saved', async () => {
    const abort = vi.fn(async () => {})
    let signal: AbortSignal | undefined
    vi.stubGlobal('showSaveFilePicker', vi.fn(async () => ({ createWritable: async () => ({
      write: async () => { throw new Error('Not enough disk space. Free space and retry.') },
      close: vi.fn(), abort,
    }) })))
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => { signal = options.signal!; return response('abc') }))
    store.start(file, 'report.csv')
    await settle()
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'error', message: expect.stringMatching(/disk space/) })
    expect(abort).toHaveBeenCalled()
    expect(signal?.aborted).toBe(true)
    expect(saves).toHaveLength(0)
  })

  it('hands large files to the browser without buffering their body', async () => {
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async () => response(new ReadableStream({ pull() { reads++ } }, { highWaterMark: 0 }), { 'content-length': '1000000000' })))
    store.start(file, 'report.csv')
    await settle()
    expect(store.getSnapshot()[0].state).toBe('handed-off')
    expect(reads).toBe(0)
    expect(saves[0]).toMatchObject({ name: 'report.csv' })
    expect(saves[0].url).toContain('/api/chat/files/raw?')
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('bounds buffering when the server does not report the size', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(33 * 1024 * 1024)); c.close() } }))))
    store.start(file, 'report.csv')
    await settle()
    expect(store.getSnapshot()[0].state).toBe('handed-off')
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(saves[0].url).toContain('/api/chat/files/raw?')
  })

  it('turns a stalled request into an actionable error', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    store.start(file, 'report.csv')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(store.getSnapshot()[0].state).toBe('error')
    expect(store.getSnapshot()[0].message).toMatch(/connection.*retry/)
  })

  it('waits for the desktop callback, including native failure', async () => {
    window.__TOTEM_DESKTOP__ = { version: '0.3.0', downloads: true }
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method !== 'HEAD') throw new Error('A native preflight must not fetch the body')
      return response('', { 'content-length': '1000000000' })
    }))
    const id = store.start(file, 'report.csv')
    await settle()
    expect(store.getSnapshot()[0].state).toBe('transferring')
    store.nativeEvent({ url: saves[0].url, state: 'saved' })
    expect(store.getSnapshot()[0].state).toBe('saved')
    store.start(file, 'report.csv')
    await settle()
    store.nativeEvent({ url: saves[1].url, state: 'error' })
    expect(store.getSnapshot().find((d) => d.id !== id)?.state).toBe('error')
  })

  it('offers the desktop app\'s folder only for a save it can reveal', async () => {
    const reveal = vi.fn()
    store = createDownloads({ reveal })
    window.__TOTEM_DESKTOP__ = { version: '0.3.0', downloads: true }
    vi.stubGlobal('fetch', vi.fn(async () => response('', { 'content-length': '3' })))
    const id = store.start(file, 'report.csv')
    await settle()
    store.reveal(id)
    expect(reveal).not.toHaveBeenCalled()
    store.nativeEvent({ url: saves[0].url, state: 'saved', reveal: true })
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'saved', reveal: saves[0].url })
    store.reveal(id)
    expect(reveal).toHaveBeenCalledWith(saves[0].url)
    const asked = new URL(desktopRevealUrl(saves[0].url))
    expect([asked.protocol, asked.host, asked.searchParams.get('u')]).toEqual(['totem-desktop:', 'reveal', saves[0].url])

    const older = store.start(file, 'report.csv')
    await settle()
    store.nativeEvent({ url: saves[1].url, state: 'saved' })
    const failed = store.start(file, 'report.csv')
    await settle()
    store.nativeEvent({ url: saves[2].url, state: 'error', reveal: true })
    for (const other of [older, failed]) {
      expect(store.getSnapshot().find((d) => d.id === other)?.reveal).toBeUndefined()
      store.reveal(other)
    }
    expect(reveal).toHaveBeenCalledTimes(1)
  })

  it('tracks a native blob download without changing its URL', async () => {
    window.__TOTEM_DESKTOP__ = { downloads: true }
    store.start('blob:http://localhost/recording', 'recording.m4a')
    await settle()
    expect(saves[0].url).toBe('blob:http://localhost/recording')
    expect(store.getSnapshot()[0].state).toBe('transferring')
    store.nativeEvent({ url: saves[0].url, state: 'saved' })
    expect(store.getSnapshot()[0].state).toBe('saved')
  })

  it('reports an unconfirmed native handoff without claiming a save', async () => {
    vi.useFakeTimers()
    window.__TOTEM_DESKTOP__ = { downloads: true }
    vi.stubGlobal('fetch', vi.fn(async () => response('abc')))
    store.start(file, 'report.csv')
    await settle()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'handed-off', message: expect.stringMatching(/not confirmed/) })
  })

  it('refuses navigation handoff when only the bearer can access the file', async () => {
    localStorage.setItem('bridge_secret', 'fictional-test-credential')
    window.__TOTEM_DESKTOP__ = { downloads: true }
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      return options.headers ? response('abc') : new Response('', { status: 401 })
    }))
    store.start(file, 'report.csv')
    await settle()
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'error', message: expect.stringMatching(/sign in/i) })
    expect(saves).toHaveLength(0)
  })

  it('cannot mistake a completion from an earlier page for a new native download', async () => {
    window.__TOTEM_DESKTOP__ = { downloads: true }
    vi.stubGlobal('fetch', vi.fn(async () => response('abc')))
    store.start(file, 'report.csv')
    await settle()
    const oldUrl = saves[0].url
    store.nativeEvent({ url: oldUrl, state: 'saved' })
    store = createDownloads()
    store.start(file, 'report.csv')
    await settle()
    store.nativeEvent({ url: oldUrl, state: 'saved' })
    expect(store.getSnapshot()[0].state).toBe('transferring')
  })

  it('reports native downloads initiated inside a PDF preview', () => {
    store.nativeEvent({ url: file, name: 'report.csv', state: 'transferring' })
    expect(store.getSnapshot()[0]).toMatchObject({ name: 'report.csv', state: 'transferring' })
    store.nativeEvent({ url: file, state: 'error' })
    expect(store.getSnapshot()[0].state).toBe('error')
  })

  it('does not overwrite cancellation with a late response', async () => {
    let reply!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { reply = r })))
    const id = store.start(file, 'report.csv')
    store.cancel(id)
    reply(response('abc'))
    await settle()
    expect(store.getSnapshot()[0].state).toBe('cancelled')
    expect(saves).toHaveLength(0)
  })
})
