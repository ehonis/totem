// The saved drafts' logic is shared with the web (#296): web/src/chat/drafts.ts (the
// store), draftsShared.ts (what both clients do with it) and refs.ts (file references,
// which a draft's preview reads), mirrored byte for byte to mobile/src/lib/chat/.
// Their behaviour is tested once, on the web (drafts.test.ts, draftsShared.test.ts,
// refs.test.ts); this checks the copies have not drifted and still load in node with
// nothing from React Native or the DOM.
// Run with `node --test mobile/src/features/chat/*.test.mjs` (also in the root npm test).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (path) => readFileSync(join(repo, path), 'utf8')
// What each shared file may import: its siblings only, as `.ts` so node loads them.
const SHARED = { 'drafts.ts': ['./types', './refs.ts'], 'draftsShared.ts': ['./types', './drafts.ts'], 'refs.ts': [] }

for (const [name, allowed] of Object.entries(SHARED)) {
  test(`${name} is the web’s, byte for byte`, () => {
    assert.equal(read(`mobile/src/lib/chat/${name}`), read(`web/src/chat/${name}`), `mobile/src/lib/chat/${name} has drifted from web/src/chat/${name}`)
  })

  test(`${name} imports nothing but its siblings`, async () => {
    const source = read(`web/src/chat/${name}`)
    for (const [, what, from] of source.matchAll(/^\s*(?:import|export)\b([^'"]*?)from\s+['"]([^'"]+)['"]/gm)) {
      assert.ok(allowed.includes(from), `${name} imports ${from}`)
      if (from === './types') assert.match(what, /^\s*type\b/, 'only types from ./types, so the copy loads without the app')
    }
    assert.ok(await import(`../../lib/chat/${name}`))
  })
}
