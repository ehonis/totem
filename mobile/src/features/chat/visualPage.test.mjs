// A chart drawn in the app (#260): which URL a reply's visual part may load, and
// the shared chart helpers. The WebView's own rules are tested in
// lib/bridgePage.test.mjs. Run with `node --test mobile/src/features/chat/*.test.mjs`
// (also in the root npm test).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { visualPagePath } from './visualPage.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (path) => readFileSync(join(repo, path), 'utf8')

const BASE = 'https://totem.example.com'
const PATH = '/api/chat/uploads/abcDEF12_-?sig=Zm9vYmFyYmF6cXV4'

test('the app reads chart messages with the web’s copy of visuals.ts', () => {
  assert.equal(read('mobile/src/lib/chat/visuals.ts'), read('web/src/chat/visuals.ts'))
})

test('visualPagePath loads only a chart upload on the connected bridge', () => {
  assert.equal(visualPagePath(PATH, BASE), PATH)
  assert.equal(visualPagePath(PATH, 'http://100.64.0.1:8787'), PATH)
  assert.equal(visualPagePath('/api/chat/uploads/abcDEF12_-', BASE), '/api/chat/uploads/abcDEF12_-')
  for (const bad of [
    undefined, '', 'https://evil.example/api/chat/uploads/abcDEF12_-?sig=x', `${BASE}${PATH}`, '//evil.example/api/chat/uploads/abcDEF12_-',
    '/api/chat/uploads/abcDEF12_-?sig=x&next=https://evil.example', '/api/chat/uploads/../auth/status', '/api/todos',
    '/api/chat/uploads/short?sig=x', `${PATH}#frag`, '/api/chat/uploads/abcDEF12_-?sig=a b',
  ]) assert.equal(visualPagePath(bad, BASE), null, String(bad))
  assert.equal(visualPagePath(PATH, ''), null)
  assert.equal(visualPagePath(PATH, 'javascript:alert(1)'), null)
})
