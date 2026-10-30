// The places table names files; a rename that forgets it would send the agent to a
// file that is gone. This fails first.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLACES, type Place } from './places'
import { SETTINGS_ABOUT } from './context'
import { buildPath, parseLocation } from '../../router'

// The repository root (under jsdom, import.meta.url is not a file: URL).
const root = `${resolve(__dirname, '../../../..')}/`

describe('places', () => {
  const rows = Object.entries(PLACES as Record<string, Place>)

  it('lists files that exist', () => {
    const missing = rows.flatMap(([id, p]) =>
      [...p.web, ...(p.app || []), ...(p.data || [])].filter((f) => !existsSync(root + f)).map((f) => `${id}: ${f}`))
    expect(missing).toEqual([])
  })

  it('gives every place a route and at least one dashboard file', () => {
    for (const [id, p] of rows) {
      expect(p.route, id).toMatch(/^\/[a-z]/)
      expect(p.web.length, id).toBeGreaterThan(0)
    }
  })

  it('routes to a real page: each route survives the router unchanged', () => {
    for (const [id, p] of rows) {
      const [pathname, hash = ''] = p.route.split('#')
      const loc = { pathname, search: '', hash: hash && `#${hash}` } as Location
      expect(buildPath(parseLocation(loc)), id).toBe(p.route)
    }
  })

  it('has a place for every Settings pane it is offered on, and no others', () => {
    const settings = rows.map(([id]) => id).filter((id) => id.startsWith('settings.'))
    expect(settings.sort()).toEqual(SETTINGS_ABOUT.map((s) => `settings.${s}`).sort())
    for (const sub of SETTINGS_ABOUT) expect(PLACES[`settings.${sub}`].route).toBe(`/settings/${sub}`)
  })

  it('is the same table, and the same serializers, in the iPhone app', () => {
    for (const f of ['places.ts', 'context.ts']) {
      const web = readFileSync(`${root}web/src/chat/about/${f}`, 'utf8')
      const app = readFileSync(`${root}mobile/src/lib/chat/about/${f}`, 'utf8')
      expect(app, f).toBe(web)
    }
  })
})
