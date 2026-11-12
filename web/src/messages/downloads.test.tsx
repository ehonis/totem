import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Thread from './Thread'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('uses tracked downloads for message files and preserves inline media previews', async () => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
    chat: { id: 1, title: 'Workshop', service: 'iMessage', participants: [] }, hasMore: false,
    messages: [{ id: 1, fromMe: false, at: '2026-01-02T12:00:00Z', text: '', reactions: [],
      attachments: [
        { id: 1, name: 'workshop.zip', mime: 'application/zip', bytes: 1024 },
        { id: 2, name: 'agenda.pdf', mime: 'application/pdf', bytes: 512 },
      ],
    }],
  }), { headers: { 'content-type': 'application/json' } }))
  render(<Thread chatId={1} summary={null} narrow={false} onBack={() => {}} onAuthError={() => {}} onChanged={() => {}} />)
  expect(await screen.findByRole('link', { name: /workshop.zip/ })).toHaveAttribute('download', 'workshop.zip')
  expect(screen.getByRole('link', { name: /agenda.pdf/ })).not.toHaveAttribute('download')
})
