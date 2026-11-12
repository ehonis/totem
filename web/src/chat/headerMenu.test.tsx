import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { HeaderMenu, type HeaderItem } from './HeaderPanels'
import { usePanelEscape } from './escape'
import { IconFolder, IconRobot } from './icons'

// The chat header's "…" menu: it opens beside a side panel (it only shows when the
// chat column is narrow), so its keys must not reach the panel.

afterEach(cleanup)

const frames = () => act(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))) })

function setup(items: HeaderItem[]) {
  // A side panel, closing on Escape through the same hook FilesPanel, AgentsPanel, BrowserPanel and ArtifactPanel use.
  const panelClosed = vi.fn()
  function Panel() {
    usePanelEscape(true, panelClosed)
    return <aside className="vc-split"><div className="vc-artifact"><button type="button">Hide panel</button></div></aside>
  }
  // Folded through the `menu` step (headerFold.ts), as a narrow column beside a panel is.
  const utils = render(<><header className="vc-top"><HeaderMenu items={items} fold={5} /></header><Panel /></>)
  return { ...utils, panelClosed, done: () => {} }
}

const item = (id: string, label: string, extra: Partial<HeaderItem> = {}): HeaderItem => ({ id, label, title: label, icon: id === 'files' ? IconFolder : IconRobot, into: 'menu', open: vi.fn(), ...extra })

async function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /^More/ }))
  await frames()
  return screen.getByRole('menu')
}

describe('chat header "…" menu', () => {
  it('lists only what has been folded into it, and focuses the first row once', async () => {
    const t = setup([item('files', '2 files'), item('agents', '1 working'), item('usage', 'AI usage', { into: 'usage' })])
    await openMenu()
    const rows = screen.getAllByRole('menuitem')
    expect(rows.map((r) => r.textContent)).toEqual(['2 files', '1 working'])
    expect(document.activeElement).toBe(rows[0])
    t.done()
  })

  it('moves with the arrow keys, Home and End', async () => {
    const t = setup([item('files', '2 files'), item('agents', '1 working')])
    const menu = await openMenu()
    const rows = screen.getAllByRole('menuitem')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[1])
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[0])
    fireEvent.keyDown(menu, { key: 'End' })
    expect(document.activeElement).toBe(rows[1])
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(document.activeElement).toBe(rows[0])
    t.done()
  })

  it('closes on Escape, gives focus back to "…", and leaves the side panel open', async () => {
    const t = setup([item('files', '2 files'), item('agents', '1 working')])
    await openMenu()
    fireEvent.keyDown(screen.getAllByRole('menuitem')[0], { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^More/ }))
    expect(t.panelClosed).not.toHaveBeenCalled()
    t.done()
  })

  it('leaves the side panel open when Escape is pressed with focus still on "…"', async () => {
    const t = setup([item('files', '2 files'), item('agents', '1 working')])
    await openMenu()
    const more = screen.getByRole('button', { name: /^More/ })
    more.focus()
    fireEvent.keyDown(more, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(t.panelClosed).not.toHaveBeenCalled()
    t.done()
  })

  it('closes on Tab and gives focus back to "…" instead of the top of the page', async () => {
    const t = setup([item('files', '2 files'), item('agents', '1 working')])
    await openMenu()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => { screen.getAllByRole('menuitem')[0].dispatchEvent(tab) })
    expect(tab.defaultPrevented).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^More/ }))
    t.done()
  })

  it('runs a row and moves focus into the side panel it opened', async () => {
    const open = vi.fn()
    const t = setup([item('files', '2 files', { open, focusAfter: '.vc-split > .vc-artifact' }), item('agents', '1 working')])
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: '2 files' }))
    expect(open).toHaveBeenCalledOnce()
    await frames()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Hide panel' }))
    t.done()
  })

  it('puts focus back on "…" when what it ran opened nothing to focus', async () => {
    const t = setup([item('files', '2 files'), item('agents', '1 working')])
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: '1 working' }))
    await frames()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^More/ }))
    t.done()
  })
})
