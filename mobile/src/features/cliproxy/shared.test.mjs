// The CLIProxy page's graphs read the web's pool model, layout and card rules
// (web/src/cliproxy/pool/), copied byte for byte to mobile/src/lib/cliproxy/pool/,
// and the web's usagePools.ts, copied to mobile/src/lib/usagePools.ts. Their
// behaviour is tested once, on the web (web/src/cliproxy/pool/*.test.ts); this
// file checks the copies have not drifted and carry nothing of the web.
// Run with `node --test mobile/src/features/cliproxy/*.test.mjs` (also in the root npm test).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (path) => readFileSync(join(repo, path), 'utf8')

const POOL = ['poolModel', 'poolLinked', 'poolMerge', 'poolInputs', 'poolFormat', 'poolText', 'poolSettings', 'poolZoom', 'poolChartLayout', 'poolCards']

test('every pool file the app reads is the web’s, byte for byte', () => {
  for (const name of POOL) {
    const web = `web/src/cliproxy/pool/${name}.ts`
    const app = `mobile/src/lib/cliproxy/pool/${name}.ts`
    assert.equal(read(app), read(web), `${app} has drifted from ${web}: copy it again`)
  }
  assert.equal(read('mobile/src/lib/usagePools.ts'), read('web/src/usagePools.ts'), 'mobile/src/lib/usagePools.ts has drifted from web/src/usagePools.ts')
  // The chart port's licence travels with it.
  assert.equal(read('mobile/src/lib/cliproxy/pool/LICENSE'), read('web/src/cliproxy/pool/LICENSE'))
})

test('the app’s pool folder holds only those copies', () => {
  const files = readdirSync(join(repo, 'mobile/src/lib/cliproxy/pool')).sort()
  assert.deepEqual(files, [...POOL.map((n) => `${n}.ts`), 'LICENSE'].sort())
})

test('the copies import nothing of React, the DOM or the web’s components (the app typechecks them as React Native)', () => {
  for (const name of POOL) {
    const source = read(`web/src/cliproxy/pool/${name}.ts`)
    for (const m of source.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[1]
      // Siblings, the page's types (../api, which the app ports) and usagePools.
      assert.ok(/^\.\/pool\w+$/.test(spec) || spec === '../api' || spec === '../../usagePools', `${name}.ts imports ${spec}`)
    }
    assert.doesNotMatch(source, /\bdocument\.\w|\bimport\s*\(|\brequire\s*\(/, `${name}.ts reaches for the browser or loads code on the fly`)
  }
})
