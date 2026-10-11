import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { createAlertStore } from './alerts.mjs'
import { createDevGithub } from './github.mjs'
import { createDevWatcher } from './watcher.mjs'
import { fakeGh, repoRoutes } from './fixtures.mjs'

const dirs = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const config = () => ({ enabled: true, repos: ['owner/repo'], health: [], pollMinutes: 5 })

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'totem-dev-watch-'))
  dirs.push(dir)
  const notified = []
  const state = { routes: repoRoutes('owner/repo', { ciConclusion: 'success', ciRunId: 10 }) }
  // A fresh store and watcher over the same file stands in for a restart.
  const boot = () => {
    const alerts = createAlertStore({ file: join(dir, 'dev-alerts.json'), notify: async (n) => { notified.push(n) } })
    const github = createDevGithub({ run: fakeGh((key) => state.routes[key]).run })
    return createDevWatcher({ config, github, alerts })
  }
  return { boot, state, notified }
}

test('a new failing run on main alerts once, and not again after a restart', async () => {
  const { boot, state, notified } = setup()
  let watcher = boot()
  await watcher.check()
  assert.equal(notified.length, 0, 'the first look only records')

  state.routes = repoRoutes('owner/repo', { ciConclusion: 'failure', ciRunId: 11 })
  await watcher.check()
  assert.equal(notified.length, 1)
  assert.match(notified[0].title, /owner\/repo: CI failed on main/)
  assert.equal(notified[0].category, 'alert.external')

  await watcher.check()
  watcher = boot()
  await watcher.check()
  assert.equal(notified.length, 1, 'the same run is never reported twice')

  state.routes = repoRoutes('owner/repo', { ciConclusion: 'failure', ciRunId: 12 })
  await watcher.check()
  assert.equal(notified.length, 2, 'the next failing run is new')
})

test('a runner going offline alerts', async () => {
  const { boot, state, notified } = setup()
  const watcher = boot()
  await watcher.check()
  state.routes = repoRoutes('owner/repo', { ciConclusion: 'success', ciRunId: 10, runnerStatus: 'offline' })
  await watcher.check()
  assert.equal(notified.length, 1)
  assert.match(notified[0].title, /runner box-1 went offline/)
  await watcher.check()
  assert.equal(notified.length, 1)
})

test('a watcher with the feature off calls nothing', async () => {
  let calls = 0
  const watcher = createDevWatcher({
    config: () => ({ enabled: false, repos: [], health: [], pollMinutes: 5 }),
    github: { watchStatus: async () => { calls++ } },
    alerts: {},
  })
  await watcher.check()
  assert.equal(calls, 0)
  watcher.start()
  watcher.stop()
})
