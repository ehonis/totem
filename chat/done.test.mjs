import { test } from 'node:test'
import assert from 'node:assert/strict'
import { doneResult, DONE_TOOL_DESCRIPTOR, DONE_RULES } from './done.mjs'

test('mark_chat_done tells an agent with no reply text yet that the answer is still owed', () => {
  const owed = doneResult({ answered: false })
  assert.match(owed, /has not seen any answer/)
  assert.match(owed, /thinking is never shown/)
  assert.match(owed, /Write your complete answer/)
  assert.match(owed, /Do not mention/)
  const after = doneResult({ answered: true })
  assert.match(after, /never your thinking/)
  assert.doesNotMatch(after, /has not seen any answer/)
  assert.equal(doneResult(), after)
})

test('mark_chat_done is called before the answer, never instead of it', () => {
  assert.match(DONE_TOOL_DESCRIPTOR.description, /before you write your answer/)
  assert.match(DONE_TOOL_DESCRIPTOR.description, /never your thinking/)
  assert.match(DONE_RULES, /before you write your answer/)
  assert.doesNotMatch(DONE_TOOL_DESCRIPTOR.description, /write your reply as usual/)
})
