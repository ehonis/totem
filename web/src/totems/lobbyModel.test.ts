import { describe, expect, it } from 'vitest'
import { frontIndex, hash, hueFor, ringFor, rotationFor, MIN_RADIUS } from './lobbyModel'

describe('ringFor', () => {
  it('stands a few totems on an arc of the smallest ring', () => {
    const r = ringFor(3)
    expect(r.radius).toBe(MIN_RADIUS)
    expect(r.full).toBe(false)
    expect(r.step * 3).toBeLessThan(2 * Math.PI)
  })
  it('closes the ring and grows it once they fill it', () => {
    const r = ringFor(30)
    expect(r.full).toBe(true)
    expect(r.radius).toBeGreaterThan(MIN_RADIUS)
    expect(r.step * 30).toBeCloseTo(2 * Math.PI)
  })
})

describe('rotationFor', () => {
  it('spins a full ring the short way round', () => {
    const r = ringFor(30)
    // From the first totem to the last is one step back, not 29 forward.
    expect(rotationFor(29, r, 0)).toBeCloseTo(r.step)
  })
  it('never wraps an arc', () => {
    const r = ringFor(4)
    expect(rotationFor(3, r, 0)).toBeCloseTo(-3 * r.step)
  })
  it('round-trips through frontIndex', () => {
    for (const n of [1, 4, 30]) {
      const r = ringFor(n)
      for (let i = 0; i < n; i++) expect(frontIndex(rotationFor(i, r, 0.4), r, n)).toBe(i)
    }
  })
  it('clamps an arc dragged past its ends', () => {
    const r = ringFor(4)
    expect(frontIndex(5, r, 4)).toBe(0)
    expect(frontIndex(-50, r, 4)).toBe(3)
  })
})

describe('colour', () => {
  it('is stable per id and keyed by kind of work', () => {
    const a = { id: 'x', kind: 'agent' as const, type: 'writer', watcher: false }
    expect(hueFor(a)).toBe(hueFor({ ...a }))
    expect(hash('x')).toBe(hash('x'))
    expect(Math.abs(hueFor(a) - 40)).toBeLessThanOrEqual(12)
    expect(Math.abs(hueFor({ ...a, type: '', watcher: true }) - 168)).toBeLessThanOrEqual(12)
  })
})
