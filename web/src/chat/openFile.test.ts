import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openArtifact, openFile, openResource, getState } from './store'
import { readArtifactText } from './ArtifactPanel'

// The bug: a reply's file link opened `/api/chat/files/raw?path=…` in the canvas,
// read with a bare fetch(). A dashboard unlocked with BRIDGE_SECRET has no session
// cookie, so that answered 401 and the canvas showed `{"error":"unauthorized"}` as
// the page. Every opener now asks the bridge for the file's signed link (sent with
// the bearer through api()), and the canvas reads that.

const FILE = '/Users/owner/apps/totem/data/chat-outputs/t1/stays.html'
const SIGNED = `/api/chat/files/raw?path=${encodeURIComponent(FILE)}&exp=99&sig=${'s'.repeat(43)}`
let calls: { url: string; init?: RequestInit }[]

function respond(handler: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, init }); return handler(url, init) }))
}

beforeEach(() => {
  calls = []
  localStorage.setItem('bridge_secret', 'the-bearer')
})
afterEach(() => {
  openArtifact(null)
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('openFile', () => {
  it('opens the file by its signed link, asked for with the bearer', async () => {
    respond(() => Response.json({ path: FILE, name: 'stays.html', mime: 'text/html', size: 12, url: SIGNED }))
    const pending = openFile(FILE)
    expect(getState().artifact).toMatchObject({ uploadId: `file:${FILE}`, name: 'stays.html', path: FILE })
    expect(getState().artifact?.url).toBeUndefined()
    await pending
    expect(calls[0].url).toBe(`/api/chat/files/link?path=${encodeURIComponent(FILE)}`)
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer the-bearer')
    expect(getState().artifact).toMatchObject({ url: SIGNED, mime: 'text/html', size: 12 })
  })

  it('says why in the canvas when the bridge refuses the path', async () => {
    respond(() => Response.json({ error: 'outside the folders Totem shares' }, { status: 403 }))
    await openFile('/etc/passwd')
    expect(getState().artifact?.url).toBeUndefined()
    expect(getState().artifact?.error).toMatch(/does not share/)
  })

  it('a lapsed sign-in says so instead of leaving the canvas loading', async () => {
    respond(() => Response.json({ error: 'unauthorized' }, { status: 401 }))
    await openFile(FILE)
    expect(getState().artifact?.error).toMatch(/Sign in/)
  })

  it('a slow answer for a file closed since does not reopen it', async () => {
    let release!: () => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { release = () => r(Response.json({ path: FILE, name: 'stays.html', mime: 'text/html', size: 1, url: SIGNED })) })))
    const pending = openFile(FILE)
    openArtifact(null)
    release()
    await pending
    expect(getState().artifact).toBeNull()
  })
})

describe('openResource', () => {
  it('a chart page served under its own sandbox is framed by URL', async () => {
    respond(() => new Response(null, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-disposition': 'inline; filename="chart.html"', 'content-security-policy': "sandbox allow-scripts; default-src 'none'" } }))
    await openResource('/api/chat/uploads/abc12345?sig=x')
    expect(calls[0].init?.method).toBe('HEAD')
    expect(getState().artifact).toMatchObject({ name: 'chart.html', mime: 'text/html', frame: true })
  })

  it('an HTML upload served as a download is not framed (the canvas sandboxes its text)', async () => {
    respond(() => new Response(null, { headers: { 'content-type': 'text/html', 'content-disposition': 'attachment; filename="page.html"' } }))
    await openResource('/api/chat/uploads/abc12345?sig=x')
    expect(getState().artifact).toMatchObject({ name: 'page.html', frame: false })
  })
})

describe('openResource refusals', () => {
  it('a 401 on the HEAD says sign in, not a blank canvas', async () => {
    respond(() => new Response(null, { status: 401 }))
    await openResource('/api/chat/uploads/abc12345?sig=x')
    expect(getState().artifact?.url).toBeUndefined()
    expect(getState().artifact?.error).toMatch(/Sign in/)
  })
})

describe('readArtifactText', () => {
  it('reads a 200 with the bearer on Totem’s origin', async () => {
    respond(() => new Response('<h1>Stays</h1>'))
    expect(await readArtifactText(SIGNED)).toBe('<h1>Stays</h1>')
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer the-bearer')
  })

  it('never hands back an error body as the file', async () => {
    respond(() => Response.json({ error: 'unauthorized' }, { status: 401 }))
    await expect(readArtifactText(SIGNED)).rejects.toThrow(/Sign in/)
  })

  it('sends no bearer to another origin', async () => {
    respond(() => new Response('x'))
    await readArtifactText('https://elsewhere.example/a.txt')
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBeNull()
  })
})
