import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { useBrowserStream } from './browserStream'

// A stand-in for the bridge's socket (browser/socket.mjs).
class FakeSocket {
  static all: FakeSocket[] = []
  static OPEN = 1
  readyState = 0
  binaryType = ''
  sent: any[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string, public protocols: string[]) { FakeSocket.all.push(this) }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.() }
  open(drive = true) { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ t: 'ready', drive }) }) }
  text(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }) }
  frame(header: Record<string, unknown>) {
    const h = new TextEncoder().encode(JSON.stringify({ tabId: 't', title: '', width: 1280, height: 800, at: 1, ...header }))
    const buf = new Uint8Array(4 + h.length + 2)
    new DataView(buf.buffer).setUint32(0, h.length)
    buf.set(h, 4)
    buf.set([0xff, 0xd8], 4 + h.length)
    this.onmessage?.({ data: buf.buffer })
  }
}

let decodes: Array<(b: { width: number; height: number; close: () => void }) => void>
let drawImage: ReturnType<typeof vi.fn>

beforeEach(() => {
  FakeSocket.all = []
  decodes = []
  drawImage = vi.fn()
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('createImageBitmap', () => new Promise((resolve) => decodes.push(resolve)))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as any)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const bitmap = () => ({ width: 1280, height: 800, close: vi.fn() })

function Harness({ threadId, revive = 1, owner = '' }: { threadId: string; revive?: number; owner?: string }) {
  const stream = useBrowserStream(threadId, true, revive, owner)
  return <div><canvas ref={stream.canvas} /><span data-testid="url">{stream.header?.url || ''}</span><span data-testid="status">{stream.status}</span></div>
}

describe('the browser stream', () => {
  it('drops a frame that finishes decoding after a switch to another chat', async () => {
    const { rerender, getByTestId } = render(<Harness threadId="chat-a" />)
    const a = FakeSocket.all[0]
    act(() => a.open())
    act(() => a.frame({ url: 'https://a.example/' }))
    expect(decodes).toHaveLength(1)
    rerender(<Harness threadId="chat-b" />)
    expect(FakeSocket.all[1].url).toContain('threadId=chat-b')
    const late = bitmap()
    await act(async () => { decodes[0](late) })
    expect(drawImage).not.toHaveBeenCalled()
    expect(late.close).toHaveBeenCalled()
    expect(getByTestId('url').textContent).toBe('')
    // B's own frame does draw.
    act(() => FakeSocket.all[1].open())
    act(() => FakeSocket.all[1].frame({ url: 'https://b.example/' }))
    await act(async () => { decodes[1](bitmap()) })
    expect(drawImage).toHaveBeenCalledTimes(1)
    expect(getByTestId('url').textContent).toBe('https://b.example/')
  })

  it('reconnects when the chat’s browser comes back after closing', async () => {
    const { rerender, getByTestId } = render(<Harness threadId="chat-a" revive={5} />)
    const first = FakeSocket.all[0]
    act(() => first.open())
    act(() => { first.text({ t: 'closed', at: 10 }); first.close() })
    expect(getByTestId('status').textContent).toBe('closed')
    // A frame from before the close is no news.
    rerender(<Harness threadId="chat-a" revive={9} />)
    expect(FakeSocket.all).toHaveLength(1)
    // A newer one is the browser opened again.
    rerender(<Harness threadId="chat-a" revive={11} />)
    expect(FakeSocket.all).toHaveLength(2)
    expect(getByTestId('status').textContent).toBe('connecting')
  })

  it('reconnects even when the new frame arrives before the close is handled', async () => {
    const { rerender, getByTestId } = render(<Harness threadId="chat-a" revive={5} />)
    const first = FakeSocket.all[0]
    act(() => first.open())
    act(() => first.text({ t: 'closed', at: 10 }))
    rerender(<Harness threadId="chat-a" revive={12} />)
    act(() => first.close())
    expect(FakeSocket.all).toHaveLength(2)
    expect(getByTestId('status').textContent).toBe('connecting')
  })

  it('names the panel’s owner id on the socket, as its POSTs do', () => {
    render(<Harness threadId="chat-a" owner="0123456789abcdef0123456789abcdef" />)
    expect(FakeSocket.all[0].url).toContain('&owner=0123456789abcdef0123456789abcdef')
  })

  it('a dropped connection retries; only a closed browser stops it', async () => {
    vi.useFakeTimers()
    try {
      render(<Harness threadId="chat-a" />)
      act(() => FakeSocket.all[0].open())
      act(() => FakeSocket.all[0].close())
      act(() => { vi.advanceTimersByTime(600) })
      expect(FakeSocket.all).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })
})

describe('the browser panel', () => {
  it('keeps taking the wheel after it is hidden and opened again', async () => {
    const store = await import('./store')
    const { default: BrowserPanel } = await import('./BrowserPanel')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ open: true, frame: { tabId: 't', url: 'https://example.com/', title: 'Ex', image: 'data:image/jpeg;base64,', at: 5 }, handoff: null }), { status: 200, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => window.setTimeout(() => fn(0), 0))
    store.setActive('wheel-chat')
    await vi.waitFor(() => expect(store.getState().browser['wheel-chat']).toBeTruthy())
    act(() => store.showBrowser(true))
    const view = render(<BrowserPanel threadId="wheel-chat" />)
    const sizeImage = () => {
      const img = view.container.querySelector('.vc-browser-screen img') as HTMLImageElement
      Object.defineProperty(img, 'naturalWidth', { value: 1280, configurable: true })
      Object.defineProperty(img, 'naturalHeight', { value: 800, configurable: true })
      img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 400, right: 640, bottom: 400, x: 0, y: 0, toJSON: () => ({}) })
      return view.container.querySelector('.vc-browser-screen') as HTMLElement
    }
    const wheel = (el: HTMLElement) => el.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: 100, clientY: 100, bubbles: true, cancelable: true }))
    const sentWheels = () => FakeSocket.all.flatMap((s) => s.sent).filter((m) => m.t === 'input' && m.event.kind === 'wheel')
    act(() => FakeSocket.all[FakeSocket.all.length - 1].open())
    await act(async () => { wheel(sizeImage()); await new Promise((r) => setTimeout(r, 5)) })
    expect(sentWheels()).toHaveLength(1)
    act(() => store.showBrowser(false))
    act(() => store.showBrowser(true))
    act(() => FakeSocket.all[FakeSocket.all.length - 1].open())
    await act(async () => { wheel(sizeImage()); await new Promise((r) => setTimeout(r, 5)) })
    expect(sentWheels()).toHaveLength(2)
    expect(sentWheels()[1].event).toMatchObject({ kind: 'wheel', x: 200, y: 200, deltaY: 100 })
  })
})
