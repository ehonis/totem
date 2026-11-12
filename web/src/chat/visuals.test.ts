import { describe, expect, it } from 'vitest'
import { isRenderTool, readVisualMessage, visualOpensOutside, VISUAL_SANDBOX } from './visuals'

describe('chart frames', () => {
  it('reads the page’s height and links, and nothing else', () => {
    expect(readVisualMessage({ type: 'totem-visual:size', height: 353.2 })).toEqual({ kind: 'size', height: 354 })
    expect(readVisualMessage({ type: 'totem-visual:size', height: 5 })).toEqual({ kind: 'size', height: 80 })
    expect(readVisualMessage({ type: 'totem-visual:size', height: 1e9 })).toEqual({ kind: 'size', height: 8000 })
    expect(readVisualMessage({ type: 'totem-visual:size', height: -1 })).toBeNull()
    expect(readVisualMessage({ type: 'totem-visual:open', url: 'https://strava.com/a/1' })).toEqual({ kind: 'open', url: 'https://strava.com/a/1' })
    expect(readVisualMessage({ type: 'totem-visual:open', url: 'javascript:alert(1)' })).toBeNull()
    expect(readVisualMessage({ type: 'other' })).toBeNull()
    expect(readVisualMessage('totem-visual:size')).toBeNull()
  })

  it('hides the render call in either spelling, and never grants the frame Totem’s origin', () => {
    expect(isRenderTool('html_render')).toBe(true)
    expect(isRenderTool('browser__html_render')).toBe(true)
    expect(isRenderTool('html_preview')).toBe(false)
    expect(VISUAL_SANDBOX).not.toMatch(/allow-same-origin|allow-popups|allow-top-navigation/)
  })
})

describe('visualOpensOutside', () => {
  it('lets a chart open another site, never a URL on Totem', () => {
    expect(visualOpensOutside('https://strava.com/a/1', 'https://totem.example')).toBe(true)
    expect(visualOpensOutside('https://totem.example/api/chat/files/raw?path=%2Ftmp%2Fa', 'https://totem.example')).toBe(false)
    expect(visualOpensOutside('https://totem.example/settings', 'https://totem.example')).toBe(false)
    expect(visualOpensOutside('not a url', 'https://totem.example')).toBe(false)
  })
})
