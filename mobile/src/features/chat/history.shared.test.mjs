// A chat's history (summaries, windows, "Load earlier") is one copy shared with
// the web: web/src/chat/history.ts, tested there (history.test.ts) and mirrored
// byte for byte to mobile/src/lib/chat/history.ts. This checks the copy has not
// drifted. Run with `node --test mobile/src/features/chat/*.test.mjs`.
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
