import { describe, expect, it } from 'vitest'
import { applyBackground, BACKGROUNDS, backgroundVars, DEFAULT_BACKGROUND, findBackground } from './backgrounds'

describe('background palettes', () => {
  it('has unique ids and full hex colours', () => {
    expect(new Set(BACKGROUNDS.map((b) => b.id)).size).toBe(BACKGROUNDS.length)
    for (const b of BACKGROUNDS) {
      for (const c of [b.bg, b.panel, b.raised, b.rail, b.line, b.muted]) expect(c).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('falls back to the default for an unknown or missing id', () => {
    expect(findBackground('gone').id).toBe(DEFAULT_BACKGROUND)
    expect(findBackground(undefined).id).toBe(DEFAULT_BACKGROUND)
  })

  it('sets the variables on <html>, and Original clears them', () => {
    const root = document.documentElement
    applyBackground('true-black')
    expect(root.style.getPropertyValue('--bg')).toBe('#0b0b0c')
    expect(root.style.getPropertyValue('--color-bg-2')).toBe('#141415')
    expect(root.dataset.background).toBe('true-black')
    applyBackground('original')
    for (const name of Object.keys(backgroundVars(BACKGROUNDS[0]))) expect(root.style.getPropertyValue(name)).toBe('')
    expect(root.dataset.background).toBe('original')
  })
})
