import { describe, it, expect } from 'vitest'
import { allAnswers, allFiles, answerPreview, draftAnswer, isAskTool, pendingQuestions, pick } from './questions'
import { applyEvent } from './reduce'
import type { ChatMessage, Question, QuestionsPart } from './types'

const single: Question = { id: 'q1', header: 'Colour', question: 'Colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }
const multi: Question = { id: 'q2', header: 'Sizes', question: 'Sizes?', options: [{ label: 'S' }, { label: 'M' }], multiSelect: true }
const part = (status: QuestionsPart['status'], id = 'p1'): QuestionsPart => ({ type: 'questions', id, questions: [single, multi], status })
const reply = (id: string, parts: QuestionsPart[]): ChatMessage => ({ id, role: 'assistant', content: '', createdAt: 0, parts })

describe('questions', () => {
  it('finds the oldest questions still waiting', () => {
    const t = { messages: [reply('a', [part('answered', 'old')]), reply('b', [part('pending', 'mid')]), reply('c', [part('pending', 'new')])] }
    expect(pendingQuestions(t)?.part.id).toBe('mid')
    expect(pendingQuestions({ messages: [reply('a', [part('dismissed')])] })).toBeNull()
  })

  it('typed words win over a pick, and picking clears them', () => {
    expect(draftAnswer(single, { selected: ['Red'], custom: '  teal ' })).toEqual(['teal'])
    expect(pick(single, { selected: [], custom: 'teal' }, 'Blue')).toEqual({ selected: ['Blue'], custom: '' })
    expect(pick(single, { selected: ['Red'], custom: '' }, 'Blue').selected).toEqual(['Blue'])
  })

  it('multi-select toggles', () => {
    const once = pick(multi, undefined, 'S')
    const twice = pick(multi, once, 'M')
    expect(twice.selected).toEqual(['S', 'M'])
    expect(pick(multi, twice, 'S').selected).toEqual(['M'])
  })

  it('submits only when every question has an answer', () => {
    expect(allAnswers([single, multi], { q1: { selected: ['Red'], custom: '' } })).toBeNull()
    expect(allAnswers([single, multi], { q1: { selected: ['Red'], custom: '' }, q2: { selected: ['S', 'M'], custom: '' } })).toEqual({ q1: ['Red'], q2: ['S', 'M'] })
  })

  it('a file answers a question, with or without words', () => {
    const photo = { id: 'upload-123', name: 'room.jpg', mime: 'image/jpeg', size: 10, kind: 'image' as const }
    const drafts = { q1: { selected: [], custom: '', files: [photo] }, q2: { selected: ['S'], custom: '' } }
    expect(allAnswers([single, multi], drafts)).toEqual({ q1: [], q2: ['S'] })
    expect(allFiles(drafts)).toEqual({ q1: [photo] })
    expect(pick(single, drafts.q1, 'Red')).toEqual({ selected: ['Red'], custom: '', files: [photo] })
    expect(answerPreview({ ...part('answered'), answers: { q1: [], q2: ['S'] }, attachments: { q1: [photo] } })).toBe('an image · S')
  })

  it('previews answers and recognises the tool through the gateway', () => {
    expect(answerPreview({ ...part('answered'), answers: { q1: ['Red'], q2: ['S', 'M'] } })).toBe('Red · S, M')
    expect(isAskTool('ask_questions')).toBe(true)
    expect(isAskTool('browser__ask_questions')).toBe(true)
    expect(isAskTool('ask')).toBe(false)
  })

  it('folds the questions event like the bridge does', () => {
    let m = reply('a', [])
    m = applyEvent(m, { type: 'questions', questions: part('pending') })
    m = applyEvent(m, { type: 'questions', questions: { id: 'p1', status: 'answered', answers: { q1: ['Red'] } } })
    expect(m.parts).toHaveLength(1)
    expect(m.parts?.[0]).toMatchObject({ type: 'questions', status: 'answered', answers: { q1: ['Red'] } })
  })
})
