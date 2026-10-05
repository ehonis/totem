import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HELPER = pathToFileURL(join(import.meta.dirname, 'is-entry.mjs')).href

function run(file) {
  return execFileSync(process.execPath, [file], { encoding: 'utf8' }).trim()
}

test('a script is its own entry whether run directly or through a symlinked folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'is-entry-'))
  try {
    mkdirSync(join(root, 'real'))
    writeFileSync(join(root, 'real', 'main.mjs'),
      `import { isEntry } from ${JSON.stringify(HELPER)}\nconsole.log(isEntry(import.meta.url))\n`)
    writeFileSync(join(root, 'real', 'importer.mjs'),
      `import { isEntry } from ${JSON.stringify(HELPER)}\nimport './main.mjs'\n`)
    symlinkSync(join(root, 'real'), join(root, 'linked'))

    assert.equal(run(join(root, 'real', 'main.mjs')), 'true')
    assert.equal(run(join(root, 'linked', 'main.mjs')), 'true')
    assert.equal(run(join(root, 'real', 'importer.mjs')), 'false')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
