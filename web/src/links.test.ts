import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyLink, downloadFile, installLinkRouting, linkAction, type LinkClick } from './links'
import { downloads } from './downloads'

const ORIGIN = 'https://totem.example'
const FILE = '/Users/owner/apps/totem/data/chat-outputs/f94b05ee-6fa9/pittsburgh-stays-nov-20-23.html'
const click = (href: string, extra: Partial<LinkClick> = {}): LinkClick => ({ href, target: '_blank', button: 0, modified: false, ...extra })
const web = { origin: ORIGIN, desktop: false }
const desktop = { origin: ORIGIN, desktop: true }

describe('classifyLink', () => {
  it('a path on the box, in every spelling a reply uses, is a file', () => {
    expect(classifyLink(FILE, ORIGIN)).toEqual({ kind: 'file', path: FILE })
    expect(classifyLink('/home/owner/totem/data/chat-outputs/t1/Report%20Q3.xlsx', ORIGIN)).toEqual({ kind: 'file', path: '/home/owner/totem/data/chat-outputs/t1/Report Q3.xlsx' })
    expect(classifyLink(`file://${FILE}`, ORIGIN)).toEqual({ kind: 'file', path: FILE })
    expect(classifyLink(`file://localhost${FILE}`, ORIGIN)).toEqual({ kind: 'file', path: FILE })
    expect(classifyLink(`${ORIGIN}${FILE}`, ORIGIN)).toEqual({ kind: 'file', path: FILE })
    expect(classifyLink(`/api/chat/files/raw?path=${encodeURIComponent(FILE)}`, ORIGIN)).toEqual({ kind: 'file', path: FILE })
    // A malformed escape still names the file rather than throwing.
    expect(classifyLink('/tmp/100%.txt', ORIGIN)).toEqual({ kind: 'file', path: '/tmp/100%.txt' })
  })

  it("the dashboard's own pages are app links", () => {
    expect(classifyLink('/settings/general', ORIGIN)).toEqual({ kind: 'app', to: '/settings/general' })
    expect(classifyLink(`${ORIGIN}/chat?thread=abc123#end`, ORIGIN)).toEqual({ kind: 'app', to: '/chat?thread=abc123#end' })
    expect(classifyLink('/todos', ORIGIN)).toEqual({ kind: 'app', to: '/todos' })
    expect(classifyLink('/', ORIGIN)).toEqual({ kind: 'app', to: '/' })
    // Any other path is the dashboard too (the bridge answers it with index.html), never a
    // "resource" the canvas would show a second copy of Totem in.
    expect(classifyLink('/whatever', ORIGIN)).toEqual({ kind: 'app', to: '/whatever' })
    expect(classifyLink('relative.html', ORIGIN)).toEqual({ kind: 'app', to: '/relative.html' })
  })

  it('what the API serves is a resource', () => {
    const upload = `${ORIGIN}/api/chat/uploads/abc12345?sig=xyz`
    expect(classifyLink(upload, ORIGIN)).toEqual({ kind: 'resource', url: upload })
    expect(classifyLink('/api/apple/attachment?id=4', ORIGIN)).toEqual({ kind: 'resource', url: `${ORIGIN}/api/apple/attachment?id=4` })
  })

  it('another site is external; non-web schemes and in-page anchors are not routed', () => {
    expect(classifyLink('https://www.phipps.conservatory.org/holiday', ORIGIN)).toEqual({ kind: 'external', url: 'https://www.phipps.conservatory.org/holiday' })
    // Same host, another port: another origin.
    expect(classifyLink('https://totem.example:8443/chat', ORIGIN)).toEqual({ kind: 'external', url: 'https://totem.example:8443/chat' })
    expect(classifyLink('mailto:owner@example.com', ORIGIN)).toBeNull()
    expect(classifyLink('javascript:alert(1)', ORIGIN)).toBeNull()
    expect(classifyLink('#section', ORIGIN)).toBeNull()
    expect(classifyLink('', ORIGIN)).toBeNull()
    expect(classifyLink('file:///etc/passwd', ORIGIN)).toBeNull()
  })
})

describe('linkAction', () => {
  it('in a browser, only a plain click on a file link is taken over', () => {
    expect(linkAction(click(FILE), web)).toEqual({ kind: 'file', path: FILE })
    expect(linkAction(click(FILE, { modified: true }), web)).toBeNull()
    expect(linkAction(click(FILE, { button: 1 }), web)).toBeNull()
    expect(linkAction(click('/settings/general'), web)).toBeNull()
    expect(linkAction(click('/api/chat/uploads/abc12345?sig=x'), web)).toBeNull()
    expect(linkAction(click('https://example.org/'), web)).toBeNull()
  })

  it('in the desktop app, files and Totem resources stay in the app on any click', () => {
    for (const extra of [{}, { modified: true }, { button: 1 }, { target: null }]) {
      expect(linkAction(click(FILE, extra), desktop)).toEqual({ kind: 'file', path: FILE })
      expect(linkAction(click('/api/chat/uploads/abc12345?sig=x', extra), desktop)?.kind).toBe('resource')
    }
  })

  it('in the desktop app, a page link that would open a new tab navigates in the window', () => {
    expect(linkAction(click('/settings/general'), desktop)).toEqual({ kind: 'app', to: '/settings/general' })
    expect(linkAction(click('/settings/general', { target: null, modified: true }), desktop)?.kind).toBe('app')
    // A plain in-window link already stays in the window: left to the page.
    expect(linkAction(click('/settings/general', { target: null }), desktop)).toBeNull()
  })

  it('in the desktop app, another site is left to the shim (the system browser)', () => {
    expect(linkAction(click('https://www.phipps.conservatory.org/'), desktop)).toBeNull()
  })

  it('a download link is left to downloads.ts; a right click to the browser', () => {
    expect(linkAction(click(FILE, { download: true }), desktop)).toBeNull()
    expect(linkAction(click(FILE, { button: 2 }), desktop)).toBeNull()
  })
})

describe('installLinkRouting', () => {
  let uninstall: () => void
  let opened: string[]
  let resources: string[]
  let shimOpen: ReturnType<typeof vi.fn>
  const onFile = (e: Event) => { e.preventDefault(); opened.push((e as CustomEvent<string>).detail) }
  const onResource = (e: Event) => { e.preventDefault(); resources.push((e as CustomEvent<string>).detail) }

  function link(href: string, target = '_blank') {
    const a = document.createElement('a')
    a.setAttribute('href', href)
    if (target) a.setAttribute('target', target)
    a.textContent = 'x'
    document.body.append(a)
    return a
  }
  // The desktop shim's listener: document, capture, skipping a prevented click.
  let shimSaw: string[]
  const shim = (e: MouseEvent) => {
    if (e.defaultPrevented) return
    const a = (e.target as Element).closest('a[href]') as HTMLAnchorElement | null
    if (a) { e.preventDefault(); shimSaw.push(a.href) }
  }

  beforeEach(() => {
    opened = []
    resources = []
    shimSaw = []
    shimOpen = vi.fn(() => null)
    window.open = shimOpen as unknown as typeof window.open
    window.addEventListener('totem:open-file', onFile)
    window.addEventListener('totem:open-resource', onResource)
  })
  afterEach(() => {
    uninstall?.()
    document.removeEventListener('click', shim, true)
    window.removeEventListener('totem:open-file', onFile)
    window.removeEventListener('totem:open-resource', onResource)
    delete window.__TOTEM_DESKTOP__
    delete (navigator as { userActivation?: unknown }).userActivation
    window.history.replaceState(null, '', '/')
    document.body.replaceChildren()
  })
  const activation = (isActive: boolean) => Object.defineProperty(navigator, 'userActivation', { value: { isActive }, configurable: true })

  it('a reply file link opens in the chat, and the desktop shim never sees it', () => {
    window.__TOTEM_DESKTOP__ = { version: '0.2.1' }
    document.addEventListener('click', shim, true)
    uninstall = installLinkRouting()
    link(FILE).click()
    expect(opened).toEqual([FILE])
    expect(shimSaw).toEqual([])
    link('https://www.phipps.conservatory.org/').click()
    expect(shimSaw).toEqual(['https://www.phipps.conservatory.org/'])
  })

  it('a page link in the desktop app navigates in the window', () => {
    window.__TOTEM_DESKTOP__ = { version: '0.2.1' }
    document.addEventListener('click', shim, true)
    uninstall = installLinkRouting()
    const pops = vi.fn()
    window.addEventListener('popstate', pops)
    link('/settings/general').click()
    window.removeEventListener('popstate', pops)
    expect(location.pathname).toBe('/settings/general')
    expect(pops).toHaveBeenCalledTimes(1)
    expect(shimSaw).toEqual([])
  })

  it("in the desktop app window.open keeps Totem's own URLs in the app during a click, and sends the rest to the shim", () => {
    window.__TOTEM_DESKTOP__ = { version: '0.2.1' }
    activation(true)
    uninstall = installLinkRouting()
    window.open(`${location.origin}/api/chat/uploads/abc12345?sig=x`, '_blank', 'noopener')
    expect(resources).toEqual([`${location.origin}/api/chat/uploads/abc12345?sig=x`])
    window.open('https://example.org/', '_blank')
    expect(shimOpen).toHaveBeenCalledWith('https://example.org/', '_blank', undefined)
    uninstall()
    expect(window.open).toBe(shimOpen)
  })

  it('in the desktop app window.open outside a click (a chart posting on load) never opens Totem in the app', () => {
    window.__TOTEM_DESKTOP__ = { version: '0.2.1' }
    activation(false)
    uninstall = installLinkRouting()
    window.open(`${location.origin}/api/chat/uploads/abc12345?sig=x`, '_blank')
    window.open(`${location.origin}/settings/general`, '_blank')
    expect(resources).toEqual([])
    expect(location.pathname).not.toBe('/settings/general')
    expect(shimOpen).toHaveBeenCalledTimes(2)
  })

  it('in a browser, window.open is untouched and a ctrl-click on a file is the browser’s', () => {
    uninstall = installLinkRouting()
    expect(window.open).toBe(shimOpen)
    const a = link(FILE)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })
    a.dispatchEvent(event)
    expect(opened).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('downloadFile', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('downloads through the signed link, and starts nothing when the bridge refuses the file', async () => {
    const start = vi.spyOn(downloads, 'start').mockImplementation(() => 1)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'a.csv', url: '/api/chat/files/raw?path=%2Ftmp%2Fa.csv&exp=1&sig=s' })))
    downloadFile('/tmp/a.csv')
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith('/api/chat/files/raw?path=%2Ftmp%2Fa.csv&exp=1&sig=s', 'a.csv'))
    start.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'outside the folders Totem shares' }, { status: 403 })))
    downloadFile('/etc/passwd')
    await new Promise((r) => setTimeout(r, 20))
    expect(start).not.toHaveBeenCalled()
  })
})
