import test from 'node:test'
import assert from 'node:assert/strict'
import { APPLY_AFTER_AWAY_MS, CHECK_EVERY_MS, safePage, shouldApply, shouldCheck, stillSettled } from './otaPolicy.ts'

const LONG = 3 * 3600_000
const base = { pending: true, awayMs: LONG, held: false, path: '/chat', typing: false }

test('a fetched update is applied on coming back to a page after a long absence', () => {
  assert.equal(shouldApply(base), true)
  assert.equal(shouldApply({ ...base, path: '/', awayMs: APPLY_AFTER_AWAY_MS }), true)
})

test('a quick app switch never reloads the app under him', () => {
  assert.equal(shouldApply({ ...base, awayMs: 5_000 }), false)
  assert.equal(shouldApply({ ...base, awayMs: APPLY_AFTER_AWAY_MS - 1 }), false)
})

test('nothing fetched, or voice or a recording in progress, means no reload', () => {
  assert.equal(shouldApply({ ...base, pending: false }), false)
  assert.equal(shouldApply({ ...base, held: true }), false)
})

test('only the Overview and a chat: any other page, sheet or editor keeps its unsaved edits', () => {
  for (const path of ['/todo/abc', '/goal/edit', '/settings/skills', '/chat/model', '/habit/new', '/journal/123', '/fleet', '/productivity/lists', '/productivity/journal', '/inbox', '/settings']) {
    assert.equal(safePage(path), false, path)
    assert.equal(shouldApply({ ...base, path }), false, path)
  }
})

test('typing holds it off, except in a chat, whose draft is saved as the app leaves', () => {
  assert.equal(shouldApply({ ...base, path: '/', typing: true }), false)
  assert.equal(shouldApply({ ...base, path: '/chat', typing: true }), true)
})

test('a new chat not yet started keeps its place: no reload under it', () => {
  assert.equal(shouldApply({ ...base, newChat: true }), false)
  assert.equal(shouldApply({ ...base, path: '/', newChat: true }), true)
})

test('a push, quick action or link that lands while the return settles wins', () => {
  const calm = { pathBefore: '/chat', pathNow: '/chat', chatBefore: 'a', chatNow: 'a', arrived: false }
  assert.equal(stillSettled(calm), true)
  assert.equal(stillSettled({ ...calm, arrived: true }), false)
  assert.equal(stillSettled({ ...calm, chatNow: 'b' }), false)
  assert.equal(stillSettled({ ...calm, pathNow: '/inbox' }), false)
})

test('checks are spaced out and never stack', () => {
  const now = 1_000_000_000
  assert.equal(shouldCheck({ lastCheckAt: 0, now, busy: false }), true)
  assert.equal(shouldCheck({ lastCheckAt: now - CHECK_EVERY_MS + 1, now, busy: false }), false)
  assert.equal(shouldCheck({ lastCheckAt: now - CHECK_EVERY_MS, now, busy: false }), true)
  assert.equal(shouldCheck({ lastCheckAt: 0, now, busy: true }), false)
})
