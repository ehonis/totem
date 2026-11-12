// Settings → Providers' state, shared by the pane and an account's pushed detail
// screen, so a change on one shows on the other without a refetch. The actions
// are web ProvidersView.tsx's, against the same endpoints and payloads.
import { useSyncExternalStore } from 'react'
import {
  AuthError, addProviderInstance, getChatModels, getConnections, removeProviderInstance, setProviderConfig,
} from '../../../lib/api'
import { getConnection, subscribeConnection } from '../../../lib/connection'
import { pushError } from '../../../lib/toast'
import { confirm, prompt } from '../../../ui/menu'

// Loosely-shaped bridge JSON, as on the web.
export type Provider = any
export type Model = any

// The free platform default. Paid providers fall back to it on usage limits
// (mirrors FALLBACK_PROVIDER in bridge.mjs).
export const FALLBACK_PROVIDER = 'opencode'

interface State {
  data: any | null
  loading: boolean
  error: string | null
  /** What is being saved: an account id, 'defaultModel', `models:<id>`, `add:<driver>`. */
  saving: string | null
  /** Each account's model catalog, fetched the first time it is needed. */
  models: Record<string, Model[]>
}

const EMPTY: State = { data: null, loading: false, error: null, saving: null, models: {} }
let state: State = EMPTY
const subs = new Set<() => void>()
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; subs.forEach((fn) => fn()) }
const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } }

// Another server or a sign-out: nothing here answers for the old account.
// A save still out for the old one is dropped when it lands (`generation`).
let connectedTo = `${getConnection().baseUrl}|${getConnection().secret}`
let generation = 0
let queue: Promise<unknown> = Promise.resolve()
subscribeConnection(() => {
  const now = `${getConnection().baseUrl}|${getConnection().secret}`
  if (now === connectedTo) return
  connectedTo = now
  generation += 1
  queue = Promise.resolve()
  set(EMPTY)
})

/** set(), unless the server changed since `gen` was read. */
const setFor = (gen: number, patch: Partial<State>) => { if (gen === generation) set(patch) }

export function useProviders(): State {
  return useSyncExternalStore(subscribe, () => state, () => state)
}

function fail(e: unknown) {
  if (e instanceof AuthError) return
  const message = e instanceof Error ? e.message : String(e)
  set({ error: message })
  pushError(message)
}

export async function loadProviders() {
  const gen = generation
  set({ loading: true, error: null })
  try {
    setFor(gen, { data: await getConnections() })
  } catch (e) {
    if (gen === generation) fail(e)
  } finally {
    setFor(gen, { loading: false })
  }
}

export function ensureModels(providerId: string | null | undefined, force = false) {
  if (!providerId || (!force && state.models[providerId])) return
  const gen = generation
  getChatModels(providerId)
    .then((info: any) => setFor(gen, { models: { ...state.models, [providerId]: info.models || [] } }))
    .catch(() => setFor(gen, { models: { ...state.models, [providerId]: [] } }))
}

// Changes run one at a time, and each patch is built when its turn comes, from
// the answer to the change before it: two quick toggles otherwise each sent a
// list from the same stale state, and the second undid the first. A change
// belongs to the server it was made on: one still waiting when the server
// changes never runs, so nothing built from the old account reaches the new one.
// (`queue` is declared beside `generation`, which a server change resets with it.)

function enqueue<T>(work: (gen: number) => Promise<T>, skipped: T, gen = generation): Promise<T> {
  const run = () => (gen === generation ? work(gen) : Promise.resolve(skipped))
  const next = queue.then(run, run)
  queue = next
  return next
}

function apply(key: string, patch: any | (() => any)) {
  return enqueue(async (gen) => {
    set({ saving: key, error: null })
    try {
      const data = await setProviderConfig(typeof patch === 'function' ? patch() : patch)
      setFor(gen, { data })
    } catch (e) {
      if (gen === generation) fail(e)
    } finally {
      setFor(gen, { saving: null })
    }
  }, undefined)
}

export async function makeDefault(provider: Provider) {
  if (provider.default || !provider.installed) return
  if (provider.id !== FALLBACK_PROVIDER) {
    const ok = await confirm(`Make ${provider.name} the default?`, {
      message: `${provider.name} has usage limits. When it hits one, requests fall back to OpenCode, the free platform default.`,
      confirmLabel: 'Make default',
      destructive: false,
    })
    if (!ok) return
  }
  // The old default's model id means nothing to another CLI; start from its own default.
  await apply(provider.id, { defaultProvider: provider.id, defaultModel: null })
}

export function toggleEnabled(provider: Provider) {
  if (provider.default || !provider.installed) return
  const turnOn = !provider.enabled
  void apply(provider.id, () => {
    const on = ((state.data?.providers || []) as Provider[]).filter((p) => p.enabled).map((p) => p.id)
    return { enabledProviders: turnOn ? [...new Set([...on, provider.id])] : on.filter((id) => id !== provider.id) }
  })
}

export function toggleStreaming(provider: Provider) {
  if (!provider.supportsStreaming || !provider.installed) return
  const on = !provider.streaming
  void apply(provider.id, { streaming: { [provider.id]: on } })
}

export function patchInstance(provider: Provider, patch: any) {
  return apply(provider.id, { instances: { [provider.id]: patch } })
}

export function changeDefaultModel(model: string) {
  void apply('defaultModel', { defaultModel: model })
}

/** Adding an account only needs a name: the bridge picks a config directory that can't collide. */
export async function addAccount(driver: any): Promise<string | null> {
  const asked = generation
  const name = await prompt(`Name this ${driver.name} account`, { message: 'For example Work.', defaultValue: 'Work' })
  if (name === null) return null
  return enqueue(async (gen) => {
    set({ saving: `add:${driver.driver}`, error: null })
    try {
      const next = await addProviderInstance({ driver: driver.driver, displayName: name.trim() || 'Work' })
      setFor(gen, { data: next })
      return gen === generation ? next.created || null : null
    } catch (e) {
      if (gen === generation) fail(e)
      return null
    } finally {
      setFor(gen, { saving: null })
    }
  }, null, asked)
}

export async function removeAccount(provider: Provider): Promise<boolean> {
  const asked = generation
  const ok = await confirm(`Remove ${provider.name}?`, {
    message: 'Totem forgets the account. Its config directory and login stay on disk, so adding it back is a matter of pointing at the same path.',
    confirmLabel: 'Remove',
  })
  if (!ok) return false
  return enqueue(async (gen) => {
    set({ saving: provider.id, error: null })
    try {
      setFor(gen, { data: await removeProviderInstance(provider.id) })
      return gen === generation
    } catch (e) {
      if (gen === generation) fail(e)
      return false
    } finally {
      setFor(gen, { saving: null })
    }
  }, false, asked)
}

/**
 * Persist an account's whole curated model list (the full list, not a diff, so
 * order is authoritative), then refresh its merged catalog. `edit` runs when the
 * save's turn comes, on the list the previous save left, so quick taps stack.
 */
function saveModels(provider: Provider, edit: (list: Model[]) => Model[] | null) {
  return enqueue(async (gen) => {
    const next = edit(state.models[provider.id] || [])
    if (!next) return
    const entries = next.map((m) => {
      const e: any = { id: m.id }
      if (m.hidden) e.hidden = true
      if (m.favorite) e.favorite = true
      return e
    })
    set({ saving: `models:${provider.id}`, error: null })
    try {
      setFor(gen, { data: await setProviderConfig({ models: { [provider.id]: entries } }) })
      // Show what was saved even if the merged catalog cannot be read back, so the
      // next edit builds on it rather than re-saving the list before this one.
      setFor(gen, { models: { ...state.models, [provider.id]: next } })
      const info: any = await getChatModels(provider.id).catch(() => null)
      if (info) setFor(gen, { models: { ...state.models, [provider.id]: info.models || [] } })
    } catch (e) {
      if (gen === generation) fail(e)
    } finally {
      setFor(gen, { saving: null })
    }
  }, undefined)
}

export const modelActions = {
  favorite: (p: Provider, id: string) => saveModels(p, (list) => list.map((m) => (m.id === id ? { ...m, favorite: !m.favorite } : m))),
  hide: (p: Provider, id: string) => saveModels(p, (list) => list.map((m) => (m.id === id ? { ...m, hidden: !m.hidden } : m))),
  remove: (p: Provider, id: string) => saveModels(p, (list) => list.filter((m) => m.id !== id)),
  add(p: Provider, raw: string) {
    const id = raw.trim()
    if (!id) return
    void saveModels(p, (list) => (list.some((m) => m.id === id) ? null : [...list, { id, name: id, custom: true }]))
  },
  move(p: Provider, id: string, dir: number) {
    void saveModels(p, (current) => {
      const list = current.slice()
      const i = list.findIndex((m) => m.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= list.length) return null
      ;[list[i], list[j]] = [list[j], list[i]]
      return list
    })
  },
}

/**
 * The one line that tells two accounts of the same CLI apart: who is signed in,
 * and on what plan. Falls back to why it can't run when nobody is.
 */
export function accountLine(p: Provider): string {
  if (!p.installed) return `${p.cli} is not on PATH`
  if (p.authenticated === false) return 'Not signed in'
  const parts: string[] = []
  if (p.account?.email) parts.push(`Authenticated as ${p.account.email}`)
  else if (p.authenticated) parts.push('Authenticated')
  else parts.push('Auth managed inside this CLI')
  if (p.account?.plan) parts.push(p.account.plan)
  else if (p.account?.organization) parts.push(p.account.organization)
  return parts.join(' · ')
}
