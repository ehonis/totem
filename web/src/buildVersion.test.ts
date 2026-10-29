import { describe, expect, it } from 'vitest'
// @ts-expect-error a plain .mjs build helper with no types
import { formatVersion } from '../build-version.mjs'

describe('the version in the rail', () => {
  it('counts merges to main as the last number', () => {
    expect(formatVersion({ pkgVersion: '1.0.0', count: 143, date: '2026-10-28' })).toEqual({ version: '1.0.143', date: '2026-10-28' })
  })

  it('drops the count when there is no git history to count', () => {
    expect(formatVersion({ pkgVersion: '2.3.9', count: 0, date: '2026-10-28' }).version).toBe('2.3')
  })
})
