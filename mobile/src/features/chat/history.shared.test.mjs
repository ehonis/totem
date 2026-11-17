// Chat files shared with the web, mirrored byte for byte into mobile/src/lib/chat/:
// a chat's history (summaries, windows, "Load earlier"; web/src/chat/history.ts,
// tested by history.test.ts) and what a chat waits on the owner for
// (web/src/chat/attention.ts, tested by attention.test.ts). This checks the copies
// have not drifted. Run with `node --test mobile/src/features/chat/*.test.mjs`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (path) => readFileSync(join(repo, path), 'utf8')

test('the chat history file is the web’s, byte for byte', () => {
  assert.equal(read('mobile/src/lib/chat/history.ts'), read('web/src/chat/history.ts'), 'mobile/src/lib/chat/history.ts has drifted from web/src/chat/history.ts')
})

test('what a chat waits on the owner for is the web’s, byte for byte', () => {
  assert.equal(read('mobile/src/lib/chat/attention.ts'), read('web/src/chat/attention.ts'), 'mobile/src/lib/chat/attention.ts has drifted from web/src/chat/attention.ts')
})
