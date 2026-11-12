// Every known token shape (chat/redact.corpus.mjs, the corpus the bridge's test runs
// too), through every serializer that carries text the owner typed or a connector
// supplied, and into the file name. The shapes are built at runtime from pieces, so
// no literal in the repository looks like a credential.
import { describe, expect, it } from 'vitest'
import { ORDINARY, fill, shapes } from '../../../../chat/redact.corpus.mjs'
import {
  contextFileName, contextMarkdown, devRepoContext, fleetDeviceContext, goalContext, settingsContext,
  tasksContext, todoContext, type ChatContext,
} from './context'
import { PLACES, type PlaceId } from './places'

const AT = new Date(2026, 9, 30, 9, 5)
const SHAPES: [string, string, string[]][] = shapes()

const fleet = (id: string) => fleetDeviceContext({
  id, name: 'm', os: null, online: false, lastSeen: null, bootedAt: null,
  uptime: { pct24h: null, pct7d: null, pct30d: null }, health: { level: 'ok', issues: [] }, now: null,
  energy: { todayCost: null, monthCost: null, projectedMonthCost: null },
})
const repo = (name: string, pr: Partial<{ title: string; sha: string }> = {}) => devRepoContext({
  repo: name, aiReview: null, ci: [], runners: [],
  prs: pr.title || pr.sha ? [{ number: 7, title: pr.title || 'Fix', draft: false, checks: 'passing', claude: 'none', url: 'https://github.com/o/r/pull/7', sha: pr.sha }] : [],
})

// Each serializer with the token where the owner or a connector puts text.
const CARRIERS: [string, (t: string) => ChatContext][] = [
  ['task title', (t) => tasksContext([{ content: `Rotate ${t}` }], { open: 1, overdue: 0 })],
  ['task note', (t) => todoContext({ id: 't1', title: 'Rotate keys', notes: [{ body: `new one is ${t}`, createdAt: '2026-10-01' }] })],
  ['goal note', (t) => goalContext({ title: 'Ship', notes: `deploy with ${t} tonight` })],
  ['fleet id', (t) => fleet(`box ${t}`)],
  ['repo name', (t) => repo(`o/${t}`)],
  ['pull request title', (t) => repo('o/r', { title: `Use ${t}` })],
  ['settings select', (t) => settingsContext('providers', { items: [{ label: 'Model', state: t }] })!],
]

// The slug is lower-case, dashed and at most 50 characters: look for each secret's start.
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 8)

describe('redaction in "Chat about this"', () => {
  for (const [shape, text, leaks] of SHAPES) {
    for (const [carrier, make] of CARRIERS) {
      it(`${shape} in a ${carrier}`, () => {
        const md = contextMarkdown(make(text), AT)
        for (const leak of leaks) {
          expect(md, `${shape} in ${carrier}`).not.toContain(leak)
          // Encoded or not: a fleet id is also the route.
          expect(md, `${shape} in ${carrier}`).not.toContain(encodeURIComponent(leak))
        }
      })
    }
    it(`${shape} in the file name`, () => {
      const name = contextFileName({ place: 'todos', title: `Task: ${text}`, lines: [] })
      for (const leak of leaks) if (slug(leak).length >= 6) expect(name).not.toContain(slug(leak))
    })
  }

  it('redacts before cutting, so a token at the edge leaves no prefix', () => {
    const [, jwt, parts] = SHAPES.find(([name]) => name === 'jwt')!
    const md = contextMarkdown(settingsContext('providers', { items: [{ label: 'Model', state: `${'x'.repeat(40)} ${jwt}` }] })!, AT)
    for (const part of parts) expect(md).not.toContain(part.slice(0, 12))
    const [, key] = SHAPES[0]
    expect(contextMarkdown(tasksContext([{ content: `${'y'.repeat(100)} ${key}` }], { open: 1, overdue: 0 }), AT)).not.toContain(key.slice(0, 12))
  })

  it('an encoded fleet id hides nothing in the route, and an encoded & cannot split a secret', () => {
    const secret = fill(24, 12)
    const md = contextMarkdown(fleet(`api_token=${secret}`), AT)
    expect(md).toContain('/fleet#api_token=[redacted]')
    expect(md).not.toContain(secret)
    expect(md).not.toContain('%3D')

    const [a, b] = [fill(6, 15), fill(6, 16)]
    const split = contextMarkdown({ place: 'fleet', route: `/fleet#x?token=${a}%26${b}`, title: 'x', lines: [] }, AT)
    expect(split).not.toContain(a)
    expect(split).not.toContain(b)
  })

  it('a Dev card keeps its commit SHA, and every footer keeps its file paths', () => {
    const sha = '0123456789abcdef'.repeat(3).slice(0, 40)
    expect(contextMarkdown(repo('o/r', { sha }), AT)).toContain(`head ${sha}`)
    for (const place of Object.keys(PLACES) as PlaceId[]) {
      const md = contextMarkdown({ place, title: 't', lines: [] }, AT)
      expect(md, place).not.toContain('redacted')
    }
  })

  it('leaves ordinary card text alone', () => {
    for (const text of ORDINARY) {
      const md = contextMarkdown(todoContext({ id: 't1', title: 'Card', description: text }), AT)
      expect(md, text).toContain(`Description: ${text}`)
    }
  })
})
