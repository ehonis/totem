import { describe, expect, it } from 'vitest'
import {
  MIN_ZOOM_SPAN_MS,
  clampView,
  panView,
  pinchView,
  stepZoomedView,
  zoomView,
} from './poolZoom'

const H = 3600_000
const bounds = { startMs: 0, endMs: 48 * H }

describe('clampView', () => {
  it('reads a view covering the whole range as not zoomed', () => {
    expect(clampView({ startMs: -H, endMs: 50 * H }, bounds)).toBeNull()
    expect(clampView(bounds, bounds)).toBeNull()
  })
  it('slides an overhanging view back inside and keeps its width', () => {
    expect(clampView({ startMs: 44 * H, endMs: 52 * H }, bounds)).toEqual({ startMs: 40 * H, endMs: 48 * H })
    expect(clampView({ startMs: -3 * H, endMs: H }, bounds)).toEqual({ startMs: 0, endMs: 4 * H })
  })
  it('never goes narrower than the minimum span', () => {
    const view = clampView({ startMs: 10 * H, endMs: 10 * H + 60_000 }, bounds)
    expect(view && view.endMs - view.startMs).toBe(MIN_ZOOM_SPAN_MS)
  })
  it('refuses nonsense', () => {
    expect(clampView({ startMs: Number.NaN, endMs: H }, bounds)).toBeNull()
    expect(clampView({ startMs: 0, endMs: H }, { startMs: 5, endMs: 5 })).toBeNull()
  })
})

describe('zoomView', () => {
  it('keeps the anchor at the same place on screen', () => {
    const view = zoomView(bounds, bounds, 0.5, 12 * H)
    // 12h was a quarter of the way across; it still is.
    expect(view).toEqual({ startMs: 6 * H, endMs: 30 * H })
  })
  it('zooming back out past the range shows all of it', () => {
    const view = zoomView({ startMs: 6 * H, endMs: 30 * H }, bounds, 4, 12 * H)
    expect(view).toBeNull()
  })
  it('stops at the minimum span instead of collapsing', () => {
    let view: { startMs: number; endMs: number } | null = bounds
    for (let i = 0; i < 40 && view; i += 1) view = zoomView(view, bounds, 0.5, 20 * H) ?? bounds
    expect(view && view.endMs - view.startMs).toBe(MIN_ZOOM_SPAN_MS)
    expect(view!.startMs).toBeLessThanOrEqual(20 * H)
    expect(view!.endMs).toBeGreaterThanOrEqual(20 * H)
  })
})

describe('panView', () => {
  it('stops at the edges', () => {
    expect(panView({ startMs: 10 * H, endMs: 20 * H }, bounds, 100 * H)).toEqual({ startMs: 38 * H, endMs: 48 * H })
    expect(panView({ startMs: 10 * H, endMs: 20 * H }, bounds, -100 * H)).toEqual({ startMs: 0, endMs: 10 * H })
  })
})

describe('pinchView', () => {
  it('keeps both pinned times under the fingers', () => {
    // 10h and 20h pinned 400px apart on an 800px plot: 20h shows across the plot.
    const view = pinchView(10 * H, 20 * H, 200, 600, 800, bounds)
    expect(view).toEqual({ startMs: 5 * H, endMs: 25 * H })
  })
  it('ignores fingers too close to read a scale from, or crossed over', () => {
    expect(pinchView(10 * H, 20 * H, 300, 310, 800, bounds)).toBeUndefined()
    expect(pinchView(10 * H, 20 * H, 600, 200, 800, bounds)).toBeUndefined()
  })
  it('holds the midpoint once the scale hits a limit', () => {
    const view = pinchView(10 * H, 10 * H + 60_000, 0, 800, 800, bounds)
    expect(view!.endMs - view!.startMs).toBe(MIN_ZOOM_SPAN_MS)
    expect((view!.startMs + view!.endMs) / 2).toBe(10 * H + 30_000)
  })
})

describe('stepZoomedView', () => {
  const limits = { min: -2, max: 1 }
  it('slides a whole view inside the page', () => {
    expect(stepZoomedView({ startMs: 0, endMs: 10 * H }, bounds, 1, 0, limits)).toEqual({ zoom: { startMs: 10 * H, endMs: 20 * H } })
  })
  it('pages on when the view runs off the edge', () => {
    expect(stepZoomedView({ startMs: 40 * H, endMs: 48 * H }, bounds, 1, 0, limits)).toEqual({
      zoom: { startMs: 48 * H, endMs: 56 * H },
      offset: 1,
    })
  })
  it('stops at the last page, sliding to its edge first', () => {
    expect(stepZoomedView({ startMs: 35 * H, endMs: 45 * H }, bounds, 1, 1, limits)).toEqual({ zoom: { startMs: 38 * H, endMs: 48 * H } })
    expect(stepZoomedView({ startMs: 38 * H, endMs: 48 * H }, bounds, 1, 1, limits)).toBeNull()
    expect(stepZoomedView({ startMs: 0, endMs: 10 * H }, bounds, -1, -2, limits)).toBeNull()
    expect(stepZoomedView({ startMs: 0, endMs: 10 * H }, bounds, -1, -1, limits)).not.toBeNull()
  })
})
