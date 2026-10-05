// node --test totems/core.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { costTier, totemRunPrompt, parseRunReply, totemsRule, parseProposals, appendMemoryNote, builderPrompt, parseBuilderReply } from './core.mjs'

const catalog = [
  { provider: 'codex', driver: 'codex', name: 'Codex', models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna' }, { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }] },
  { provider: 'claude', driver: 'claude', name: 'Claude', models: [{ id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' }, { id: 'claude-opus-5-5', name: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }] },
]

test('cost tiers order small, standard and frontier models', () => {
  assert.equal(costTier('gpt-6-luna'), 1)
  assert.equal(costTier('claude-haiku-4-5-20251001'), 1)
  assert.equal(costTier('composer-2.5[fast=true]', 'cursor'), 1)
  assert.equal(costTier('claude-sonnet-5-5'), 2)
  assert.equal(costTier('claude-opus-5-5'), 3)
  assert.equal(costTier('gpt-6.1-sol'), 3)
})

test('a run prompt carries the job, memory path, recent runs and the closing protocol', () => {
  const p = totemRunPrompt({
    totem: { name: 'Listing Watch', prompt: 'Watch the blue jacket listing.', scheduleLabel: 'Every 30 minutes' },
    memory: '- last seen: sold out', memoryPath: '/d/totems/j1/memory.md',
    recentRuns: [{ startedAt: 0, status: 'skipped', preview: 'still sold out' }],
  })
  assert.match(p, /Watch the blue jacket listing\./)
  assert.match(p, /\/d\/totems\/j1\/memory\.md/)
  assert.match(p, /last seen: sold out/)
  assert.match(p, /still sold out/)
  assert.match(p, /NOTIFY: <title/)
  assert.match(p, /no browser in this run/)
})

test('parseRunReply reads NOTIFY and QUIET from the last line, tolerating Markdown', () => {
  assert.deepEqual(parseRunReply('Checked the page.\n**NOTIFY: Jacket is back | Size M in stock at $120.**'), { report: 'Checked the page.', notify: { title: 'Jacket is back', body: 'Size M in stock at $120.' }, quiet: false })
  const q = parseRunReply('Still sold out.\n\nQUIET')
  assert.equal(q.quiet, true)
  assert.equal(q.report, 'Still sold out.')
  assert.equal(q.notify, null)
  const none = parseRunReply('A digest with no closing line.')
  assert.equal(none.quiet, false)
  assert.equal(none.notify, null)
  assert.equal(none.report, 'A digest with no closing line.')
})

test('proposals are pulled out of the text, unknown totems and bad JSON dropped', () => {
  const text = 'Sure, I can have it watch that too.\n\n```totem-proposal\n{"totemId":"job_1","summary":"Also watch the blue one","memoryNote":"Watch the blue colourway too"}\n```\n```totem-proposal\n{"totemId":"job_x","summary":"x","memoryNote":"y"}\n```\n```totem-proposal\nnot json\n```'
  const r = parseProposals(text, new Set(['job_1']))
  assert.equal(r.text, 'Sure, I can have it watch that too.')
  assert.deepEqual(r.proposals, [{ totemId: 'job_1', summary: 'Also watch the blue one', memoryNote: 'Watch the blue colourway too' }])
  assert.equal(parseProposals('```totem-proposal\n{"totemId":"job_1","summary":"nothing to do"}\n```').proposals.length, 0, 'a proposal that changes nothing is dropped')
})

test('totemsRule lists totems and is empty without any', () => {
  assert.equal(totemsRule([]), '')
  assert.match(totemsRule([{ id: 'job_1', name: 'Listing Watch', description: 'Watches a jacket' }]), /job_1: Listing Watch \(Watches a jacket\)/)
})

test('memory notes land under one From chat heading', () => {
  const d = new Date('2026-10-05T12:00:00Z')
  const once = appendMemoryNote('# Notes\n- a', 'watch blue', d)
  assert.match(once, /## From chat\n- 2026-10-05: watch blue/)
  const twice = appendMemoryNote(once, 'and red', d)
  assert.equal(twice.match(/## From chat/g).length, 1)
  assert.match(twice, /- 2026-10-05: and red\n- 2026-10-05: watch blue/)
})

test('the builder prompt lists every account and model with its cost', () => {
  const p = builderPrompt({ description: 'Watch a jacket', catalog, timezone: 'America/Chicago' })
  assert.match(p, /account "codex".*gpt-6-luna \(GPT-6 Luna\) \[cost 1\]/)
  assert.match(p, /claude-opus-5-5 \(Opus 5\.5\) \[cost 3\]/)
  assert.match(p, /America\/Chicago/)
})

test('a builder reply is validated against the catalog and sorted cheapest first', () => {
  const reply = '```json\n' + JSON.stringify({
    name: 'Jacket Watch', summary: 'Tells you when the jacket is back', icon: 'eye', taskType: 'watcher', instructions: 'You watch the jacket page.',
    schedule: { type: 'interval', everyMinutes: 5 }, browser: true, notify: 'agent',
    recommendations: [
      { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', why: 'Reads tricky pages.' },
      { provider: 'codex', model: 'gpt-6-luna', effort: 'low', why: 'Cheap and enough.' },
      { provider: 'codex', model: 'made-up-model', why: 'x' },
      { provider: 'nobody', model: '', why: 'x' },
    ],
    questions: ['Which size?'],
  }) + '\n```'
  const d = parseBuilderReply(reply, { catalog })
  assert.equal(d.name, 'Jacket Watch')
  assert.equal(d.summary, 'Tells you when the jacket is back')
  assert.deepEqual(d.schedule, { type: 'interval', everyMinutes: 15 }, 'never more often than every 15 minutes')
  assert.equal(d.browser, true)
  assert.deepEqual(d.recommendations.map((r) => r.model), ['gpt-6-luna', 'claude-sonnet-5-5'])
  assert.equal(d.recommendations[0].label, 'GPT-6 Luna')
  assert.equal(d.recommendations[0].cost, 1)
  assert.deepEqual(d.questions, ['Which size?'])
})

test('a builder reply with no usable model falls back to the cheapest in the catalog', () => {
  const d = parseBuilderReply('{"name":"Digest","instructions":"Summarise.","schedule":{"type":"daily","time":"25:00"},"recommendations":[]}', { catalog })
  assert.equal(d.recommendations.length, 1)
  assert.equal(d.recommendations[0].cost, 1)
  assert.deepEqual(d.schedule, { type: 'daily', time: '09:00' })
  assert.equal(d.notify, 'agent')
})
