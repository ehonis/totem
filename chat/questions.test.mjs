import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeQuestions, normalizeAnswers, attachedIds, answersForAgent, answersMessage, createQuestionWaits, createHolds, holdableTimeout, ASK_TOOL_DESCRIPTOR,
} from './questions.mjs'
import { applyEvent } from './turn.mjs'
import { normalizePart } from './store.mjs'

test('there is no cap on questions or options', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ question: `Question ${i}?`, options: Array.from({ length: 7 }, (_, k) => ({ label: `Option ${k}` })) }))
  const qs = normalizeQuestions({ questions: many })
  assert.equal(qs.length, 12)
  assert.equal(qs[11].options.length, 7)
  assert.equal(ASK_TOOL_DESCRIPTOR.inputSchema.properties.questions.maxItems, undefined)
})

test('questions are checked and given ids and headers', () => {
  const [a, b] = normalizeQuestions({ questions: [
    { question: 'Which database?', header: 'Database', options: [{ label: 'Postgres', description: 'Postgres' }, 'SQLite'], multiSelect: true },
    { question: 'Anything else?' },
  ] })
  assert.deepEqual(a, { id: 'q1', header: 'Database', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multiSelect: true })
  assert.deepEqual(b, { id: 'q2', header: 'Question 2', question: 'Anything else?', options: [] })
  assert.throws(() => normalizeQuestions({ questions: [] }), /non-empty/)
  assert.throws(() => normalizeQuestions({ questions: [{ header: 'x' }] }), /no text/)
})

test('every question needs an answer, and single-select keeps one', () => {
  const qs = normalizeQuestions({ questions: [{ question: 'One?', options: ['a', 'b'] }, { question: 'Many?', options: ['x', 'y'], multiSelect: true }] })
  assert.deepEqual(normalizeAnswers(qs, { q1: ['a', 'b'], q2: ['x', 'y'] }), { q1: ['a'], q2: ['x', 'y'] })
  assert.deepEqual(normalizeAnswers(qs, { q1: 'my own words', q2: ['y'] }), { q1: ['my own words'], q2: ['y'] })
  assert.throws(() => normalizeAnswers(qs, { q1: ['a'] }), /answer "Question 2" first/)
})

test('answers read as question and answer, for the tool and as a message', () => {
  const qs = normalizeQuestions({ questions: [{ question: 'Colour?' }, { question: 'Sizes?', options: ['S', 'M'], multiSelect: true }] })
  const answers = { q1: ['purple'], q2: ['S', 'M'] }
  assert.match(answersForAgent(qs, answers), /Q: Colour\?\nA: purple\n\nQ: Sizes\?\nA: S, M/)
  assert.equal(answersMessage(qs, answers), 'Answers to your questions:\n\nColour?\npurple\n\nSizes?\nS, M')
})

test('an image can answer a question, with or without words', () => {
  const qs = normalizeQuestions({ questions: [{ question: 'Which room?', options: ['Kitchen', 'Bath'] }, { question: 'Anything else?' }] })
  const valid = (id) => /^[A-Za-z0-9_-]{8,64}$/.test(id)
  const attached = attachedIds(qs, { q1: ['upload-123', '../etc'], q9: ['upload-999'] }, valid)
  assert.deepEqual(attached, { q1: ['upload-123'] })
  assert.deepEqual(normalizeAnswers(qs, { q2: ['no'] }, attached), { q1: [], q2: ['no'] })
  assert.throws(() => normalizeAnswers(qs, { q1: ['Kitchen'] }, attached), /answer "Question 2" first/)
  const files = { q1: [{ name: 'room.jpg', kind: 'image', mime: 'image/jpeg', size: 2048, path: '/data/uploads/room.jpg' }] }
  const forAgent = answersForAgent(qs, { q1: [], q2: ['no'] }, files)
  assert.match(forAgent, /Q: Which room\?\nA: \(answered with the attachment below\)\n  Attached image, room.jpg \(2 KB\): \/data\/uploads\/room.jpg/)
  assert.match(forAgent, /Open the attached files/)
  assert.equal(answersMessage(qs, { q1: ['Kitchen'], q2: ['no'] }, files), 'Answers to your questions:\n\nWhich room?\nKitchen [attached: room.jpg]\n\nAnything else?\nno')
})

test('a live wait resolves with the answers, a dismissal, or the call going away', async () => {
  const waits = createQuestionWaits()
  const one = waits.wait('p1', 't1')
  assert.deepEqual(waits.pending('t1'), ['p1'])
  assert.equal(waits.answer('p1', { q1: ['a'] }), true)
  assert.deepEqual(await one, { answers: { q1: ['a'] }, files: {} })
  assert.equal(waits.answer('p1', {}), false, 'answered once only')

  const two = waits.wait('p2', 't1')
  assert.equal(waits.dismiss('p2'), true)
  assert.deepEqual(await two, { dismissed: true })

  const gone = new AbortController()
  const three = waits.wait('p3', 't1', gone.signal)
  gone.abort()
  assert.deepEqual(await three, { gone: true })
  assert.equal(waits.live('p3'), false)
})

test('the run clock stops while a question is held', async () => {
  const holds = createHolds()
  let fired = 0
  const clear = holdableTimeout(60, () => { fired += 1 }, holds)
  const release = holds.hold()
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(fired, 0, 'held: no timeout')
  release()
  release() // twice is harmless
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(fired, 1, 'released: the time left runs out')
  clear()
})

test('the questions part folds in and survives a save', () => {
  const msg = { role: 'assistant', content: '', parts: [] }
  const questions = normalizeQuestions({ questions: [{ question: 'Colour?', options: ['red', 'blue'] }] })
  applyEvent(msg, { type: 'questions', questions: { id: 'abc', questions, status: 'pending', askedAt: 5 } })
  applyEvent(msg, { type: 'questions', questions: { id: 'abc', status: 'answered', answers: { q1: ['blue'] }, answeredAt: 9 } })
  assert.equal(msg.parts.length, 1)
  const saved = normalizePart(msg.parts[0])
  assert.deepEqual(saved, { type: 'questions', id: 'abc', questions, status: 'answered', askedAt: 5, answers: { q1: ['blue'] }, answeredAt: 9 })
  const photo = { id: 'upload-123', name: 'room.jpg', mime: 'image/jpeg', size: 10, kind: 'image', url: '/signed', path: '/secret' }
  const withPhoto = normalizePart({ ...msg.parts[0], attachments: { q1: [photo], q7: [photo] } })
  assert.deepEqual(withPhoto.attachments, { q1: [{ id: 'upload-123', name: 'room.jpg', mime: 'image/jpeg', size: 10, kind: 'image' }] })
})
