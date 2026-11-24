// The app's chat store, as the saved drafts rely on it: `onRefused` only for a
// refusal before the run starts, the same restore from `retryUnsent`, and
// `listAnswered` moving only on a list the bridge answered. The store runs for
// real; React, React Native, the bridge calls and the toasts are stand-ins
// (loader hooks below), driven from `globalThis.__fake`.
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

const SOURCES = {
  react: 'export const useSyncExternalStore = () => undefined',
  'react-native': "export const AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) }",
  toast: `
    export const pushError = (m) => { globalThis.__fake.toasts.push(String(m?.message || m)) }
    export const pushToast = (m) => { globalThis.__fake.toasts.push(String(m?.message || m)) }`,
  api: `
    const f = (name, fallback) => (...a) => (globalThis.__fake[name] || fallback)(...a)
    export class AuthError extends Error {}
    export const getThreadSummaries = f('getThreadSummaries', async () => ({ threads: [] }))
    export const getThreadPage = f('getThreadPage', async () => { throw new Error('offline') })
    export const peekThreadPage = () => undefined
    export const forgetCached = () => {}
    export const isAccountChanged = () => false
    export const putThread = async () => ({})
    export const deleteThread = async () => ({})
    export const getChatModels = async () => ({ models: [] })
    export const setProviderConfig = async () => ({})
    export const api = async () => ({})
    export const onTaskStatus = () => () => {}`,
  chatApi: `
    const f = (name, fallback) => (...a) => (globalThis.__fake[name] || fallback)(...a)
    const none = async () => ({})
    export const sendChat = f('sendChat', () => ({ done: new Promise(() => {}), detach() {} }))
    export const attachRun = () => ({ done: new Promise(() => {}), detach() {} })
    export const getRuns = async () => ({ runs: [] })
    export const listProjects = async () => ({ projects: [] })
    export const peekProjects = () => undefined
    export const stopChat = none, steerChat = none, decideApproval = none, changeQueue = none, getCapabilities = none, probeCapabilities = none,
      getProject = none, createProjectApi = none, patchProjectApi = none, deleteProjectApi = none, putProjectMemory = none,
      addProjectFilesApi = none, removeProjectFilesApi = none, moveProjectMemoryApi = none, moveProjectFilesApi = none`,
}
const hooks = `
const SOURCES = ${JSON.stringify(SOURCES)}
const BY_PATH = [['/lib/chat/api.ts', 'chatApi'], ['/lib/api.ts', 'api'], ['/lib/toast.ts', 'toast']]
export async function resolve(specifier, context, next) {
  if (specifier === 'react' || specifier === 'react-native') return { url: 'stub:' + specifier, shortCircuit: true }
  let r
  if (specifier.startsWith('.') && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
    try { r = await next(specifier + '.ts', context) } catch { r = await next(specifier + '.tsx', context) }
  } else r = await next(specifier, context)
  for (const [suffix, name] of BY_PATH) if (r.url.endsWith(suffix)) return { url: 'stub:' + name, shortCircuit: true }
  return r
}
export async function load(url, context, next) {
  if (url.startsWith('stub:')) return { format: 'module', source: SOURCES[url.slice(5)], shortCircuit: true }
  return next(url, context)
}`
register(`data:text/javascript,${encodeURIComponent(hooks)}`, import.meta.url)

const items = new Map()
globalThis.localStorage = {
  getItem: (k) => (items.has(k) ? items.get(k) : null),
  setItem: (k, v) => { items.set(k, String(v)) },
  removeItem: (k) => { items.delete(k) },
  clear: () => items.clear(),
}
globalThis.__fake = { toasts: [] }
const store = await import('./store.ts')

/** A send that answers through the returned controls: `event(e)` or `error(err)`. */
function bridgeRun() {
  const run = {}
  globalThis.__fake.sendChat = (_args, onEvent, onError) => {
    run.event = onEvent
    run.error = onError
    return { done: new Promise((r) => { run.end = r }), detach() {} }
  }
  return run
}
const refusal = (status, message = 'Busy') => Object.assign(new Error(message), { status })

beforeEach(() => {
  globalThis.__fake = { toasts: [] }
  items.clear()
})

test('onRefused: the bridge refusing before the run starts puts the draft back', () => {
  const run = bridgeRun()
  let refused = 0
  store.send({ threadId: 'r1', text: 'hello', kind: 'regular', onRefused: () => { refused++ } })
  run.error(refusal(400, 'Bad input'))
  assert.equal(refused, 1)
})

test('onRefused: not once the run has started, nor for a message that never reached the bridge', () => {
  let refused = 0
  const started = bridgeRun()
  store.send({ threadId: 'r2', text: 'hello', kind: 'regular', onRefused: () => { refused++ } })
  started.event({
    type: 'start', threadId: 'r2', seq: 1, provider: 'claude', mode: 'chat',
    userMessage: { id: 'u-r2', role: 'user', content: 'hello', createdAt: 1 },
    assistantMessage: { id: 'a-r2', role: 'assistant', content: '', parts: [], status: 'streaming', createdAt: 1 },
  })
  started.error(refusal(400, 'Failed later'))
  const lost = bridgeRun()
  store.send({ threadId: 'r3', text: 'hello', kind: 'regular', onRefused: () => { refused++ } })
  lost.error(new TypeError('Network request failed'))
  assert.equal(refused, 0)
  const unsent = store.getState().threads.find((t) => t.id === 'r3').messages.find((m) => m.role === 'user')
  assert.equal(unsent.unsent, true, 'it stays in the chat as Not sent')
})

test('retryUnsent: a retry the bridge refuses runs the same restore', async () => {
  const lost = bridgeRun()
  store.send({ threadId: 'r4', text: 'try again', kind: 'regular' })
  lost.error(new TypeError('Network request failed'))
  const retry = bridgeRun()
  let refused = 0
  await store.retryUnsent('r4', () => { refused++ })
  retry.error(refusal(409, 'Busy'))
  assert.equal(refused, 1)
})

test('listAnswered moves only when the bridge answers with a list', async () => {
  const before = store.listAnswered()
  globalThis.__fake.getThreadSummaries = async () => { throw new TypeError('Network request failed') }
  await store.syncThreads()
  assert.equal(store.listAnswered(), before, 'a failed pull is no answer')
  globalThis.__fake.getThreadSummaries = async () => ({ threads: '<html>Sign in</html>' })
  await store.syncThreads()
  assert.equal(store.listAnswered(), before, 'a captive page is no answer')
  globalThis.__fake.getThreadSummaries = async () => ({ threads: [] })
  await store.syncThreads()
  assert.equal(store.listAnswered(), before + 1)
})
