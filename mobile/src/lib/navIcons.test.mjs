// The iPhone app's page glyphs (navIcons.tsx) are the web rail's (web/src/navIcons.tsx):
// the same Lucide icon for every destination, at the same version. This reads both
// files as text, so it runs without either app's node_modules.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path) => readFileSync(join(repo, path), 'utf8')

// { overview: 'layout-dashboard', … } from the imports and the NAV_ICONS table.
function table(source, pkg) {
  const slugOf = {}
  for (const [, name, slug] of source.matchAll(new RegExp(`^import (\\w+) from '${pkg}/icons/([a-z0-9-]+)'`, 'gm'))) slugOf[name] = slug
  const body = source.slice(source.indexOf('export const NAV_ICONS'))
  const rows = {}
  for (const [, id, name] of body.matchAll(/^\s+(\w+): nav\((\w+), '[^']+'\),$/gm)) {
    assert.ok(slugOf[name], `${id} uses ${name}, which is not imported from ${pkg}/icons/<name>`)
    rows[id] = slugOf[name]
  }
  return rows
}

test('the app and the web give every page the same Lucide icon', () => {
  const web = table(read('web/src/navIcons.tsx'), 'lucide-react')
  const app = table(read('mobile/src/lib/navIcons.tsx'), 'lucide-react-native')
  assert.ok(Object.keys(web).length >= 8, 'the web table was not read')
  assert.deepEqual(app, web)
})

test('both apps pin the same Lucide release', () => {
  const web = JSON.parse(read('web/package.json')).dependencies['lucide-react']
  const app = JSON.parse(read('mobile/package.json')).dependencies['lucide-react-native']
  assert.match(web, /^\d+\.\d+\.\d+$/, 'pin an exact version')
  assert.equal(app, web)
})

test('the rail takes every glyph from the table', () => {
  const tabs = read('web/src/App.tsx')
  let seen = 0
  for (const [, id, icon] of tabs.matchAll(/\{ id: '?([\w]+)'?, label: '[^']+', icon: (\w+(?:\.\w+)?) \}/g)) {
    seen++
    if (id === 'totems' || icon === 'TotemsIcon') continue
    assert.match(icon, /^NAV_ICONS\.\w+$/, `the rail's ${id} tab draws ${icon}, not a NAV_ICONS glyph`)
  }
  assert.ok(seen >= 10, `only ${seen} rail tabs were read from App.tsx`)
})
