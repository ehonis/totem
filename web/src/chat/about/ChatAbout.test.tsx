import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthError } from '../../api'

const startChatAbout = vi.fn(async (_ctx: unknown) => {})
const copyChatAbout = vi.fn(async (_ctx: unknown) => {})
const chatAboutAuthError = vi.fn()
vi.mock('./start', () => ({
  startChatAbout: (c: unknown) => startChatAbout(c),
  copyChatAbout: (c: unknown) => copyChatAbout(c),
  chatAboutAuthError: () => chatAboutAuthError(),
}))

const { default: ChatAbout } = await import('./ChatAbout')
const { contextMarkdown, settingsContext } = await import('./context')
const { settingsOutline } = await import('./settingsOutline')
const ctx = { place: 'goals' as const, title: 'Goal: Read', lines: [] }

function Card({ onCard, onLink }: { onCard?: () => void; onLink?: (e: React.MouseEvent) => void }) {
  return (
    <article className="card" data-testid="card" onClick={onCard}>
      <h3>Read</h3>
      <a href="https://example.com" onClick={onLink}>link</a>
      <ChatAbout of={() => ctx} />
    </article>
  )
}

const hold = (el: Element) => {
  fireEvent.touchStart(el, { touches: [{ clientX: 10, clientY: 10 }] })
  act(() => { vi.advanceTimersByTime(600) })
}

const select = (el: Element) => {
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

afterEach(() => {
  cleanup(); startChatAbout.mockReset(); copyChatAbout.mockReset(); chatAboutAuthError.mockReset()
  window.getSelection()?.removeAllRanges(); vi.useRealTimers()
})

describe('ChatAbout', () => {
  it('draws nothing on the card', () => {
    render(<Card />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByLabelText('Chat about this')).toBeNull()
  })

  it('right-click opens its menu; shift and links keep the browser\'s', () => {
    render(<Card />)
    const card = screen.getByTestId('card')
    expect(fireEvent.contextMenu(screen.getByText('link'))).toBe(true)
    expect(fireEvent.contextMenu(card, { shiftKey: true })).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()

    expect(fireEvent.contextMenu(screen.getByText('Read'), { clientX: 20, clientY: 30 })).toBe(false)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Chat about this' }))
    expect(startChatAbout).toHaveBeenCalledWith(ctx)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('selected text goes with the chat, and the menu can copy it', async () => {
    const writeText = vi.fn(async (_t: string) => {})
    Object.assign(navigator, { clipboard: { writeText } })
    render(<Card />)
    const title = screen.getByText('Read')
    select(title)
    fireEvent.mouseDown(title, { button: 2 })
    expect(fireEvent.contextMenu(title, { clientX: 5, clientY: 5 })).toBe(false)
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' })) })
    expect(writeText).toHaveBeenCalledWith('Read')

    select(title)
    fireEvent.contextMenu(title)
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Chat about the selection' })) })
    expect(startChatAbout).toHaveBeenCalledWith({ ...ctx, selection: 'Read' })

    select(title)
    fireEvent.contextMenu(title)
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Copy card as text' })) })
    expect(copyChatAbout).toHaveBeenCalledWith({ ...ctx, selection: 'Read' })
  })

  it('a word the right-click itself selected (macOS) is not a selection', async () => {
    render(<Card />)
    const title = screen.getByText('Read')
    fireEvent.mouseDown(title, { button: 2 })
    select(title) // WebKit selects the word between mousedown and contextmenu
    fireEvent.contextMenu(title, { clientX: 5, clientY: 5 })
    expect(screen.queryByRole('menuitem', { name: 'Copy' })).toBeNull()
    expect(String(window.getSelection())).toBe('')
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Chat about this' })) })
    expect(startChatAbout).toHaveBeenCalledWith(ctx)
  })

  it('a selection elsewhere on the page is not this card\'s', async () => {
    render(<><p>outside</p><Card /></>)
    select(screen.getByText('outside'))
    fireEvent.contextMenu(screen.getByText('Read'))
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Chat about this' })) })
    expect(startChatAbout).toHaveBeenCalledWith(ctx)
  })

  it('only the innermost card answers a right-click', () => {
    const outer = vi.fn(() => ({ ...ctx, title: 'outer' }))
    render(<section><ChatAbout of={outer} /><Card /></section>)
    fireEvent.contextMenu(screen.getByText('Read'))
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Chat about this' }))
    expect(outer).not.toHaveBeenCalled()
    expect(startChatAbout).toHaveBeenCalledWith(ctx)
  })

  it('a long press opens the menu on the lift, and a moving finger does not', () => {
    vi.useFakeTimers()
    render(<Card />)
    const title = screen.getByText('Read')
    fireEvent.touchStart(title, { touches: [{ clientX: 10, clientY: 10 }] })
    fireEvent.touchMove(title, { touches: [{ clientX: 10, clientY: 60 }] })
    act(() => { vi.advanceTimersByTime(600) })
    fireEvent.touchEnd(title)
    expect(screen.queryByRole('menu')).toBeNull()

    hold(title)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(fireEvent.touchEnd(title)).toBe(false)
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('the menu survives the lift\'s mousedown and click, which do not reach the card', () => {
    vi.useFakeTimers()
    const onCard = vi.fn()
    render(<Card onCard={onCard} />)
    const title = screen.getByText('Read')
    hold(title)
    fireEvent.touchEnd(title)
    fireEvent.mouseDown(title)
    fireEvent.click(title)
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(onCard).not.toHaveBeenCalled()

    // A real press later still closes it.
    act(() => { vi.advanceTimersByTime(500) })
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('a tap after a long press is not swallowed, on the card or on a link in it', () => {
    vi.useFakeTimers()
    const onCard = vi.fn()
    const onLink = vi.fn((e: React.MouseEvent) => e.preventDefault())
    render(<Card onCard={onCard} onLink={onLink} />)
    const title = screen.getByText('Read')
    hold(title)
    fireEvent.touchEnd(title) // no click follows: the browser dropped it
    act(() => { vi.advanceTimersByTime(500) })
    fireEvent.mouseDown(document.body)

    const link = screen.getByText('link')
    fireEvent.touchStart(link, { touches: [{ clientX: 50, clientY: 10 }] })
    fireEvent.touchEnd(link)
    fireEvent.click(link)
    expect(onLink).toHaveBeenCalledTimes(1)

    act(() => { vi.advanceTimersByTime(500) })
    fireEvent.click(title)
    expect(onCard).toHaveBeenCalledTimes(2)
  })

  it('a signed-out session goes to sign-in, not to a toast', async () => {
    startChatAbout.mockRejectedValueOnce(new AuthError())
    render(<Card />)
    fireEvent.contextMenu(screen.getByText('Read'))
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Chat about this' })) })
    expect(chatAboutAuthError).toHaveBeenCalledTimes(1)
  })
})

describe('a Settings pane', () => {
  const TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  it('carries headings, labels and switch states, never fields, code or tool output', async () => {
    render(
      <div className="settings-content">
        <ChatAbout of={(pane) => settingsContext('providers', settingsOutline(pane))} />
        <h2>AI <code>{TOKEN}</code></h2>
        <div className="setting-row">
          <div className="setting-copy"><strong>Codex API key</strong><span>{`Set as ${TOKEN}`}</span></div>
          <div className="setting-control"><input defaultValue={TOKEN} /></div>
        </div>
        <div className="setting-row">
          <div className="setting-copy"><strong>Web search</strong></div>
          <div className="setting-control"><button type="button" role="switch" aria-checked="true" /></div>
        </div>
        <div className="setting-row">
          <div className="setting-copy"><strong>Default model</strong></div>
          <div className="setting-control"><select defaultValue="b"><option value="a">Small</option><option value="b">Large</option></select></div>
        </div>
        <textarea defaultValue={`OPENAI_KEY=${TOKEN}`} />
        <pre>{`$ curl -H "Authorization: Bearer ${TOKEN}"`}</pre>
      </div>,
    )
    fireEvent.contextMenu(screen.getByText('Web search'))
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Chat about this' })) })
    const sent = startChatAbout.mock.calls[0][0] as any
    expect(sent.lines).toEqual(['AI:', '- Codex API key', '- Web search: on', '- Default model: Large'])
    expect(contextMarkdown(sent)).not.toContain('ABCDEFGHIJ')
  })

  it('is not offered on Logs or Connections', () => {
    expect(settingsContext('logs', { items: [{ heading: 'Logs' }] })).toBeNull()
    expect(settingsContext('connections', { items: [{ heading: 'Connections' }] })).toBeNull()
  })
})
