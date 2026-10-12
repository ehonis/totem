// node --test totems/core.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { costTier, totemRunPrompt, parseRunReply, totemsRule, parseProposals, appendMemoryNote, builderPrompt, parseBuilderReply, askableTotem, normalizeMembers, totemsChatRule, totemAskPrompt } from './core.mjs'

const catalog = [
  { provider: 'codex', driver: 'codex', name: 'Codex', models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna' }, { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }] },
  { provider: 'claude', driver: 'claude', name: 'Claude', models: [{ id: 'claude-haiku-5-5', name: 'Haiku 5.5', note: 'Fastest and cheapest.' }, { id: 'claude-opus-5-5', name: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }] },
]

test('cost tiers order small, standard and frontier models', () => {
  assert.equal(costTier('gpt-6-luna'), 1)
  assert.equal(costTier('claude-haiku-5-5'), 1)
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
  assert.match(p, /claude-haiku-5-5 \(Haiku 5\.5\) \[cost 1\] — Fastest and cheapest\./)
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

test('a run its watch started says what changed; a hand-started watcher is told to check anyway', () => {
  const totem = { name: 'Deployer', prompt: 'Deploy bushido.', trigger: { type: 'watch' }, scheduleLabel: 'When main changes in o/r (checked every 2 minutes)' }
  const woke = totemRunPrompt({ totem, trigger: 'watch', event: 'main in o/r moved from abc1234 to def5678.' })
  assert.match(woke, /wakes when something it watches changes \(When main changes/)
  assert.match(woke, /WHAT WOKE YOU: your watch saw a change[\s\S]*moved from abc1234 to def5678/)
  assert.match(totemRunPrompt({ totem, trigger: 'manual' }), /started this run by hand, not a change/)
  assert.doesNotMatch(totemRunPrompt({ totem: { name: 'X', prompt: 'y' } }), /WHAT WOKE YOU/)
})

test('the builder can design a watch, and an unusable one falls back to the schedule', () => {
  const watch = parseBuilderReply(JSON.stringify({
    name: 'Bushido Deployer', instructions: 'Deploy it.', schedule: { type: 'daily', time: '09:00' },
    trigger: { type: 'watch', everyMinutes: 2, source: { kind: 'git', repo: '/srv/bushido', ref: 'main' } },
  }), { catalog: [] })
  assert.deepEqual(watch.trigger, { type: 'watch', sources: [{ kind: 'git', repo: '/srv/bushido', ref: 'main' }], everyMinutes: 2 })
  const bad = parseBuilderReply(JSON.stringify({ name: 'X', instructions: 'y', trigger: { type: 'watch', source: { kind: 'git', repo: 'somewhere' } } }), { catalog: [] })
  assert.equal(bad.trigger, null)
  assert.match(builderPrompt({ description: 'x' }), /"kind":"git"/)
})

test('a builder revision carries the conversation, his edits and his new message, and asks for a reply', () => {
  const draft = { name: 'Skills Sync', instructions: 'You keep the skills repo in sync on every machine.', schedule: { type: 'daily', time: '09:00' }, recommendations: [{ provider: 'codex', model: 'gpt-6-luna' }], questions: ['Which machines?'], reply: 'Drafted it.' }
  const p = builderPrompt({
    description: 'Sync my skills repo to every machine', catalog, draft,
    conversation: [{ role: 'owner', text: 'Sync my skills repo to every machine' }, { role: 'builder', text: 'Drafted it.', questions: ['Which machines?'] }],
    message: 'This box and the one ssh calls lp-dev.',
  })
  assert.match(p, /Revise the draft/)
  assert.match(p, /you asked: Which machines\?/)
  assert.match(p, /"name": "Skills Sync"/)
  assert.doesNotMatch(p, /"recommendations"/, 'the old suggestions are re-made, not echoed back')
  assert.match(p, /His new message:\nThis box and the one ssh calls lp-dev\./)
  assert.match(p, /- reply: /)
  // A first design has no revision block.
  assert.doesNotMatch(builderPrompt({ description: 'Watch a jacket', catalog }), /His new message/)
})

test('a builder reply keeps its message to the owner and at most three questions', () => {
  const d = parseBuilderReply(JSON.stringify({ name: 'X', instructions: 'Do x.', reply: 'Set it to run daily.', questions: ['a', 'b', 'c', 'd'] }), { catalog })
  assert.equal(d.reply, 'Set it to run daily.')
  assert.deepEqual(d.questions, ['a', 'b', 'c'])
})

test('only agent totems can be asked in a chat', () => {
  assert.equal(askableTotem({ prompt: 'Watch the page' }), true)
  assert.equal(askableTotem({ prompt: 'x', runner: 'whoop-sync' }), false)
  assert.equal(askableTotem({ skillId: 'brief' }), false)
  assert.equal(askableTotem({ prompt: '  ' }), false)
  assert.equal(askableTotem(null), false)
})

test('chat members are job ids, unique and capped', () => {
  assert.deepEqual(normalizeMembers(['a', 'a', 'b c', 'c', 7, '../x']), ['a', 'c'])
  assert.deepEqual(normalizeMembers('a'), [])
  assert.equal(normalizeMembers(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 12)
})

test('the host rule names the members, the chat id and the wait protocol', () => {
  const rule = totemsChatRule({ chatId: 'chat1', members: [{ id: 'strava', name: 'Strava Coach', description: 'Weekly training review' }], others: 3 })
  assert.match(rule, /GROUP CHAT/)
  assert.match(rule, /Strava Coach \(id strava\): Weekly training review/)
  assert.match(rule, /"chat": "chat1"/)
  assert.match(rule, /OTHER TOTEMS: the owner has 3 more standing agents/)
  assert.match(rule, /totems__wait/)
  const solo = totemsChatRule({ chatId: 'c', members: [], others: 1 })
  assert.doesNotMatch(solo, /GROUP CHAT/)
  assert.match(solo, /^TOTEMS: the owner has 1 standing agent \(/)
  assert.equal(totemsChatRule({ chatId: 'c' }), '')
})

test('an ask prompt carries the job, memory, the chat and the question, without the run protocol', () => {
  const p = totemAskPrompt({
    totem: { name: 'Stock Watch', prompt: 'Watch the jacket page.' }, memory: '- size M out', memoryPath: '/m.md',
    chatTitle: 'Weekend plans', others: ['Strava Coach'],
    transcript: [{ role: 'user', content: 'Can I afford the jacket?' }, { role: 'assistant', content: '' }], message: 'Is it back in stock?',
  })
  assert.match(p, /"Stock Watch"/)
  assert.match(p, /alongside Strava Coach/)
  assert.match(p, /Watch the jacket page\./)
  assert.match(p, /YOUR MEMORY \(\/m\.md\):\n- size M out/)
  assert.match(p, /Owner: Can I afford the jacket\?/)
  assert.doesNotMatch(p, /Host:\s*$/m)
  assert.match(p, /THE HOST ASKS YOU:\nIs it back in stock\?/)
  assert.match(p, /Do not end with NOTIFY or QUIET/)
})
