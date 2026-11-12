import { authHeaders } from './api'
import { revealDesktopDownload } from './desktop'

type State = 'starting' | 'transferring' | 'saved' | 'handed-off' | 'error' | 'cancelled'
export interface Download {
  id: number
  url: string
  name: string
  state: State
  received: number
  total: number | null
  message?: string
  /** The desktop app can show this saved file in its folder; the URL it knows the download by. */
  reveal?: string
}
type WritableFile = { write: (chunk: Uint8Array) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> }
type SavePicker = (options: { suggestedName: string }) => Promise<{ createWritable: () => Promise<WritableFile> }>
/** From the desktop app's download handler (`on_download` in desktop/src-tauri/src/lib.rs). `reveal`: it kept the saved path. */
export type NativeDownload = { url: string; name?: string; state: 'transferring' | 'saved' | 'error'; reveal?: boolean }

declare global {
  interface Window { showSaveFilePicker?: SavePicker }
}

const BUFFER_LIMIT = 32 * 1024 * 1024
const preflightMethod = (url: string) => new URL(url).origin === location.origin && /^\/api\/chat\/(files\/raw$|uploads\/)/.test(new URL(url).pathname) ? 'HEAD' : 'GET'
export const downloadActive = (d: Download) => d.state === 'starting' || d.state === 'transferring'

export function downloadUrl(href: string) {
  const url = new URL(href, location.href)
  if (url.origin === location.origin && /^\/api\/(chat\/(files\/raw|uploads\/)|apple\/attachment)/.test(url.pathname)) url.searchParams.set('download', '1')
  return url.href
}

function fileName(name: string) {
  return name.replace(/[\\/\u0000-\u001f]/g, '_') || 'download'
}
function responseName(response: Response, fallback: string) {
  const disposition = response.headers.get('content-disposition') || ''
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8) { try { return fileName(decodeURIComponent(utf8[1])) } catch { /* use the plain filename */ } }
  const plain = disposition.match(/filename=(?:"([^"]*)"|([^;\s]+))/i)
  return fileName(plain?.[1] || plain?.[2] || fallback)
}
function checkResponse(response: Response) {
  if (response.status === 401) throw new Error('Sign in to Totem, then retry this download.')
  if (response.status === 403) throw new Error('Totem does not have permission to share this file. Check its shared folders, then retry.')
  if (response.status === 404) throw new Error('This file is no longer available. Refresh the files list or ask for it again.')
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}). Retry in a moment.`)
  if (response.redirected && /text\/html/i.test(response.headers.get('content-type') || '') && !response.headers.has('content-disposition')) {
    throw new Error('Sign in to the server in this browser, then retry this download.')
  }
}

function handOff(url: string, name: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.dataset.downloadManaged = 'true'
  a.hidden = true
  document.body.append(a)
  try { a.click() } finally { a.remove() }
}

/** One store for every route; a transfer survives closing its preview or changing tabs. */
export function createDownloads({ reveal: openFolder = revealDesktopDownload }: { reveal?: (url: string) => void } = {}) {
  let rows: Download[] = []
  let seq = 0
  const listeners = new Set<() => void>()
  const running = new Map<number, { controller: AbortController; nativeUrl?: string; timer?: ReturnType<typeof setTimeout> }>()
  function emit() { for (const fn of listeners) fn() }
  function update(id: number, patch: Partial<Download>) {
    rows = rows.map((d) => d.id === id ? { ...d, ...patch } : d)
    emit()
  }
  function finish(id: number, state: State, message?: string, extra?: Partial<Download>) {
    const run = running.get(id)
    if (!run) return
    clearTimeout(run.timer)
    running.delete(id)
    update(id, { state, message, ...extra })
  }
  function timeout(id: number) {
    const run = running.get(id)
    if (!run) return
    clearTimeout(run.timer)
    run.timer = setTimeout(() => {
      run.controller.abort()
      finish(id, 'error', 'The download stopped responding. Check your connection and retry.')
    }, 60_000)
  }
  async function nativeOrBrowser(id: number, url: string, name: string, native: boolean) {
    const run = running.get(id)
    if (!run) return
    // Navigations cannot carry a bearer header. Check that cookies or the
    // upload's per-file signature suffice before handing a large file over.
    if (new URL(url).protocol !== 'blob:' && new URL(url).origin === location.origin && authHeaders().Authorization) {
      const check = await fetch(url, { method: preflightMethod(url), credentials: 'same-origin', signal: run.controller.signal })
      await check.body?.cancel()
      checkResponse(check)
    }
    if (!running.has(id)) return
    if (native) {
      const target = new URL(url)
      if (target.protocol !== 'blob:') target.searchParams.set('totemDownload', Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(16)).join('-'))
      run.nativeUrl = target.href
      update(id, { state: 'transferring', total: null })
      // Requested/Finished are all Tauri exposes; no fabricated percentage.
      clearTimeout(run.timer)
      run.timer = setTimeout(() => finish(id, 'handed-off', 'The desktop app has not confirmed this download. Check Downloads before retrying.'), 30_000)
      handOff(target.href, name)
    } else {
      handOff(url, name)
      finish(id, 'handed-off', 'Sent to your browser. Check Downloads for progress and completion; allow downloads if prompted.')
    }
  }
  async function transfer(id: number, url: string, name: string, picker: ReturnType<SavePicker> | null) {
    const run = running.get(id)!
    let writer: WritableFile | undefined
    try {
      if (picker) {
        const handle = await picker
        if (!running.has(id)) return
        writer = await handle.createWritable()
      }
      if (!running.has(id)) { await writer?.abort(); return }
      timeout(id)
      const sameOrigin = new URL(url).origin === location.origin
      const native = window.__TOTEM_DESKTOP__?.downloads === true
      const response = await fetch(url, { method: native ? preflightMethod(url) : 'GET', headers: sameOrigin ? authHeaders() : {}, credentials: 'same-origin', signal: run.controller.signal })
      if (!running.has(id)) { await response.body?.cancel(); await writer?.abort(); return }
      try { checkResponse(response) } catch (e) { await response.body?.cancel(); throw e }
      name = responseName(response, name)
      const length = response.headers.get('content-length')
      const total = length !== null && /^\d+$/.test(length) && !response.headers.get('content-encoding') ? Number(length) : null
      update(id, { name, total, state: 'transferring' })
      if (!writer && (native || (total !== null && total > BUFFER_LIMIT))) {
        await response.body?.cancel()
        await nativeOrBrowser(id, url, name, native)
        return
      }
      if (!response.body) throw new Error('The server returned no file. Refresh the files list and retry.')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let received = 0
      let lastUpdate = 0
      try {
        while (running.has(id)) {
          const { done, value } = await reader.read()
          if (!running.has(id)) return
          if (done) break
          received += value.byteLength
          if (!writer && received > BUFFER_LIMIT) {
            chunks.length = 0
            await reader.cancel()
            await nativeOrBrowser(id, url, name, false)
            return
          }
          if (writer) await writer.write(value)
          else chunks.push(value)
          timeout(id)
          if (!lastUpdate || Date.now() - lastUpdate >= 100) { update(id, { received }); lastUpdate = Date.now() }
        }
      } finally { reader.releaseLock() }
      if (!running.has(id)) return
      if (total !== null && total !== received) throw new Error('The connection ended before the whole file arrived. Retry the download.')
      update(id, { received })
      if (writer) {
        await writer.close()
        finish(id, 'saved', 'Saved to the file you chose.')
      } else {
        const blob = new Blob(chunks as BlobPart[], { type: response.headers.get('content-type') || 'application/octet-stream' })
        const objectUrl = URL.createObjectURL(blob)
        try { handOff(objectUrl, name) } finally { setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000) }
        finish(id, 'handed-off', 'Transfer complete. Sent to your browser; check Downloads to confirm it was saved.')
      }
    } catch (e) {
      run.controller.abort()
      if (!running.has(id)) return
      if (e instanceof DOMException && e.name === 'AbortError') finish(id, 'cancelled', 'Download cancelled.')
      else finish(id, 'error', e instanceof TypeError ? 'Could not download the file. Check your connection and retry.' : (e as Error).message || 'Download failed. Retry in a moment.')
    } finally {
      if (run.controller.signal.aborted) await writer?.abort().catch(() => {})
    }
  }
  function start(href: string, suggestedName = 'download'): number {
    const url = downloadUrl(href)
    const existing = rows.find((d) => d.url === url && downloadActive(d))
    if (existing) { emit(); return existing.id }
    const id = ++seq
    const name = fileName(suggestedName)
    const finished = rows.filter((d) => !downloadActive(d))
    const evict = new Set(finished.slice(0, Math.max(0, finished.length - 9)).map((d) => d.id))
    rows = [...rows.filter((d) => !evict.has(d.id)), { id, url, name, state: 'starting', received: 0, total: null }]
    running.set(id, { controller: new AbortController() })
    emit()
    if (new URL(url).protocol === 'blob:') {
      if (window.__TOTEM_DESKTOP__?.downloads) void nativeOrBrowser(id, url, name, true)
      else {
        handOff(url, name)
        finish(id, 'handed-off', 'Sent to your browser. Check Downloads to confirm it was saved.')
      }
      return id
    }
    // Invoke during the click, while browser user activation is still present.
    let picker: ReturnType<SavePicker> | null = null
    if (!window.__TOTEM_DESKTOP__ && window.showSaveFilePicker) {
      try { picker = window.showSaveFilePicker({ suggestedName: name }) } catch (e) { picker = Promise.reject(e) }
    }
    void transfer(id, url, name, picker)
    return id
  }
  return {
    start,
    getSnapshot: () => rows,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    cancel(id: number) {
      const run = running.get(id)
      if (run?.nativeUrl) return // Tauri exposes no cancellation handle.
      run?.controller.abort()
      finish(id, 'cancelled', 'Download cancelled.')
    },
    dismiss(id: number) { if (running.has(id)) return; rows = rows.filter((d) => d.id !== id); emit() },
    retry(id: number) { const d = rows.find((d) => d.id === id); if (d) { this.dismiss(id); return start(d.url, d.name) } },
    nativeEvent(event: NativeDownload) {
      if (!event || typeof event.url !== 'string') return
      const entry = [...running].find(([, run]) => run.nativeUrl === event.url)
      if (!entry) {
        if (event.state === 'transferring') {
          const id = ++seq
          running.set(id, { controller: new AbortController(), nativeUrl: event.url })
          rows = [...rows, { id, url: event.url, name: fileName(event.name || 'download'), state: 'transferring', received: 0, total: null }]
          emit()
        }
        return
      }
      const [id, run] = entry
      clearTimeout(run.timer)
      if (event.state === 'transferring') update(id, { state: 'transferring', ...(event.name ? { name: fileName(event.name) } : {}) })
      else if (event.state === 'saved') finish(id, 'saved', 'The desktop app confirmed the file was saved in Downloads.', event.reveal === true ? { reveal: event.url } : undefined)
      else finish(id, 'error', 'The desktop download failed or was cancelled. Check Downloads and available disk space, then retry.')
    },
    reveal(id: number) {
      const d = rows.find((d) => d.id === id)
      if (d?.state === 'saved' && d.reveal) openFolder(d.reveal)
    },
    isNative(id: number) { return Boolean(running.get(id)?.nativeUrl) },
  }
}

export const downloads = createDownloads()

export function installDownloadLinks() {
  const click = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const anchor = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[download]') : null
    if (!anchor || anchor.dataset.downloadManaged) return
    e.preventDefault()
    downloads.start(anchor.href, anchor.download || 'download')
  }
  const native = (e: Event) => downloads.nativeEvent((e as CustomEvent<NativeDownload>).detail)
  document.addEventListener('click', click, true)
  window.addEventListener('totem-desktop-download', native)
  return () => { document.removeEventListener('click', click, true); window.removeEventListener('totem-desktop-download', native) }
}
