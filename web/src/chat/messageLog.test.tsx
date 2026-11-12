import React, { useState } from 'react'
import { act, render } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ChatMessage } from './types'

// Every render of a message, by id: typing in the composer must render none of
// them, and a streamed token only the live reply (chat/MessageLog.tsx).
const renders: string[] = []
vi.mock('./Message', () => ({
  UserMessage: ({ m }: { m: ChatMessage }) => { renders.push(m.id); return <div>{m.content}</div> },
  AssistantMessage: ({ m }: { m: ChatMessage }) => { renders.push(m.id); return <div>{m.content}</div> },
}))

const { default: MessageLog } = await import('./MessageLog')

const thread: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'first question', createdAt: 1 },
  { id: 'a1', role: 'assistant', content: 'first answer', createdAt: 2, status: 'done' },
  { id: 'u2', role: 'user', content: 'second question', createdAt: 3 },
  { id: 'a2', role: 'assistant', content: 'second', createdAt: 4, status: 'streaming' },
]
const providers: never[] = []
const models = {}

let type: (text: string) => void = () => {}
let stream: (messages: ChatMessage[]) => void = () => {}
/** ChatView's shape: the draft is its own state, beside the log. */
function Chat() {
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState(thread)
  type = setDraft
  stream = setMessages
  const onDiscarded = React.useCallback((text: string) => setDraft(text), [])
  return (
    <>
      <MessageLog threadId="t1" messages={messages} busy activity="Working" provider="claude" providers={providers} models={models} onDiscarded={onDiscarded} />
      <textarea value={draft} readOnly />
    </>
  )
}

beforeEach(() => { renders.length = 0 })

it('renders no message while the owner types', () => {
  render(<Chat />)
  expect(renders).toEqual(['u1', 'a1', 'u2', 'a2'])
  renders.length = 0
  act(() => type('h'))
  act(() => type('he'))
  act(() => type('hello'))
  expect(renders).toEqual([])
})

it('renders only the live reply when a token streams in', () => {
  render(<Chat />)
  renders.length = 0
  act(() => stream([...thread.slice(0, 3), { ...thread[3], content: 'second answer, longer' }]))
  expect(renders).toEqual(['a2'])
})
