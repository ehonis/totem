import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { UserMessage } from './Message'
import QueuedMessages from './QueuedMessages'
import type { Attachment, ChatMessage } from './types'

// A sent message draws the attachments it names as chips, from its own
// attachments; anything else it names is drawn as unavailable.

afterEach(cleanup)

const img: Attachment = { id: 'a1b2c3d4e5f6a7b8', name: 'image.png', mime: 'image/png', size: 852_992, kind: 'image', url: '/api/chat/uploads/a1b2c3d4e5f6a7b8?sig=x' }
const doc: Attachment = { id: 'f0e1d2c3b4a59687', name: 'notes.pdf', mime: 'application/pdf', size: 2048, kind: 'file', url: '/api/chat/uploads/f0e1d2c3b4a59687?sig=y' }
const text = `look ![image.png](totem-ref://upload/${img.id}) and [notes.pdf](totem-ref://upload/${doc.id}), not [old.png](totem-ref://upload/0123456789abcdef)`
const message: ChatMessage = { id: 'm1', role: 'user', content: text, createdAt: 0, attachments: [img, doc] }

describe('a sent message with chips', () => {
  it('draws each named attachment inline with its size, and an unknown id as unavailable', () => {
    const { container } = render(<UserMessage m={message} canEdit={false} onEdit={() => {}} />)
    const bubble = container.querySelector('.vc-bubble')!
    expect(bubble.textContent).toBe('look image.png833 KB and notes.pdf2 KB, not old.pngnot attached')
    expect(bubble.querySelector('.vc-ref.image img')?.getAttribute('src')).toBe(img.url)
    expect(bubble.querySelector('.vc-ref.file')).not.toBeNull()
    const gone = bubble.querySelector('.vc-ref.gone')!
    expect(gone.textContent).toBe('old.pngnot attached')
    expect(gone.getAttribute('title')).toBe('This file was not sent with this message, so the agent did not get it.')
    expect(gone.tagName).toBe('SPAN')
    expect(bubble.textContent).not.toContain('totem-ref')
  })

  it('opens an image chip in the lightbox', () => {
    render(<UserMessage m={message} canEdit={false} onEdit={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Image, image.png, 833 KB' }))
    expect(screen.getByRole('dialog', { name: 'image.png' })).toBeTruthy()
  })

  it('copies the words with plain names', () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<UserMessage m={message} canEdit={false} onEdit={() => {}} />)
    fireEvent.click(screen.getByTitle('Copy'))
    expect(writeText).toHaveBeenCalledWith('look image.png and notes.pdf, not old.png')
  })

  it('draws them in a queued message too', () => {
    const { container } = render(
      <QueuedMessages queue={[{ id: 'q1', text, attachments: [img, doc], createdAt: 0 }]} canSteer editingId={null}
        onEdit={() => {}} onCancelEdit={() => {}} onSteer={() => {}} onRemove={() => {}} onMove={() => {}} />,
    )
    expect(container.querySelectorAll('.vc-queue-text .vc-ref')).toHaveLength(3)
    expect(container.querySelector('.vc-queue-content')?.getAttribute('title')).toBe('look image.png and notes.pdf, not old.png')
  })
})
