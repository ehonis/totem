import React, { useRef, useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { usePanelEscape } from './escape'

// Escape beside a side panel. FilesPanel, AgentsPanel, BrowserPanel and ArtifactPanel
// close through usePanelEscape; the totem picker (the real ChatHeader button, the
// real MembersPop and GroupPicker) and the usage panel (the real UsageChips) keep theirs.

const now = Date.now()
const usage = {
  accounts: [{ id: 'claude:a', backend: 'claude', label: 'a', state: 'ok', meters: [{ key: '5h', label: '5-hour limit', remainingPct: 83, resetsAt: now + 7200e3 }], headroomPct: 83, fetchedAt: now }],
  pools: [{ backend: 'claude', usable: 1, total: 1, headroomPct: 83 }],
}
vi.mock('../useAiUsageLive', () => ({ useAiUsageLive: () => ({ data: usage, err: null }) }))

const { default: ChatHeader, MembersPop } = await import('./ChatHeader')
const { GroupPicker } = await import('../components/TotemsView')

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const frames = () => act(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))) })

function Panel({ closed }: { closed: () => void }) {
  usePanelEscape(true, closed)
  return <aside><button type="button">Hide panel</button></aside>
}

/** ChatView's wiring: the header's add-totems button opens the real picker. */
function Chat({ panelClosed }: { panelClosed: () => void }) {
  const [picking, setPicking] = useState(false)
  const membersRef = useRef<HTMLButtonElement>(null)
  const jobs = [{ id: 'a', name: 'Daily brief', prompt: 'Brief me' }]
  return (
    <div className="vc">
      <ChatHeader onNewChat={() => {}} onOpenProject={() => {}} onTotems={() => {}} panels={[]} title="Trip"
        members={{ ids: [], dir: new Map(), onPick: () => setPicking((v) => !v), ref: membersRef }} />
      {picking && (
        <MembersPop anchor={membersRef} onClose={() => setPicking(false)}>
          <GroupPicker jobs={jobs} title="Bring totems into this chat" action="Save" onCancel={() => setPicking(false)} onDone={() => setPicking(false)} />
        </MembersPop>
      )}
      <Panel closed={panelClosed} />
      <p>Elsewhere</p>
    </div>
  )
}

const membersButton = () => screen.getByRole('button', { name: 'Bring totems into this chat' })
const picker = () => screen.queryByText('Daily brief')

describe('Escape beside a side panel', () => {
  it('closes the side panel when nothing else takes it', () => {
    const panelClosed = vi.fn()
    render(<Chat panelClosed={panelClosed} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Hide panel' }), { key: 'Escape' })
    expect(panelClosed).toHaveBeenCalledOnce()
  })

  it('opens the totem picker from its header button with focus inside it', () => {
    render(<Chat panelClosed={vi.fn()} />)
    fireEvent.click(membersButton())
    expect(picker()).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('checkbox'))
  })

  it('closes the picker, not the side panel, on Escape with focus still on its button, and gives focus back', async () => {
    const panelClosed = vi.fn()
    render(<Chat panelClosed={panelClosed} />)
    fireEvent.click(membersButton())
    membersButton().focus()
    fireEvent.keyDown(membersButton(), { key: 'Escape' })
    expect(picker()).toBeNull()
    expect(panelClosed).not.toHaveBeenCalled()
    await frames()
    expect(document.activeElement).toBe(membersButton())
  })

  it('gives focus back to its button after Cancel', async () => {
    render(<Chat panelClosed={vi.fn()} />)
    fireEvent.click(membersButton())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(picker()).toBeNull()
    await frames()
    expect(document.activeElement).toBe(membersButton())
  })

  it('closes on a click elsewhere without moving focus, and its own button still toggles it', async () => {
    render(<Chat panelClosed={vi.fn()} />)
    fireEvent.click(membersButton())
    fireEvent.mouseDown(screen.getByText('Elsewhere'))
    expect(picker()).toBeNull()
    await frames()
    expect(document.activeElement).not.toBe(membersButton())
    fireEvent.click(membersButton())
    fireEvent.mouseDown(membersButton())
    fireEvent.click(membersButton())
    expect(picker()).toBeNull()
  })

  it('closes the usage panel, not the side panel, on Escape', () => {
    // jsdom has no Web Animations; with reduced motion the panel opens without them.
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }))
    const panelClosed = vi.fn()
    render(<Chat panelClosed={panelClosed} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    expect(screen.queryByRole('dialog', { name: 'AI usage by provider' })).not.toBeNull()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'AI usage by provider' })).toBeNull()
    expect(panelClosed).not.toHaveBeenCalled()
  })

  it('leaves the side panel open for an Escape a popover already handled', () => {
    const panelClosed = vi.fn()
    render(<Chat panelClosed={panelClosed} />)
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    e.preventDefault()
    window.dispatchEvent(e)
    expect(panelClosed).not.toHaveBeenCalled()
  })
})
