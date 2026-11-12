// Where a notification's link lands (destination.ts), and for Productivity the
// page that destination opens (#177: one page per tool). Run with
// `node --test mobile/src/features/notifications/*.test.mjs`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { notificationDestination as dest } from './destination.ts'
import { productivityPath, resolveNav } from '../../shell/routes.ts'

const BRIDGE = 'http://100.64.0.1:8787'
// openUrl.ts sends { kind: 'productivity', app } through navigateTo({ tab: 'productivity', app }).
const pageOf = (url, origins = [BRIDGE]) => {
  const d = dest(url, origins)
  assert.equal(d.kind, 'productivity', `${url} → ${JSON.stringify(d)}`)
  return productivityPath(d.app)
}

test('every tool’s web path opens that tool’s page', () => {
  for (const app of ['todos', 'calendar', 'habits', 'goals', 'lists', 'recs', 'journal']) {
    assert.equal(pageOf(`/productivity/${app}`), `/productivity/${app}`)
    // A bare web tab id (router.ts toRoute: a tool id is its own first segment).
    assert.equal(pageOf(`/${app}`), `/productivity/${app}`)
    // Old /?tab= links.
    assert.equal(pageOf(`/?tab=${app}`), `/productivity/${app}`)
    assert.equal(pageOf(`/?tab=productivity&app=${app}`), `/productivity/${app}`)
    // The same path on the bridge's own origin.
    assert.equal(pageOf(`${BRIDGE}/productivity/${app}`), `/productivity/${app}`)
  }
})

test('the app’s old pager link (/productivity?app=) still opens the tool', () => {
  assert.equal(pageOf('/productivity?app=todos'), '/productivity/todos')
  assert.equal(pageOf('/productivity?app=journal#x'), '/productivity/journal')
  // The path wins over a query that disagrees with it.
  assert.equal(pageOf('/productivity/habits?app=todos'), '/productivity/habits')
})

test('Productivity with no tool, or one the app doesn’t have, opens the hub', () => {
  assert.equal(pageOf('/productivity'), '/productivity')
  assert.equal(pageOf('/productivity/'), '/productivity')
  assert.equal(pageOf('/productivity/brain'), '/productivity')
  assert.equal(pageOf('/productivity?app=brain'), '/productivity')
})

test('links that are not Productivity are unchanged', () => {
  assert.deepEqual(dest('/inbox#P12'), { kind: 'inbox', focus: 'P12' })
  assert.deepEqual(dest('/chat?thread=t1'), { kind: 'chat', thread: 't1', project: null })
  assert.deepEqual(dest('/settings/providers#usage'), { kind: 'settings', pane: 'providers', row: 'usage' })
  assert.deepEqual(dest('/'), { kind: 'landing' })
  assert.deepEqual(dest('/fleet#mini'), { kind: 'device', id: 'mini' })
  assert.deepEqual(dest('/dev'), { kind: 'web', path: '/dev' })
  assert.deepEqual(dest('https://github.com/x'), { kind: 'external', url: 'https://github.com/x' })
  // A query on another tab never turns into a tool.
  assert.deepEqual(dest('/search?app=todos'), { kind: 'tab', tab: 'search' })
})

// openUrl.ts sends { kind: 'settings' } through navigateTo({ tab: 'settings', sub: pane, hash: row }).
const settingsOf = (url) => {
  const d = dest(url, [BRIDGE])
  assert.equal(d.kind, 'settings', `${url} → ${JSON.stringify(d)}`)
  return resolveNav({ tab: 'settings', sub: d.pane, hash: d.row })
}

test('settings links land on the pane that has the setting now', () => {
  assert.deepEqual(settingsOf('/settings/providers#usage'), { pathname: '/settings', params: { sub: 'usage' } })
  assert.deepEqual(settingsOf('/settings/security#approval-code'), { pathname: '/settings', params: { sub: 'security', row: 'approval-code' } })
  assert.deepEqual(settingsOf('/settings/ai'), { pathname: '/settings', params: { sub: 'providers' } })
  assert.deepEqual(settingsOf('/settings/integrations'), { pathname: '/settings', params: { sub: 'general', row: 'public-url' } })
  assert.deepEqual(settingsOf('/settings/jobs'), { pathname: '/totems' })
  assert.deepEqual(settingsOf(`${BRIDGE}/settings/connections`), { pathname: '/settings', params: { sub: 'connections' } })
  // The old Logs tab and Studio's sections.
  assert.deepEqual(settingsOf('/logs'), { pathname: '/settings', params: { sub: 'logs' } })
  assert.deepEqual(settingsOf('/?tab=studio&stab=skills'), { pathname: '/settings', params: { sub: 'skills' } })
})
