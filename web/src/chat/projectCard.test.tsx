// A project's card (ProjectCard.tsx): what a project's chats share, as T3 Code's
// card at the page's top right, one row per thing, opening under its row. And the
// page itself (ProjectHome): the chats, with the card pinned beside it on desktop
// and in the page on a phone. The bridge is a fake fetch.
import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ProjectCard, { openProjectSection } from './ProjectCard'
import ProjectHome from './ProjectHome'
import { loadProject, loadProjects } from './store'
import { requestLanding } from '../landing'

const ACME = {
  id: 'acme', name: 'Acme', instructions: 'Answer like a colleague.\nShort and concrete.', fileCount: 1, chatCount: 0, createdAt: 0, updatedAt: 0,
  files: [{ id: 'up1', name: 'brief.pdf', mime: 'application/pdf', kind: 'file', size: 2048, url: '/u/up1', source: 'upload', addedAt: 1 }],
  memory: '## Decisions\n- Ship on Fridays\n- Use pnpm\n',
}
const SITE = { id: 'site', name: 'Site', parentId: 'acme', instructions: '', fileCount: 0, chatCount: 0, createdAt: 0, updatedAt: 0, files: [], memory: '' }

let calls: Array<{ method: string; url: string; body: any }>
let phone = false
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(async () => {
  calls = []
  phone = false
  localStorage.clear()
  // jsdom lays out a 0px column, which would start a pinned card folded.
  localStorage.setItem('totem.projectPin.folded', '0')
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as any
  window.matchMedia = ((query: string) => ({ matches: phone && query.includes('max-width'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as any
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input).split('?')[0]
    const method = (init?.method || 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })
    const { files: _a, memory: _b, ...acme } = ACME
    const { files: _c, memory: _d, ...site } = SITE
    if (url === '/api/chat/projects') return json({ projects: [acme, site] })
    if (url === '/api/chat/projects/acme' && method === 'GET') return json({ project: ACME })
    if (url === '/api/chat/projects/site' && method === 'GET') return json({ project: SITE })
    if (url === '/api/chat/projects/acme' && method === 'PATCH') return json({ project: { ...ACME, ...body } })
    if (url === '/api/chat/projects/acme/memory' && method === 'PUT') return json({ memory: body.memory })
    return json({ error: `unrouted ${method} ${url}` }, 404)
  })
  await loadProjects()
  await loadProject('acme')
  await loadProject('site')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('a project’s card', () => {
  it('names what its chats share, one row each, and opens one at a time', async () => {
    const user = userEvent.setup()
    render(<div className="vc"><ProjectCard projectId="acme" mode="pinned" /></div>)
    const card = screen.getByRole('complementary', { name: 'Project: Acme' })
    const row = (name: RegExp) => within(card).getByRole('button', { name })
    expect(row(/^Files/)).toHaveTextContent('1 file')
    expect(row(/^Instructions/)).toHaveTextContent('Answer like a colleague.')
    expect(row(/^Memory/)).toHaveTextContent('2 notes')
    expect(row(/^Model/)).toHaveAttribute('aria-expanded', 'false')

    await user.click(row(/^Instructions/))
    const box = within(card).getByRole('region', { name: 'Instructions' })
    const field = within(box).getByRole('textbox')
    await user.clear(field)
    await user.type(field, 'Be brief.')
    await user.click(within(box).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ instructions: 'Be brief.' }))

    // Opening another row closes the first.
    await user.click(row(/^Files/))
    expect(within(card).queryByRole('region', { name: 'Instructions' })).toBeNull()
    expect(within(card).getByRole('region', { name: 'Files' })).toHaveTextContent('brief.pdf')
  })

  it('folds to its name, and keeps that on this device', async () => {
    const user = userEvent.setup()
    render(<div className="vc"><ProjectCard projectId="acme" mode="pinned" /></div>)
    const card = screen.getByRole('complementary', { name: 'Project: Acme' })
    await user.click(within(card).getByRole('button', { name: 'Fold Acme’s card' }))
    expect(within(card).queryByRole('button', { name: /^Files(?!,)/ })).toBeNull()
    expect(localStorage.getItem('totem.projectPin.folded')).toBe('1')
    await user.click(within(card).getByRole('button', { name: 'Show what Acme’s chats share', expanded: false }))
    expect(within(card).getByRole('button', { name: /^Files(?!,)/ })).toBeVisible()
  })

  it('keeps an unsaved edit while another row is open or the card is folded', async () => {
    const user = userEvent.setup()
    render(<div className="vc"><ProjectCard projectId="acme" mode="pinned" /></div>)
    const card = screen.getByRole('complementary', { name: 'Project: Acme' })
    await user.click(within(card).getByRole('button', { name: /^Memory/ }))
    const field = within(within(card).getByRole('region', { name: 'Memory' })).getByRole('textbox')
    await user.type(field, '- Half a thought')
    await user.click(within(card).getByRole('button', { name: /^Files(?!,)/ }))
    await user.click(within(card).getByRole('button', { name: 'Fold Acme’s card' }))
    await user.click(within(card).getByRole('button', { name: 'Show what Acme’s chats share', expanded: false }))
    await user.click(within(card).getByRole('button', { name: /^Memory/ }))
    expect(within(within(card).getByRole('region', { name: 'Memory' })).getByRole('textbox')).toHaveValue(`${ACME.memory}- Half a thought`)
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('a section asked for long ago opens nothing', () => {
    act(() => openProjectSection('acme', 'memory', Date.now() - 60_000))
    render(<div className="vc"><ProjectCard projectId="acme" mode="pinned" /></div>)
    expect(screen.queryByRole('region', { name: 'Memory' })).toBeNull()
  })

  it('a folder says which project it is in', () => {
    render(<div className="vc"><ProjectCard projectId="site" mode="pinned" /></div>)
    const card = screen.getByRole('complementary', { name: 'Folder: Site' })
    expect(card).toHaveTextContent('in Acme')
    expect(within(card).getByRole('button', { name: /^Memory/ })).toHaveTextContent('Empty')
  })

  it('a section asked for from outside unfolds the card and opens, even before the card is up', async () => {
    localStorage.setItem('totem.projectPin.folded', '1')
    act(() => openProjectSection('acme', 'memory'))
    render(<div className="vc"><ProjectCard projectId="acme" mode="pinned" /></div>)
    const card = screen.getByRole('complementary', { name: 'Project: Acme' })
    expect(await within(card).findByRole('region', { name: 'Memory' })).toBeVisible()
  })
})

describe('a project’s page', () => {
  it('shows its chats, with no tabs; the card is pinned beside it on desktop', () => {
    render(<div className="vc"><ProjectHome projectId="acme" composer={<div>composer</div>} /></div>)
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByText(/No chats yet/)).toBeVisible()
    // ChatView pins the card; the page draws one only when told it is inline.
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('on a phone the card sits in the page under the composer, folded to one row', async () => {
    const user = userEvent.setup()
    render(<div className="vc"><ProjectHome projectId="acme" composer={<div>composer</div>} cardInline /></div>)
    const card = screen.getByRole('complementary', { name: 'Project: Acme' })
    expect(within(card).queryByRole('button', { name: /^Files(?!,)/ })).toBeNull()
    await user.click(within(card).getByRole('button', { name: 'Files, instructions, memory…', expanded: false }))
    expect(within(card).getByRole('button', { name: /^Files(?!,)/ })).toBeVisible()
  })

  it('a search hit on its memory opens that row of the card', async () => {
    act(() => requestLanding('project', 'acme', { section: 'memory' }))
    render(<div className="vc"><ProjectHome projectId="acme" composer={<div>composer</div>} cardInline /></div>)
    const card = screen.getByRole('complementary', { name: 'Project: Acme' })
    expect(await within(card).findByRole('region', { name: 'Memory' })).toBeVisible()
  })
})
