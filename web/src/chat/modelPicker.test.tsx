import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import ModelPicker from './ModelPicker'
import { getState } from './store'
import { placePopover } from './ui'
import { effortFor, speedFor } from './traits'
import type { ModelSettings } from './types'

const view = { width: 1440, height: 900, dock: 0 }
const chip = (top: number, right = 1200) => ({ top, bottom: top + 32, left: right - 140, right })

describe('placePopover', () => {
  const opts = { width: 740, height: 460, align: 'end' as const, offsetX: 4 }

  it('opens upward from a chip low on the page, right edge on the chip', () => {
    const p = placePopover(chip(847), view, opts)
    expect(p.up).toBe(true)
    expect(p.style).toMatchObject({ position: 'fixed', left: 1204 - 740, width: 740, height: 460, top: 847 - 10 - 460 })
  })

  it('opens downward from a composer near the top (a project home), in the same place every time', () => {
    const a = placePopover(chip(227), view, opts)
    const b = placePopover(chip(227), view, opts)
    expect(a.up).toBe(false)
    expect(a.style).toMatchObject({ top: 227 + 32 + 10, height: 460 })
    expect(b).toEqual(a)
  })

  it('never leaves the viewport, however little room there is', () => {
    for (const [w, h] of [[1440, 900], [1024, 640], [800, 420], [390, 844], [360, 300]]) {
      for (let top = 0; top < h - 32; top += 37) {
        const r = chip(top, Math.min(w - 10, 1200))
        const { style } = placePopover(r, { width: w, height: h, dock: 0 }, opts)
        const left = style.left as number, t = style.top as number, ht = style.height as number, wd = style.width as number
        expect(left).toBeGreaterThanOrEqual(0)
        expect(left + wd).toBeLessThanOrEqual(w)
        expect(t).toBeGreaterThanOrEqual(0)
        expect(t + ht).toBeLessThanOrEqual(h)
      }
    }
  })

  it('stays inside the window when the chip has scrolled out of it', () => {
    for (const top of [-400, -100, -40, 900, 1200]) {
      for (const v of [{ width: 844, height: 390, dock: 0 }, { width: 1440, height: 900, dock: 0 }]) {
        const { style } = placePopover(chip(top), v, opts)
        expect(style.top as number).toBeGreaterThanOrEqual(0)
        expect((style.top as number) + (style.height as number)).toBeLessThanOrEqual(v.height)
      }
    }
  })

  it('keeps clear of the phone dock and goes full width on a phone', () => {
    const r = chip(795, 290)
    const p = placePopover(r, { width: 390, height: 844, dock: 30 }, opts)
    expect(p.style).toMatchObject({ left: 8, width: 374 })
    expect((p.style.top as number) + (p.style.height as number)).toBeLessThanOrEqual(844 - 30)
  })

  it('hangs a content-sized popover from its bottom edge when it opens upward', () => {
    const r = chip(700)
    const p = placePopover(r, { ...view, layoutHeight: 900 }, { width: 300, height: 340, fit: true, align: 'end' })
    expect(p.style).toMatchObject({ top: 'auto', bottom: 900 - (700 - 10), maxHeight: 340 })
  })
})

describe('effortFor and speedFor', () => {
  const model = { id: 'm', name: 'M', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }

  it("lists the model's levels, marks its default and falls back to it", () => {
    const e = effortFor(model, { effort: 'default' })!
    expect(e.value).toBe('medium')
    expect(e.levels.map((l) => [l.label, l.isDefault])).toEqual([['Low', false], ['Medium', true], ['High', false]])
    expect(effortFor(model, { effort: 'high' })!.value).toBe('high')
    // A level the model does not have (carried over from another model) is not shown as picked.
    expect(effortFor(model, { effort: 'max' })!.value).toBe('medium')
  })

  it('has nothing for a model without levels', () => {
    expect(effortFor({ id: 'x', name: 'X', efforts: [] }, { effort: 'default' })).toBeNull()
    expect(effortFor(undefined, { effort: 'low' })).toBeNull()
  })

  it("offers speed only where Totem can send it (Cursor's Composer)", () => {
    expect(speedFor('cursor', { modelId: 'composer-2.5', speed: 'fast' })).toBe('fast')
    expect(speedFor('cursor', { modelId: 'composer-2.5', speed: 'default' })).toBe('standard')
    expect(speedFor('cursor', { modelId: 'composer-2.5-fast', speed: 'default' })).toBeNull()
    expect(speedFor('cursor', { modelId: 'auto', speed: 'fast' })).toBeNull()
    expect(speedFor('codex', { modelId: 'gpt-6.1-sol', speed: 'default' })).toBeNull()
  })
})

describe('ModelPicker in the composer', () => {
  const settings: ModelSettings = { modelId: 'gpt-6.1-sol', speed: 'default', effort: 'low', context: 'default' }

  beforeEach(() => {
    const s = getState() as any
    s.providers = [
      { id: 'codex', name: 'Codex', driver: 'codex', supportsModelPicker: true, default: true },
      { id: 'cursor', name: 'Cursor', driver: 'cursor', supportsModelPicker: true },
    ]
    s.defaultProvider = 'codex'
    s.defaultModel = 'gpt-6.1-sol'
    s.models = {
      codex: [
        { id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol', favorite: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
        { id: 'gpt-6.1-terra', name: 'GPT 6.1 Terra', efforts: [] },
      ],
      cursor: [{ id: 'composer-2.5', name: 'Composer 2.5', efforts: [] }],
    }
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => setTimeout(() => f(0), 0))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  function mount(onChange = vi.fn(), extra: Partial<React.ComponentProps<typeof ModelPicker>> = {}) {
    render(<div className="vc-model-group"><ModelPicker provider="codex" settings={settings} onChange={onChange} align="end" traits {...extra} /></div>)
    return onChange
  }

  it('shows the model and its effort as one chip', () => {
    mount()
    expect(screen.getByRole('button', { name: /GPT 6.1 Sol · Low/ })).toBeInTheDocument()
  })

  it('opens one panel in <body> with the models, the reasoning column and access', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: /GPT 6.1 Sol/ }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.parentElement).toBe(document.body)
    expect(dialog.style.position).toBe('fixed')
    expect(screen.getByRole('menu', { name: /Reasoning/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /Low/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemradio', { name: /Medium.*Default/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Full access/ })).toBeInTheDocument()
    // Codex runs are sent no speed, so there is no toggle.
    expect(screen.queryByRole('radiogroup', { name: 'Speed' })).toBeNull()
  })

  it('stays open on a click inside the portalled panel and closes on one outside', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: /GPT 6.1 Sol/ }))
    fireEvent.mouseDown(screen.getByRole('textbox', { name: 'Search models' }))
    expect(screen.queryByRole('dialog')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('sets the effort and closes', () => {
    const onChange = mount()
    fireEvent.click(screen.getByRole('button', { name: /GPT 6.1 Sol/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /High/ }))
    expect(onChange).toHaveBeenCalledWith({ provider: 'codex', modelSettings: { ...settings, effort: 'high' } })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('sets access from the footer menu and keeps the picker open; Escape closes the menu first', () => {
    const onChange = mount()
    fireEvent.click(screen.getByRole('button', { name: /GPT 6.1 Sol/ }))
    fireEvent.click(screen.getByRole('button', { name: /Full access/ }))
    const menu = screen.getByRole('menu', { name: 'Access' })
    expect(menu.parentElement).toBe(document.body)
    fireEvent.mouseDown(screen.getByRole('menuitemradio', { name: /Supervised/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Supervised/ }))
    expect(onChange).toHaveBeenCalledWith({ provider: 'codex', modelSettings: { ...settings, access: 'supervised' } })
    expect(screen.queryByRole('menu', { name: 'Access' })).toBeNull()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Full access/ }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Access' })).toBeNull()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // Keyboard focus is not dropped on <body>: back on the access button, then on the chip.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Full access/ }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /GPT 6.1 Sol/ }))
  })

  it('keeps keyboard picking: arrows and Enter, and Ctrl/⌘+number', () => {
    const onChange = mount()
    fireEvent.click(screen.getByRole('button', { name: /GPT 6.1 Sol/ }))
    const search = screen.getByRole('textbox', { name: 'Search models' })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'codex', modelSettings: expect.objectContaining({ modelId: 'gpt-6.1-terra' }) }))
    fireEvent.click(screen.getByRole('button', { name: /GPT 6.1 Sol/ }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search models' }), { key: '1', ctrlKey: true })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ modelSettings: expect.objectContaining({ modelId: 'gpt-6.1-sol' }) }))
  })

  it("shows Standard/Fast for Cursor's Composer", () => {
    const onChange = vi.fn()
    render(<ModelPicker provider="cursor" settings={{ modelId: 'composer-2.5', speed: 'fast', effort: 'default', context: 'default' }} onChange={onChange} traits />)
    fireEvent.click(screen.getByRole('button', { name: /Composer 2.5/ }))
    expect(screen.getByRole('radio', { name: /Fast/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('menu', { name: /Reasoning/ })).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: /Standard/ }))
    expect(onChange).toHaveBeenCalledWith({ provider: 'cursor', modelSettings: expect.objectContaining({ speed: 'quality' }) })
    // A radio group: the arrow keys pick as they move.
    onChange.mockClear()
    const fast = screen.getByRole('radio', { name: /Fast/ })
    fast.focus()
    fireEvent.keyDown(fast, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenCalledWith({ provider: 'cursor', modelSettings: expect.objectContaining({ speed: 'quality' }) })
  })

  it('elsewhere (a project default) picks the model only', async () => {
    render(<ModelPicker provider="codex" settings={settings} onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: /GPT 6.1 Sol/ }).textContent).not.toMatch(/Low/)
    fireEvent.click(screen.getByRole('button', { name: /GPT 6.1 Sol/ }))
    await act(async () => {})
    expect(screen.queryByRole('menu', { name: /Reasoning/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Full access/ })).toBeNull()
  })
})
