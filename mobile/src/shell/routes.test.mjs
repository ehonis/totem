// Where navigateTo() lands (#177): every Productivity tool is its own page, and
// every old way in (a tool id, { tab: 'productivity', app }, the landing-tab
// preference) reaches it. Run with `node --test mobile/src/shell/*.test.mjs`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PRODUCTIVITY_APPS, TOOL_LABELS, productivityPage, productivityPath, resolveNav } from './routes.ts'

test('a tool id opens that tool’s own page', () => {
  for (const app of PRODUCTIVITY_APPS) {
    assert.deepEqual(resolveNav(app), { pathname: `/productivity/${app}` }, app)
    assert.deepEqual(resolveNav({ tab: app }), { pathname: `/productivity/${app}` }, app)
  }
})

test('{ tab: productivity, app } opens the tool; no app or an unknown one opens the hub', () => {
  assert.deepEqual(resolveNav({ tab: 'productivity', app: 'calendar' }), { pathname: '/productivity/calendar' })
  assert.deepEqual(resolveNav({ tab: 'productivity', app: null }), { pathname: '/productivity' })
  assert.deepEqual(resolveNav({ tab: 'productivity' }), { pathname: '/productivity' })
  assert.deepEqual(resolveNav('productivity'), { pathname: '/productivity' })
  assert.deepEqual(resolveNav({ tab: 'productivity', app: 'brain' }), { pathname: '/productivity' })
})

test('every stored landing-tab value lands somewhere real', () => {
  // GeneralPane's choices, old and new: "productivity" was the pager, now the hub.
  const expected = {
    overview: '/', productivity: '/productivity', inbox: '/inbox', chat: '/chat', totems: '/totems',
    todos: '/productivity/todos', calendar: '/productivity/calendar', habits: '/productivity/habits',
    lists: '/productivity/lists', goals: '/productivity/goals', recs: '/productivity/recs', journal: '/productivity/journal',
  }
  for (const [value, path] of Object.entries(expected)) assert.equal(resolveNav(value).pathname, path, value)
  // A value from a newer or older build that this one doesn't know falls back to Overview.
  assert.equal(resolveNav('code').pathname, '/')
  assert.equal(resolveNav('').pathname, '/')
  assert.equal(resolveNav('constructor').pathname, '/')
})

test('settings keeps its pane and row, and retired panes land where they went', () => {
  assert.deepEqual(resolveNav('settings'), { pathname: '/settings', params: {} })
  assert.deepEqual(resolveNav({ tab: 'settings', sub: 'chat' }), { pathname: '/settings', params: { sub: 'chat' } })
  assert.deepEqual(resolveNav({ tab: 'settings', sub: 'providers', hash: 'api-keys' }), { pathname: '/settings', params: { sub: 'providers', row: 'api-keys' } })
  // The bridge's quota notifications still name the bottom of Providers.
  assert.deepEqual(resolveNav({ tab: 'settings', sub: 'providers', hash: 'usage' }), { pathname: '/settings', params: { sub: 'usage' } })
  // Every job is a totem.
  assert.deepEqual(resolveNav({ tab: 'settings', sub: 'jobs' }), { pathname: '/totems' })
  assert.deepEqual(resolveNav({ tab: 'settings', sub: 'ai' }), { pathname: '/settings', params: { sub: 'providers' } })
  assert.deepEqual(resolveNav({ tab: 'settings', sub: 'integrations' }), { pathname: '/settings', params: { sub: 'general', row: 'public-url' } })
  assert.deepEqual(resolveNav('logs'), { pathname: '/settings', params: { sub: 'logs' } })
  // Keyboard shortcuts need a physical keyboard; the list is the nearest thing.
  assert.deepEqual(resolveNav({ tab: 'settings', sub: 'shortcuts' }), { pathname: '/settings', params: {} })
  assert.deepEqual(resolveNav({ tab: 'settings', sub: 'no-such-pane' }), { pathname: '/settings', params: {} })
})

test('productivityPath and productivityPage agree, and only on real pages', () => {
  for (const app of PRODUCTIVITY_APPS) {
    assert.equal(productivityPage(productivityPath(app)), app)
    assert.ok(TOOL_LABELS[app], app)
  }
  assert.equal(TOOL_LABELS.todos, 'Tasks')
  assert.equal(productivityPath('nope'), '/productivity')
  assert.equal(productivityPage('/productivity'), 'hub')
  assert.equal(productivityPage('/productivity?app=todos'), 'hub')
  assert.equal(productivityPage('/productivity/todos/extra'), null)
  assert.equal(productivityPage('/productivity/brain'), null)
  assert.equal(productivityPage('/'), null)
  assert.equal(productivityPage('/todo/abc'), null)
})
