// Run with: node --test logs/approval-proposals.test.mjs
//
// One reading of a proposal, as the approval checks see it. A failure can mean a
// hold that a space defeats, a hidden character in a field nobody screened, or a
// proposal approved after it changed under the owner.
import test from 'node:test'
import assert from 'node:assert/strict'
import { proposalShape, proposalDigest, heldMessage } from './approval-proposals.mjs'
import { hiddenControlReason } from './approval-hardening.mjs'

const email = (over = {}) => ({
  account: 'work', from: 'Me <me@example.com>',
  to: [{ name: 'Sam', email: 'Sam@Example.com' }], cc: [], bcc: [],
  subject: 'Plans', body: 'See you at 6.', ...over,
})
const item = (kind, meta = {}, title = 'A proposal') => ({ id: 'P1', kind, title, meta })

test('a task\'s fingerprint is the same whatever destination label the list put on it', () => {
  // readInboxItems shows "Totem task → Ventures"; the parsed line says "Totem task". Neither is used.
  const parsed = { ...item('todo', { project: 'Ventures' }, 'Ship it'), destination: 'Totem task' }
  const listed = { ...parsed, destination: 'Totem task → Ventures' }
  assert.equal(proposalShape(parsed, null).fingerprint, proposalShape(listed, null).fingerprint)
  assert.notEqual(proposalShape(parsed, null).fingerprint, proposalShape(item('todo', { project: 'Personal' }, 'Ship it'), null).fingerprint)
})

test('an email\'s fingerprint is its account, recipients and words, with case and whitespace folded', () => {
  const a = proposalShape(item('email'), email()).fingerprint
  assert.equal(proposalShape({ ...item('email'), id: 'P9', title: 'Other title' }, email({ body: '  See you  at 6.\n', to: [{ email: 'sam@example.com' }] })).fingerprint, a)
  assert.notEqual(proposalShape(item('email'), email({ body: 'See you at 7.' })).fingerprint, a)
  assert.notEqual(proposalShape(item('email'), email({ to: [{ email: 'alex@example.com' }] })).fingerprint, a)
})

test('a command\'s fingerprint is its text and directory, read through the real reader (any .sh path)', () => {
  const a = proposalShape(item('command', { command: 'notes/x.sh', cwd: '~/w' }), 'touch a').fingerprint
  assert.equal(proposalShape(item('command', { command: 'inbox-prompts/P2.sh', cwd: '~/w' }), 'touch a').fingerprint, a)
  assert.notEqual(proposalShape(item('command', { command: 'notes/x.sh', cwd: '~/w' }), 'touch b').fingerprint, a)
  assert.notEqual(proposalShape(item('command', { command: 'notes/x.sh', cwd: '~/w' }), '').fingerprint, a)
})

test('an issue\'s fingerprint leaves out the provenance line, which names the inbox id', () => {
  const issue = (id) => ({ repo: 'o/r', title: 'Bug', labels: ['bug'], body: `Steps\n\n---\n_Staged by Totem as inbox ${id} · source: mcp._` })
  assert.equal(proposalShape(item('github'), issue('P1')).fingerprint, proposalShape(item('github'), issue('P7')).fingerprint)
})

test('every shown or sent field is screened: recipient names, the quoted message, prompt and labels', () => {
  const RLO = '‮'
  assert.ok(hiddenControlReason(proposalShape(item('email'), email({ to: [{ name: `Sam${RLO}`, email: 'sam@example.com' }] })).parts))
  assert.ok(hiddenControlReason(proposalShape(item('email'), email({ inReplyToMessage: { from: 'x', snippet: `hi${RLO}` } })).parts))
  assert.ok(hiddenControlReason(proposalShape(item('prompt'), { provider: 'codex', promptText: `do${RLO}it` }).parts))
  assert.ok(hiddenControlReason(proposalShape(item('github'), { repo: 'o/r', title: 'x', labels: [`b${RLO}`], body: '' }).parts))
  assert.ok(hiddenControlReason(proposalShape(item('todo', { why: `w${RLO}` }), null).parts))
  assert.equal(hiddenControlReason(proposalShape(item('email'), email()).parts), null)
})

test('the digest changes with anything the accept would use, and nothing else', () => {
  const a = proposalDigest(item('command', { command: 'x.sh' }), 'touch benign')
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.equal(proposalDigest(item('command', { command: 'x.sh' }), 'touch benign'), a)
  // The staged file swapped between display and accept.
  assert.notEqual(proposalDigest(item('command', { command: 'x.sh' }), 'touch swapped'), a)
  assert.notEqual(proposalDigest(item('command', { command: 'y.sh' }), 'touch benign'), a)
  assert.notEqual(proposalDigest(item('email'), email()), proposalDigest(item('email'), email({ to: [{ name: 'Someone else', email: 'Sam@Example.com' }] })))
})

test('a held accept says which denial and how to lift it', () => {
  assert.match(heldMessage({ id: 'P12', deniedAt: '2026-10-29T10:00:00.000Z' }), /P12 on 2026-10-29.*Show anyway/)
})

test('a LinkedIn card is the same card for its target and words; its excerpt and draft are screened', () => {
  const RLO = '\u202e'
  const card = (over = {}) => ({ action: 'comment', targetUrl: 'https://www.linkedin.com/in/sam/', authorName: 'Sam', postExcerpt: 'We shipped.', draftText: 'Congrats!', reason: 'A friend', ...over })
  const a = proposalShape(item('linkedin'), card()).fingerprint
  assert.equal(proposalShape({ ...item('linkedin'), id: 'P9' }, card({ draftText: ' Congrats! ', reason: 'Other words' })).fingerprint, a)
  assert.notEqual(proposalShape(item('linkedin'), card({ draftText: 'Nice one' })).fingerprint, a)
  assert.notEqual(proposalShape(item('linkedin'), card({ targetUrl: 'https://www.linkedin.com/in/alex/' })).fingerprint, a)
  assert.ok(hiddenControlReason(proposalShape(item('linkedin'), card({ draftText: `Congrats${RLO}` })).parts))
  assert.ok(hiddenControlReason(proposalShape(item('linkedin'), card({ postExcerpt: `We${RLO} shipped` })).parts))
})
