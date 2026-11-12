// The browser panel's input, as the page should get it: where on the page the
// pointer is, which button and modifiers, how many clicks, and which keys are
// keys rather than text. Pure, so it is tested without a browser; the shapes
// are browser/input.mjs's on the bridge.

export type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift'
export type MouseButton = 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward'

export type RawInput =
  | { kind: 'mouse'; type: 'move' | 'down' | 'up'; x: number; y: number; button: MouseButton; buttons: number; clickCount: number; modifiers: Modifier[] }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers: Modifier[] }
  | { kind: 'key'; type: 'down' | 'up'; key: string; modifiers: Modifier[] }
  | { kind: 'text'; text: string }

export interface Box { left: number; top: number; width: number; height: number }

/**
 * A point on the shown frame in the page's CSS pixels. The frame may be drawn
 * at any size and letterboxed inside `box` (object-fit: contain); `page` is the
 * viewport the frame shows. Null outside the picture, unless `clamp`.
 */
export function toPagePoint(clientX: number, clientY: number, box: Box, page: { width: number; height: number }, { clamp = false } = {}): { x: number; y: number } | null {
  if (!box.width || !box.height || !page.width || !page.height) return null
  const scale = Math.min(box.width / page.width, box.height / page.height)
  const shownW = page.width * scale
  const shownH = page.height * scale
  const left = box.left + (box.width - shownW) / 2
  const top = box.top + (box.height - shownH) / 2
  let x = (clientX - left) / scale
  let y = (clientY - top) / scale
  // A drag that leaves the picture keeps going along its edge.
  if (clamp) { x = Math.min(page.width, Math.max(0, x)); y = Math.min(page.height, Math.max(0, y)) }
  if (x < 0 || y < 0 || x > page.width || y > page.height) return null
  return { x: Math.min(page.width - 1, Math.round(x * 10) / 10), y: Math.min(page.height - 1, Math.round(y * 10) / 10) }
}

export function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): Modifier[] {
  const out: Modifier[] = []
  if (e.altKey) out.push('Alt')
  if (e.ctrlKey) out.push('Control')
  if (e.metaKey) out.push('Meta')
  if (e.shiftKey) out.push('Shift')
  return out
}

/** A DOM MouseEvent.button as CDP names it. */
export function buttonName(button: number): MouseButton {
  return (['left', 'middle', 'right', 'back', 'forward'] as const)[button] ?? 'none'
}

/** Counts double and triple clicks the way the OS does: close in time and place. */
export function clickCounter(windowMs = 500, slop = 5) {
  let last = { at: 0, x: 0, y: 0, button: -1, count: 0 }
  return (at: number, x: number, y: number, button: number) => {
    const near = at - last.at < windowMs && Math.abs(x - last.x) <= slop && Math.abs(y - last.y) <= slop && button === last.button
    last = { at, x, y, button, count: near ? (last.count % 3) + 1 : 1 }
    return last.count
  }
}

/** Wheel deltas in pixels, whatever unit the device reported them in. */
export function wheelPixels(e: { deltaX: number; deltaY: number; deltaMode: number }, page: { height: number }) {
  const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? page.height : 1
  return { deltaX: Math.round(e.deltaX * unit), deltaY: Math.round(e.deltaY * unit) }
}

/**
 * What to do with a keydown on the panel's hidden textarea: `key` sends it as
 * a key (and the matching keyup later), `text` leaves it to the textarea's input
 * event (IME, phone keyboards, dead keys), `paste` lets the paste event bring the
 * clipboard. Printable characters go as keys too, so a page's own key handlers
 * see them, unless a composition is running.
 */
export function keyAction(e: { key: string; isComposing?: boolean; keyCode?: number; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): 'key' | 'text' | 'paste' {
  if (e.isComposing || e.keyCode === 229 || e.key === 'Unidentified' || e.key === 'Process' || e.key === 'Dead') return 'text'
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v') return 'paste'
  return 'key'
}

/** The bridge's binary frame: [u32 header length][header JSON][JPEG] (browser/socket.mjs). */
export interface FrameHeader { tabId: string; url: string; title: string; width: number; height: number; at: number }
export function decodeFrame(buf: ArrayBuffer): { header: FrameHeader; jpeg: Uint8Array } | null {
  if (buf.byteLength < 4) return null
  const len = new DataView(buf).getUint32(0)
  if (4 + len > buf.byteLength) return null
  try {
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, len))) as FrameHeader
    return { header, jpeg: new Uint8Array(buf, 4 + len) }
  } catch { return null }
}

/**
 * One panel's id for what it holds down, sent on its socket and its POSTs so
 * either lets go of what the other pressed (browser/socket.mjs `panelOwner`).
 * getRandomValues, not randomUUID, which a plain-http origin does not have.
 */
export function newPanelOwner(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The subprotocols a socket offers: the bearer and the approval code, when this device holds them. */
export function socketProtocols(subprotocol: string, secret: string, approvalCode: string): string[] {
  const b64 = (s: string) => {
    let binary = ''
    for (const byte of new TextEncoder().encode(s)) binary += String.fromCharCode(byte)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  return [subprotocol, ...(secret ? [`totem.bearer.${b64(secret)}`] : []), ...(approvalCode ? [`totem.approval.${b64(approvalCode)}`] : [])]
}
