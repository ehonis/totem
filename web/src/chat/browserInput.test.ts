import { describe, expect, it } from 'vitest'
import { buttonName, clickCounter, decodeFrame, keyAction, modifiersOf, newPanelOwner, socketProtocols, toPagePoint, wheelPixels } from './browserInput'

const page = { width: 1280, height: 800 }

describe('the browser panel maps the pointer onto the page', () => {
  it('scales from the size the frame is shown at to the page’s CSS pixels', () => {
    // Shown at half size, flush in its box.
    expect(toPagePoint(110, 220, { left: 10, top: 20, width: 640, height: 400 }, page)).toEqual({ x: 200, y: 400 })
    // Shown larger than the page (a HiDPI frame drawn at 1.5×).
    expect(toPagePoint(960, 600, { left: 0, top: 0, width: 1920, height: 1200 }, page)).toEqual({ x: 640, y: 400 })
    // Letterboxed: a tall box leaves bands above and below the picture.
    const tall = { left: 0, top: 0, width: 640, height: 1000 }
    expect(toPagePoint(320, 500, tall, page)).toEqual({ x: 640, y: 400 })
    expect(toPagePoint(320, 100, tall, page)).toBeNull()
    // Off the picture is nothing, unless a drag is under way: then it holds the edge.
    expect(toPagePoint(700, 10, { left: 0, top: 0, width: 640, height: 400 }, page)).toBeNull()
    expect(toPagePoint(700, -5, { left: 0, top: 0, width: 640, height: 400 }, page, { clamp: true })).toEqual({ x: 1279, y: 0 })
    expect(toPagePoint(1, 1, { left: 0, top: 0, width: 0, height: 0 }, page)).toBeNull()
  })

  it('names buttons and modifiers the way CDP does', () => {
    expect([0, 1, 2, 3, 4, 9].map(buttonName)).toEqual(['left', 'middle', 'right', 'back', 'forward', 'none'])
    expect(modifiersOf({ altKey: true, ctrlKey: false, metaKey: true, shiftKey: true })).toEqual(['Alt', 'Meta', 'Shift'])
    expect(modifiersOf({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toEqual([])
  })

  it('counts double and triple clicks close in time and place', () => {
    const count = clickCounter()
    expect(count(0, 10, 10, 0)).toBe(1)
    expect(count(200, 12, 11, 0)).toBe(2)
    expect(count(400, 12, 11, 0)).toBe(3)
    expect(count(600, 12, 11, 0)).toBe(1)
    expect(count(2000, 12, 11, 0)).toBe(1)
    expect(count(2100, 60, 11, 0)).toBe(1)
    expect(count(2200, 60, 11, 2)).toBe(1)
  })

  it('turns wheel lines and pages into pixels', () => {
    expect(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, page)).toEqual({ deltaX: 0, deltaY: 120 })
    expect(wheelPixels({ deltaX: 1, deltaY: 0, deltaMode: 2 }, page)).toEqual({ deltaX: 800, deltaY: 0 })
    expect(wheelPixels({ deltaX: -4.4, deltaY: 53.6, deltaMode: 0 }, page)).toEqual({ deltaX: -4, deltaY: 54 })
  })
})

describe('keys and text', () => {
  const k = (key: string, extra: Partial<Parameters<typeof keyAction>[0]> = {}) => keyAction({ key, ctrlKey: false, metaKey: false, altKey: false, ...extra })
  it('sends real keys as keys and leaves composed text to the input event', () => {
    expect(k('a')).toBe('key')
    expect(k('Enter')).toBe('key')
    expect(k('Tab')).toBe('key')
    expect(k('a', { ctrlKey: true })).toBe('key')
    expect(k('n', { isComposing: true })).toBe('text')
    expect(k('Unidentified', { keyCode: 229 })).toBe('text')
    expect(k('Dead')).toBe('text')
    expect(k('v', { metaKey: true })).toBe('paste')
    expect(k('V', { ctrlKey: true })).toBe('paste')
  })
})

describe('the socket', () => {
  it('decodes the bridge’s frames', () => {
    const header = new TextEncoder().encode(JSON.stringify({ tabId: 't', url: 'https://example.com/', title: 'Ex', width: 1280, height: 800, at: 1 }))
    const buf = new Uint8Array(4 + header.length + 3)
    new DataView(buf.buffer).setUint32(0, header.length)
    buf.set(header, 4)
    buf.set([0xff, 0xd8, 0xff], 4 + header.length)
    const f = decodeFrame(buf.buffer)
    expect(f?.header).toEqual({ tabId: 't', url: 'https://example.com/', title: 'Ex', width: 1280, height: 800, at: 1 })
    expect([...f!.jpeg]).toEqual([0xff, 0xd8, 0xff])
    expect(decodeFrame(new ArrayBuffer(2))).toBeNull()
    expect(decodeFrame(new Uint8Array([0, 0, 0, 9, 1]).buffer)).toBeNull()
  })

  it('names each panel with an id the bridge takes as its owner', () => {
    const a = newPanelOwner()
    expect(a).toMatch(/^[0-9a-f]{32}$/) // browser/socket.mjs panelOwner: [A-Za-z0-9-]{16,64}
    expect(newPanelOwner()).not.toBe(a)
  })

  it('offers the bearer and the approval code only when this device holds them', () => {
    expect(socketProtocols('totem.browser.v1', '', '')).toEqual(['totem.browser.v1'])
    expect(socketProtocols('totem.browser.v1', 's3cret', 'abc')).toEqual(['totem.browser.v1', 'totem.bearer.czNjcmV0', 'totem.approval.YWJj'])
  })
})
