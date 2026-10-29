import { describe, expect, it } from 'vitest'
import { hasUnsentText, runningBuild, shouldReload } from './newBuild'

const base = { running: '/assets/index-A.js', served: '/assets/index-B.js', hidden: false, idleMs: 0, unsentText: false }

describe('reloading after a deploy', () => {
  it('stays put while the bundle is current or unknown', () => {
    expect(shouldReload({ ...base, served: base.running, hidden: true })).toBe(false)
    expect(shouldReload({ ...base, served: null, hidden: true })).toBe(false)
    expect(shouldReload({ ...base, running: null, hidden: true })).toBe(false)
  })

  it('reloads a hidden page at once', () => {
    expect(shouldReload({ ...base, hidden: true, unsentText: true })).toBe(true)
  })

  it('waits for a quiet spell with nothing half-typed on a visible page', () => {
    expect(shouldReload(base)).toBe(false)
    expect(shouldReload({ ...base, idleMs: 3 * 60_000, unsentText: true })).toBe(false)
    expect(shouldReload({ ...base, idleMs: 3 * 60_000 })).toBe(true)
  })

  it('reads the running bundle from the page and spots typed text', () => {
    document.head.innerHTML = '<script type="module" crossorigin src="/assets/index-CiQ7mgsu.js"></script>'
    expect(runningBuild()).toBe('/assets/index-CiQ7mgsu.js')
    document.body.innerHTML = '<textarea></textarea>'
    expect(hasUnsentText()).toBe(false)
    document.querySelector('textarea')!.value = 'half a thought'
    expect(hasUnsentText()).toBe(true)
  })
})
