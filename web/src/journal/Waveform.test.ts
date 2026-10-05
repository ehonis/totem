import { describe, expect, it } from 'vitest'
import { bucket } from './Waveform'

describe('bucket', () => {
  it('right-aligns a short live envelope so the newest moment stays at the right edge', () => {
    expect(bucket([0.5, 1], 5)).toEqual([0, 0, 0, 0.5, 1])
  })

  it('stretches a short finished recording across the whole width instead', () => {
    // A ten-second take must not sit squashed against one end of an empty box.
    expect(bucket([0.5, 1], 4, 'stretch')).toEqual([0.5, 0.5, 1, 1])
    expect(bucket([0.2], 3, 'stretch')).toEqual([0.2, 0.2, 0.2])
  })

  it('keeps the peak of each bucket when squashing a long recording', () => {
    // A quiet run with one loud moment must not average away to nothing: that is
    // the whole point of showing the envelope before Save.
    const samples = [0, 0, 0, 0, 0.9, 0, 0, 0]
    expect(bucket(samples, 4)).toEqual([0, 0, 0.9, 0])
  })

  it('handles the empty and degenerate cases without throwing', () => {
    expect(bucket([], 3)).toEqual([0, 0, 0])
    expect(bucket([0.4], 1)).toEqual([0.4])
    expect(bucket([0.4, 0.7], 0)).toEqual([])
  })

  it('returns exactly the number of bars asked for', () => {
    for (const n of [1, 7, 80, 233]) {
      expect(bucket(new Array(1000).fill(0.3), n)).toHaveLength(n)
    }
  })
})
