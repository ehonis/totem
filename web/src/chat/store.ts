// The chat's state, outside React so the app sidebar (recent chats) and the
// chat view read the same threads off one fetch. useSyncExternalStore-shaped:
// `subscribe` + `getState`, with `useChat()` as the hook.
//
// The bridge owns messages. This module renders them optimistically while a
// turn is starting, then replaces its guesses with what the bridge says
// (`start` carries the real ids, `done` the settled reply). localStorage is
// only an instant-paint cache.
import { useSyncExternalStore } from 'react'
import { getThreads, putThread, deleteThread as apiDeleteThread, getChatModels, setProviderConfig, AuthError, api } from '../api'
import { pushError } from '../toast'
import { applyEvent } from './reduce'
import {
  sendChat, attachRun, stopChat, steerChat, getRuns, getCapabilities, probeCapabilities, listProjects, getProject, createProjectApi, patchProjectApi,
  deleteProjectApi, putProjectMemory, addProjectFilesApi, removeProjectFilesApi, moveProjectMemoryApi, moveProjectFilesApi, type SendArgs, type StreamHandle,
} from './api'
import { defaultSettingsFor, normalizeModelSettings, parseModelSpec, visibleModels, wireModel } from './models'
import type { Attachment, BrowserFrame, ChatCapabilities, ChatMessage, ChatMode, ChatThread, ModelRow, ModelSettings, Project, ProviderRow, StreamEvent } from './types'

const CACHE_KEY = 'chat_threads_v2'
const OUTBOX_KEY = 'chat_outbox_v1' // see "outbox" below; up here because the initial state reads it
const LEGACY_KEY = 'chat_threads_v1'
const MIGRATED = 'chat_threads_migrated_v1'

export interface RunState {
  seq: number
  activity: string
  startedAt: number
  mode: ChatMode
  handle: StreamHandle | null
}

export interface ChatState {
  threads: ChatThread[]
  loaded: boolean
  runs: Record<string, RunState>
  providers: ProviderRow[]
  defaultProvider: string
  defaultModel: string | null
  models: Record<string, ModelRow[]>
  caps: ChatCapabilities | null
  /** The open chat, or null for a new one. Lives here so the app sidebar can highlight it. */
  activeId: string | null
  /** The file open in the canvas panel beside the chat. */
  artifact: Artifact | null
  /** Settings → Chat (global defaults for new chats and the Auto/Instant/Thinking lanes). */
  prefs: ChatPrefs
  /** Chats whose title is being rewritten right now (they shimmer). */
  retitling: Record<string, boolean>
  /** Each chat's browser, as last seen (live while its run is going). */
  browser: Record<string, BrowserFrame & { live: boolean }>
  /** The browser panel is open beside the active chat. */
  browserOpen: boolean
  /** Chat projects, without their files and memory. */
  projects: Project[]
  /** Projects fetched on their own (files and memory included), by id. */
  projectDetail: Record<string, Project>
  /** The project the chats panel is showing, or null for Home. */
  projectId: string | null
}

export interface ChatPrefs {
  defaultPreset: 'auto' | 'instant' | 'thinking' | 'manual'
  defaultLevel: number
  instant: { provider: string; model: string; effort: string }
  thinking: { provider: string; model: string }
  /** Who writes chat titles; `off` keeps the first-line title. */
  titles: { provider: string; model: string; effort: string; off: boolean }
}

export interface Artifact { uploadId: string; name: string; mime: string; url?: string; size?: number; path?: string }

let state: ChatState = {
  threads: readCache(),
  loaded: false,
  runs: {},
  providers: [],
  defaultProvider: 'cursor',
  defaultModel: null,
  models: {},
  caps: null,
  activeId: new URLSearchParams(window.location.search).get('thread'),
  artifact: null,
  browser: {},
  browserOpen: false,
  retitling: {},
  projects: [],
  projectDetail: {},
  projectId: new URLSearchParams(window.location.search).get('project'),
  prefs: { defaultPreset: 'auto', defaultLevel: 2, instant: { provider: '', model: '', effort: '' }, thinking: { provider: '', model: '' }, titles: { provider: '', model: '', effort: '', off: false } },
}

const subs = new Set<() => void>()
let onAuthError: () => void = () => {}

function set(patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) {
  const next = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...next }
  if (next.threads) scheduleCache()
  subs.forEach((fn) => fn())
}

export const getState = () => state
export function subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn) } }
export function useChat<T>(select: (s: ChatState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state), () => select(state))
}

// --- outbox ----------------------------------------------------------------
// A message is only safe once the bridge has it (its `start` event). Until then
// it lives here too, in localStorage, so a dropped connection on a plane can't
// lose what he typed: a server sync keeps it, a reload keeps it, and the chat
// shows it as "Not sent" with Retry. Cleared the moment `start` arrives.
interface OutboxEntry { args: SendArgs; message: ChatMessage; thread: Omit<ChatThread, 'messages'>; at: number }
function readOutbox(): Record<string, OutboxEntry> {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '{}') || {} } catch { return {} }
}
function writeOutbox(o: Record<string, OutboxEntry>) {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(o)) } catch {}
}
function outboxPut(threadId: string, entry: OutboxEntry) { const o = readOutbox(); o[threadId] = entry; writeOutbox(o) }
function outboxDrop(threadId: string) { const o = readOutbox(); if (o[threadId]) { delete o[threadId]; writeOutbox(o) } }
export const hasUnsent = (threadId: string) => !!readOutbox()[threadId]

/** Put unsent messages back onto the server's copy of their chats (or the chat itself, if the server never saw it). */
function withOutbox(threads: ChatThread[], sending: Set<string> = new Set()): ChatThread[] {
  const box = readOutbox()
  const out = threads.slice()
  for (const [id, e] of Object.entries(box)) {
    if (sending.has(id)) continue // on its way right now; the run owns it
    const unsent: ChatMessage = { ...e.message, unsent: true, sendError: e.message.sendError || 'Not sent' }
    const i = out.findIndex((t) => t.id === id)
    if (i < 0) { out.push({ ...e.thread, messages: [unsent] } as ChatThread); continue }
    const t = out[i]
    // It did get through (the response was what got lost): nothing to keep.
    const lastUser = [...t.messages].reverse().find((m) => m.role === 'user')
    if (lastUser && lastUser.content === e.message.content && (lastUser.createdAt || 0) >= e.at - 60_000) { outboxDrop(id); continue }
    if (!t.messages.some((m) => m.id === e.message.id)) out[i] = { ...t, messages: [...t.messages.filter((m) => !m.unsent), unsent] }
  }
  return out
}

// --- cache -----------------------------------------------------------------

function readCache(): ChatThread[] {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')
    if (Array.isArray(v)) return withOutbox(v)
  } catch {}
  return withOutbox([])
}

let cacheTimer: ReturnType<typeof setTimeout> | null = null
function scheduleCache() {
  if (cacheTimer) return
  // Streaming touches threads many times a second; the cache is for paint, so
  // writing it once a second is plenty.
  cacheTimer = setTimeout(() => {
    cacheTimer = null
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(state.threads.slice(0, 60))) } catch {}
  }, 1000)
}

const now = () => Date.now()
export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`)

const isExpired = (t: ChatThread) => t.kind === 'temporary' && Number(t.expiresAt || 0) > 0 && Number(t.expiresAt) <= now()

function sortThreads(list: ChatThread[]) {
  return list.filter((t) => !isExpired(t)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

function patchThread(id: string, fn: (t: ChatThread) => ChatThread) {
  set((s) => ({ threads: s.threads.map((t) => (t.id === id ? fn(t) : t)) }))
}

function upsertThread(thread: ChatThread) {
  set((s) => {
    const rest = s.threads.filter((t) => t.id !== thread.id)
    return { threads: sortThreads([thread, ...rest]) }
  })
}

function fail(e: any) {
  if (e instanceof AuthError) { onAuthError(); return true }
  return false
}

// --- providers & models -----------------------------------------------------

export function providerById(id: string) {
  return state.providers.find((p) => p.id === id)
}

export async function loadProviders() {
  try {
    const info: any = await getChatModels()
    const defaultProvider = info.defaultProvider || info.provider || 'cursor'
    set((s) => ({
      providers: info.providers || [],
      defaultProvider,
      defaultModel: info.defaultModel || null,
      models: info.provider ? { ...s.models, [info.provider]: info.models || [] } : s.models,
    }))
  } catch (e) { fail(e) }
}

const modelFetches = new Map<string, Promise<void>>()
export function ensureModels(providerId: string, { force = false } = {}) {
  const p = providerById(providerId)
  if (!p?.supportsModelPicker) return
  if (!force && (state.models[providerId] || modelFetches.has(providerId))) return
  const job = getChatModels(providerId)
    .then((info: any) => set((s) => ({ models: { ...s.models, [providerId]: info.models || [] } })))
    .catch((e) => { fail(e) })
    .finally(() => modelFetches.delete(providerId))
  modelFetches.set(providerId, job)
}

/**
 * Star or unstar a model. Favourites are the Providers tab's curated list
 * (`models[provider]` in provider-config.json), saved per provider, so the
 * picker and Settings → Providers always agree.
 */
export function toggleFavorite(providerId: string, modelId: string) {
  const list = state.models[providerId]
  if (!list) return
  const next = list.map((m) => (m.id === modelId ? { ...m, favorite: !m.favorite } : m))
  set((s) => ({ models: { ...s.models, [providerId]: next } }))
  setProviderConfig({ models: { [providerId]: next.map((m) => ({ id: m.id, hidden: !!m.hidden, favorite: !!m.favorite })) } })
    .catch((e) => { if (!fail(e)) { pushError(`Couldn't save the favourite: ${e.message}`); set((s) => ({ models: { ...s.models, [providerId]: list } })) } })
}

export async function loadPrefs() {
  try { const { settings } = await api<{ settings: ChatPrefs }>('/api/chat/settings'); set({ prefs: settings }) } catch (e) { fail(e) }
}

export async function savePrefs(patch: Partial<ChatPrefs>) {
  const { settings } = await api<{ settings: ChatPrefs }>('/api/chat/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
  set({ prefs: settings })
  return settings
}

export async function loadCapabilities({ probe = false } = {}) {
  try { set({ caps: await (probe ? probeCapabilities() : getCapabilities()) }) }
  catch (e) { if (!fail(e) && probe) pushError((e as Error).message) }
}

/** The provider + settings a chat should use, resolving defaults. */
export function threadChoice(thread: ChatThread | null, draft: { provider?: string; modelSettings?: Partial<ModelSettings> } = {}) {
  // A chat's account is whichever answered it first (stored on the thread);
  // older chats fall back to the last reply's account.
  const lastReply = thread ? [...thread.messages].reverse().find((m) => m.role === 'assistant' && m.provider)?.provider : undefined
  const stored = thread?.provider || lastReply
  const provider = stored && providerById(stored)
    ? stored
    : draft.provider && providerById(draft.provider) ? draft.provider : state.defaultProvider
  const row = providerById(provider)
  // A chat that never saved settings (one started through the API, or an older
  // chat) carries on with the model that last answered it, not the defaults a
  // brand-new chat would get: reopening it must not quietly switch models.
  const lastModel = thread && !thread.modelSettings
    ? [...thread.messages].reverse().find((m) => m.role === 'assistant' && m.provider === provider && m.model)?.model
    : undefined
  // Temporary chats used to be pinned to the default model; with Auto/Instant/
  // Thinking they choose like any other chat, and only a hand-picked model is
  // held to the default account.
  let settings = normalizeModelSettings(
    (thread ? thread.modelSettings : draft.modelSettings) ||
    (lastModel ? { ...parseModelSpec(lastModel), preset: 'manual', level: String(state.prefs.defaultLevel || 2) } : null) || {
      ...defaultSettingsFor(row, state.defaultProvider, state.defaultModel),
      // A brand-new chat starts on Settings → Chat's default.
      preset: state.prefs.defaultPreset, level: String(state.prefs.defaultLevel || 2),
    },
  )
  if (row?.supportsModelPicker && !settings.modelId) {
    const first = visibleModels(state.models[provider])[0]?.id
    if (first) settings = { ...settings, modelId: first }
  }
  return { provider, row, settings }
}

// --- threads ----------------------------------------------------------------

export function setActive(id: string | null) {
  if (state.activeId === id) return
  // The panel follows the chat: opening a project's chat shows that project.
  const t = id ? state.threads.find((x) => x.id === id) : null
  const scope = t ? (t.projectId && state.projects.some((p) => p.id === t.projectId) ? t.projectId : null) : state.projectId
  set({ activeId: id, artifact: null, browserOpen: false, projectId: scope })
  if (id && !state.browser[id]) loadBrowser(id)
}

// --- projects -----------------------------------------------------------------
// A project groups chats that share a default model, instructions, a memory the
// agent keeps, and files (chat/projects.mjs). The chats panel shows one scope at
// a time: Home (chats in no project, plus the project list) or one project.

/** Show a project's page (or Home with null) with no chat open. */
export function openProject(id: string | null) {
  set({ projectId: id, activeId: null, artifact: null, browserOpen: false })
  if (id) loadProject(id)
}

export const projectById = (id?: string | null) => (id ? state.projects.find((p) => p.id === id) : undefined)

/** A project or folder's top-level project (itself for a top-level one). */
export const rootProject = (p?: Project | null) => (p?.parentId ? projectById(p.parentId) || p : p || undefined)
/** A project's folders, by name. */
export const foldersOf = (projects: Project[], id: string) => projects.filter((p) => p.parentId === id)

/** A chat's project, if it still exists (a chat in a deleted project shows in Home). */
export function threadProject(t: Pick<ChatThread, 'projectId'> | null | undefined) {
  return t?.projectId ? projectById(t.projectId) : undefined
}

export async function loadProjects() {
  try {
    const { projects } = await listProjects()
    set((s) => ({ projects, projectId: s.projectId && !projects.some((p) => p.id === s.projectId) ? null : s.projectId }))
  } catch (e) { fail(e) }
}

function takeProject(project: Project) {
  const { files: _f, memory: _m, ...summary } = project
  set((s) => ({
    projectDetail: { ...s.projectDetail, [project.id]: project },
    projects: s.projects.some((p) => p.id === project.id)
      ? s.projects.map((p) => (p.id === project.id ? { ...p, ...summary } : p))
      : [...s.projects, summary as Project].sort((a, b) => a.name.localeCompare(b.name)),
  }))
  return project
}

export async function loadProject(id: string) {
  try { return takeProject((await getProject(id)).project) } catch (e: any) {
    if (!fail(e) && e?.status === 404) set((s) => ({ projects: s.projects.filter((p) => p.id !== id), projectId: s.projectId === id ? null : s.projectId }))
    return null
  }
}

export async function createProject(body: { name: string; icon?: string; instructions?: string; parentId?: string }) {
  // A new project starts on whatever a new chat would use right now.
  const { provider, settings } = threadChoice(null)
  const { project } = await createProjectApi({ ...body, provider, modelSettings: settings })
  takeProject(project)
  openProject(project.id)
  return project
}

export async function updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'icon' | 'instructions' | 'provider' | 'modelSettings'>>) {
  const before = state.projectDetail[id]
  if (before) set((s) => ({ projectDetail: { ...s.projectDetail, [id]: { ...before, ...patch } } }))
  try { return takeProject((await patchProjectApi(id, patch)).project) } catch (e: any) {
    if (!fail(e)) pushError(`Couldn't save the project: ${e.message}`)
    if (before) set((s) => ({ projectDetail: { ...s.projectDetail, [id]: before } }))
    return null
  }
}

export async function saveProjectMemory(id: string, memory: string) {
  const r = await putProjectMemory(id, memory)
  const p = state.projectDetail[id]
  if (p) set((s) => ({ projectDetail: { ...s.projectDetail, [id]: { ...p, memory: r.memory } } }))
  return r.memory
}

export async function addProjectFiles(id: string, uploadIds: string[]) {
  if (!uploadIds.length) return
  try { takeProject((await addProjectFilesApi(id, uploadIds)).project) } catch (e: any) { if (!fail(e)) pushError(`Couldn't add the files: ${e.message}`) }
}

export async function removeProjectFiles(id: string, ids: string[]) {
  const p = state.projectDetail[id]
  if (p?.files) set((s) => ({ projectDetail: { ...s.projectDetail, [id]: { ...p, files: p.files!.filter((f) => !ids.includes(f.id)), fileCount: p.fileCount - ids.length } } }))
  try { takeProject((await removeProjectFilesApi(id, ids)).project) } catch (e: any) {
    if (!fail(e)) pushError(`Couldn't remove the files: ${e.message}`)
    loadProject(id)
  }
}

/** Delete a project (and its folders) or a folder. Chats move to Home, or a folder's up to its project; returns how many did. */
export async function deleteProject(id: string) {
  const parentId = projectById(id)?.parentId
  const { movedChats } = await deleteProjectApi(id)
  if (parentId) {
    set((s) => {
      const detail = { ...s.projectDetail }
      delete detail[id]
      return {
        projects: s.projects.filter((p) => p.id !== id),
        projectDetail: detail,
        projectId: s.projectId === id ? parentId : s.projectId,
        threads: s.threads.map((t) => (t.projectId === id ? { ...t, projectId: parentId } : t)),
      }
    })
    loadProject(parentId)
    loadProjects()
    return movedChats
  }
  const gone = new Set([id, ...foldersOf(state.projects, id).map((f) => f.id)])
  set((s) => {
    const detail = { ...s.projectDetail }
    for (const g of gone) delete detail[g]
    return {
      projects: s.projects.filter((p) => !gone.has(p.id)),
      projectDetail: detail,
      projectId: s.projectId && gone.has(s.projectId) ? null : s.projectId,
      threads: s.threads.map((t) => (t.projectId && gone.has(t.projectId) ? { ...t, projectId: undefined } : t)),
    }
  })
  return movedChats
}

/** Move a folder's memory entries (by text) up into its project. */
export async function moveMemoryUp(folderId: string, entries: string[]) {
  const parentId = projectById(folderId)?.parentId
  const { moved, project } = await moveProjectMemoryApi(folderId, entries)
  takeProject(project)
  if (parentId && state.projectDetail[parentId]) loadProject(parentId)
  return moved
}

/** Move a folder's files up into its project. */
export async function moveFilesUp(folderId: string, ids: string[]) {
  const parentId = projectById(folderId)?.parentId
  const { moved, project } = await moveProjectFilesApi(folderId, ids)
  takeProject(project)
  if (parentId) loadProject(parentId)
  loadProjects()
  return moved
}

/** Read the project's instructions, memory and files in this chat, or leave them out. */
export function setProjectContext(threadId: string, on: boolean) {
  patchThread(threadId, (t) => ({ ...t, projectContextOff: on ? undefined : true }))
  putThread({ id: threadId, projectContextOff: !on }).catch(fail)
}

/** Clear a chat's "waiting on you" mark without replying. */
export function markDone(threadId: string) {
  patchThread(threadId, (t) => ({ ...t, needsReply: undefined }))
  putThread({ id: threadId, needsReply: false }).catch(fail)
}

/** Move a chat into a project, or back to Home with null. Its files come with it. */
export async function moveThread(threadId: string, projectId: string | null) {
  patchThread(threadId, (t) => ({ ...t, projectId: projectId || undefined, ...(projectId ? { kind: 'regular' as const, expiresAt: undefined } : {}) }))
  try {
    await putThread({ id: threadId, projectId })
    if (projectId) loadProject(projectId)
    loadProjects()
  } catch (e) { fail(e) }
}

// --- the chat's browser -------------------------------------------------------
// A browsing agent streams a frame per page change. The panel opens by itself
// the first time a chat's browser shows something while you're looking at that
// chat; closing it is remembered until the chat browses again in a later turn.
const browserDismissed = new Set<string>()

async function loadBrowser(threadId: string) {
  try {
    const r = await api<{ open: boolean; frame: BrowserFrame | null }>(`/api/chat/browser?threadId=${encodeURIComponent(threadId)}`)
    if (r.frame && !state.browser[threadId]) set((s) => ({ browser: { ...s.browser, [threadId]: { ...r.frame!, live: !!s.runs[threadId] } } }))
  } catch {}
}

function onBrowserFrame(threadId: string, frame: BrowserFrame) {
  set((s) => ({ browser: { ...s.browser, [threadId]: { ...frame, live: true } } }))
  if (state.activeId === threadId && !state.browserOpen && !browserDismissed.has(threadId) && !narrowScreen()) {
    set({ browserOpen: true, artifact: null })
  }
}

const narrowScreen = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches

export function showBrowser(open: boolean) {
  const id = state.activeId
  if (id && !open) browserDismissed.add(id)
  if (id && open) browserDismissed.delete(id)
  set({ browserOpen: open, ...(open ? { artifact: null } : {}) })
}

/** Close the chat's browser for good: tabs, cookies and all. */
export async function closeBrowser(threadId: string) {
  set((s) => { const b = { ...s.browser }; delete b[threadId]; return { browser: b, browserOpen: s.activeId === threadId ? false : s.browserOpen } })
  try { await api('/api/chat/browser/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId }) }) } catch (e: any) { fail(e) }
}

// One-tap voice from anywhere: the phone's voice button sets this, and the chat
// view opens voice mode on a fresh chat as soon as it is showing.
let voiceRequested = false
export function requestVoice() { voiceRequested = true; set({ activeId: null, artifact: null }) }
export function takeVoiceRequest() { const v = voiceRequested; voiceRequested = false; return v }

export function openArtifact(a: Artifact | null) {
  set({ artifact: a, ...(a ? { browserOpen: false } : {}) })
}

/** Pull server history. A thread with a live local run keeps its live copy. */
export async function syncThreads() {
  try {
    if (!localStorage.getItem(MIGRATED)) {
      // One-time upload of chats that only ever lived in this browser.
      try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]')
        for (const t of Array.isArray(legacy) ? legacy : []) { if (!isExpired(t)) await putThread(t).catch(() => {}) }
      } catch {}
      localStorage.setItem(MIGRATED, '1')
    }
    const { threads } = await getThreads()
    set((s) => {
      const live = new Map(s.threads.filter((t) => s.runs[t.id]).map((t) => [t.id, t]))
      const merged = withOutbox((threads as ChatThread[]).map((t) => live.get(t.id) || t), new Set(Object.keys(s.runs)))
      // A thread created here a moment ago may not have reached the bridge yet.
      for (const t of s.threads) if (s.runs[t.id] && !merged.some((m) => m.id === t.id)) merged.push(t)
      return { threads: sortThreads(merged), loaded: true }
    })
  } catch (e) {
    fail(e)
    set({ loaded: true })
  }
}

/** Re-attach to runs still going on the bridge (a reload mid-answer). */
export async function resumeRuns() {
  try {
    const { runs } = await getRuns()
    for (const r of runs) if (r.status === 'running' && !state.runs[r.threadId]) watchRun(r.threadId, 0, r.mode as ChatMode, r.startedAt)
  } catch (e) { fail(e) }
}

let started = false
export function initChat(authError: () => void) {
  onAuthError = authError
  if (started) return
  started = true
  syncThreads().then(resumeRuns)
  loadProjects()
  loadProviders()
  loadCapabilities()
  loadPrefs()
  const refresh = () => {
    if (!Object.keys(state.runs).length) syncThreads()
    loadProjects()
    // The agent edits the memory and adds files while it works; keep the open project's page current.
    if (state.projectId) loadProject(state.projectId)
  }
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refresh(); resumeRuns() } })
  setInterval(refresh, 30_000)
  setInterval(() => set((s) => ({ threads: sortThreads(s.threads) })), 60_000)
}

/** Take the bridge's copy of a thread (a voice exchange it just saved). */
export function adoptThread(thread: ChatThread) {
  if (thread?.id) upsertThread(thread)
}

export function renameThread(id: string, title: string) {
  patchThread(id, (t) => ({ ...t, title }))
  putThread({ id, title }).catch(fail)
}

/** Rewrite a chat's title from the whole conversation (the title model in Settings → Chat). */
export async function regenerateTitle(id: string) {
  if (state.retitling[id]) return
  set((s) => ({ retitling: { ...s.retitling, [id]: true } }))
  try {
    const { title, icon } = await api<{ title: string; icon: string | null }>('/api/chat/title', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: id }) })
    patchThread(id, (t) => ({ ...t, title, ...(icon ? { icon } : {}) }))
  } catch (e: any) {
    if (!fail(e)) pushError(`Couldn't regenerate the title: ${e.message}`)
  } finally {
    set((s) => { const r = { ...s.retitling }; delete r[id]; return { retitling: r } })
  }
}

export function setPinned(id: string, pinned: boolean) {
  patchThread(id, (t) => ({ ...t, pinned }))
  putThread({ id, pinned }).catch(fail)
}

export function keepThread(id: string) {
  patchThread(id, (t) => ({ ...t, kind: 'regular', expiresAt: undefined }))
  putThread({ id, kind: 'regular' }).catch(fail)
}

export function setThreadModel(id: string, patch: { provider?: string; modelSettings?: Partial<ModelSettings> }) {
  patchThread(id, (t) => ({ ...t, ...(patch.provider ? { provider: patch.provider } : {}), ...(patch.modelSettings ? { modelSettings: patch.modelSettings } : {}) }))
  putThread({ id, ...patch }).catch(fail)
}

export async function removeThread(id: string) {
  state.runs[id]?.handle?.detach()
  if (state.runs[id]) stopChat(id).catch(() => {})
  set((s) => {
    const runs = { ...s.runs }
    delete runs[id]
    return { threads: s.threads.filter((t) => t.id !== id), runs, activeId: s.activeId === id ? null : s.activeId }
  })
  await apiDeleteThread(id).catch(fail)
}

// --- runs -------------------------------------------------------------------

function setRun(id: string, patch: Partial<RunState> | null) {
  set((s) => {
    const runs = { ...s.runs }
    if (patch === null) delete runs[id]
    else runs[id] = { ...(runs[id] || { seq: 0, activity: '', startedAt: now(), mode: 'chat', handle: null }), ...patch }
    return { runs }
  })
}

/** Update one part of one message in place (a proposal card after Accept). */
export function patchMessagePart(threadId: string, messageId: string, partId: string, patch: Record<string, unknown>) {
  patchThread(threadId, (t) => ({
    ...t,
    messages: t.messages.map((m) => (m.id !== messageId ? m : { ...m, parts: (m.parts || []).map((p: any) => (p.id === partId ? { ...p, ...patch } : p)) })),
  }))
}

function patchAssistant(threadId: string, fn: (m: ChatMessage) => ChatMessage) {
  patchThread(threadId, (t) => {
    const msgs = t.messages.slice()
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') { msgs[i] = fn(msgs[i]); break }
    }
    return { ...t, messages: msgs, updatedAt: now() }
  })
}

// Listeners for voice mode, which wants to hear text as it arrives.
type Listener = (threadId: string, e: StreamEvent) => void
const listeners = new Set<Listener>()
export function onStreamEvent(fn: Listener) { listeners.add(fn); return () => { listeners.delete(fn) } }

function handleEvent(threadId: string, e: StreamEvent) {
  if (typeof e.seq === 'number') setRun(threadId, { seq: e.seq })
  listeners.forEach((fn) => { try { fn(threadId, e) } catch {} })
  switch (e.type) {
    case 'start':
      outboxDrop(threadId)
      // Swap the optimistic pair for the bridge's real messages (real ids).
      patchThread(threadId, (t) => {
        const msgs = t.messages.slice()
        const ai = msgs.length - 1
        const ui = ai - 1
        if (msgs[ai]?.role === 'assistant' && msgs[ai].status === 'streaming') {
          const live = msgs[ai]
          msgs[ai] = { ...e.assistantMessage, parts: live.parts?.length ? live.parts : e.assistantMessage.parts, content: live.content || e.assistantMessage.content }
          if (msgs[ui]?.role === 'user') msgs[ui] = e.userMessage
        } else {
          msgs.push(e.userMessage, e.assistantMessage)
        }
        // The account that answered first is the chat's account from now on.
        // Auto's first pick is the chat's power from now on (the dial shows it).
        const ms = e.power && (t.modelSettings?.preset || 'auto') === 'auto' && !t.modelSettings?.power
          ? { modelSettings: { ...(t.modelSettings || {}), preset: 'auto' as const, power: String(e.power) } } : {}
        return { ...t, messages: msgs, ...ms, ...(!t.provider || t.modelSettings?.preset === 'manual' ? { provider: e.provider } : {}) }
      })
      break
    case 'steer':
    case 'delta':
    case 'tool':
    case 'image':
      if (e.type !== 'tool' || (e as any).tool?.phase !== 'end') setRun(threadId, { activity: '' })
      patchAssistant(threadId, (m) => applyEvent(m, e))
      break
    case 'activity':
      setRun(threadId, { activity: e.text })
      break
    case 'browser':
      onBrowserFrame(threadId, { tabId: e.tabId, url: e.url, title: e.title, image: e.image, at: e.at })
      break
    case 'title':
      patchThread(threadId, (t) => ({ ...t, title: e.title, ...(e.icon ? { icon: e.icon } : {}) }))
      break
    case 'done':
      patchAssistant(threadId, (m) => ({ ...e.message, parts: e.message.parts?.length ? e.message.parts : m.parts }))
      // The bridge marks it waiting on him too; this shows it without a sync.
      if (e.message.status !== 'stopped') patchThread(threadId, (t) => (t.totemId ? t : { ...t, needsReply: true }))
      break
    case 'error':
      patchAssistant(threadId, (m) => ({ ...m, status: 'error', error: e.text }))
      break
    case 'end': {
      setRun(threadId, null)
      const pid = state.threads.find((t) => t.id === threadId)?.projectId
      if (pid && state.projectDetail[pid]) loadProject(pid)
      browserDismissed.delete(threadId)
      if (state.browser[threadId]) set((s) => ({ browser: { ...s.browser, [threadId]: { ...s.browser[threadId], live: false } } }))
      break
    }
  }
}

function watchRun(threadId: string, since: number, mode: ChatMode, startedAt: number) {
  setRun(threadId, { seq: since, activity: '', mode, startedAt })
  const handle = attachRun(threadId, since, (e) => handleEvent(threadId, e), (err) => {
    if (fail(err)) return
    setRun(threadId, null)
  })
  setRun(threadId, { handle })
  handle.done.then(() => {
    // The stream ended without an `end` (network drop): re-sync rather than
    // leave a spinner on a run that may have finished.
    if (state.runs[threadId]?.handle === handle) {
      setRun(threadId, null)
      syncThreads()
    }
  })
}

export interface SendInput {
  threadId?: string | null
  text: string
  attachments?: Attachment[]
  kind?: 'regular' | 'temporary'
  provider?: string
  modelSettings?: Partial<ModelSettings>
  mode?: ChatMode
  voice?: boolean
  browser?: boolean
  /** Start a new chat inside this project. */
  projectId?: string | null
  /** A new project chat that leaves the project's context out. */
  projectContextOff?: boolean
}

/** Start a turn. Returns the thread id (new chats get one here). */
export function send(input: SendInput): string {
  const threadId = input.threadId || newId()
  if (state.runs[threadId]) return threadId
  let thread = state.threads.find((t) => t.id === threadId) || null
  const projectId = thread ? thread.projectId : (input.projectId || undefined)
  const kind = projectId ? 'regular' : thread?.kind || input.kind || 'regular'
  const { provider, row, settings } = threadChoice(thread, { provider: input.provider, modelSettings: input.modelSettings })
  const wire = wireModel(row?.driver || 'cursor', settings)
  const t0 = now()
  const userMessage: ChatMessage = {
    id: `local-${newId()}`, role: 'user', content: input.text, createdAt: t0,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.mode && input.mode !== 'chat' ? { mode: input.mode } : {}),
    ...(input.voice ? { voice: true } : {}),
  }
  const assistant: ChatMessage = { id: `local-${newId()}`, role: 'assistant', content: '', parts: [], status: 'streaming', provider, createdAt: t0 }
  const contextOff = !!projectId && !thread && !!input.projectContextOff
  if (!thread) {
    thread = {
      id: threadId, kind, provider: kind === 'regular' ? provider : undefined, modelSettings: settings,
      ...(projectId ? { projectId } : {}), ...(contextOff ? { projectContextOff: true } : {}),
      messages: [], createdAt: t0, updatedAt: t0, ...(kind === 'temporary' ? { expiresAt: endOfToday() } : {}),
    }
  }
  upsertThread({ ...thread, messages: [...thread.messages, userMessage, assistant], updatedAt: t0 })
  const args: SendArgs = {
    threadId, text: input.text, attachments: (input.attachments || []).map((a) => a.id), provider,
    // The bridge keeps this model only when the turn runs on `provider`; a
    // temporary chat held to the default account drops it there.
    model: wire.model, effort: wire.effort, kind,
    modelSettings: settings, mode: input.mode || 'chat', voice: input.voice, preset: wire.preset, level: wire.level,
    ...(wire.power ? { power: wire.power } : {}),
    ...(input.browser ? { browser: true } : {}),
    // Only read for a chat the bridge hasn't seen; an existing one keeps its project.
    ...(projectId ? { projectId } : {}),
    ...(contextOff ? { projectContextOff: true } : {}),
  }
  const { messages: _m, needsReply: _n, ...meta } = thread
  outboxPut(threadId, { args, message: userMessage, thread: { ...meta, updatedAt: t0 }, at: t0 })
  return startRun(threadId, args)
}

/** Send an unsent message again (or drop it if it turns out the bridge got it). */
export async function retryUnsent(threadId: string) {
  const e = readOutbox()[threadId]
  if (!e || state.runs[threadId]) return
  await syncThreads() // maybe it reached the bridge after all
  const still = readOutbox()[threadId]
  if (!still) { resumeRuns(); return }
  patchThread(threadId, (t) => ({
    ...t,
    messages: [
      ...t.messages.map((m) => (m.id === e.message.id ? { ...e.message } : m)),
      { id: `local-${newId()}`, role: 'assistant' as const, content: '', parts: [], status: 'streaming' as const, provider: e.args.provider, createdAt: now() },
    ],
  }))
  startRun(threadId, e.args)
}

/** Take an unsent message back out of the chat, returning its text for the composer. */
export function discardUnsent(threadId: string): string {
  const e = readOutbox()[threadId]
  outboxDrop(threadId)
  if (!e) return ''
  patchThread(threadId, (t) => ({ ...t, messages: t.messages.filter((m) => m.id !== e.message.id) }))
  if (!state.threads.find((t) => t.id === threadId)?.messages.length) set((s) => ({ threads: s.threads.filter((t) => t.id !== threadId) }))
  return e.message.content
}

function startRun(threadId: string, args: SendArgs) {
  setRun(threadId, { seq: 0, activity: '', mode: args.mode || 'chat', startedAt: now() })
  // Replying (or regenerating, or editing) is what clears "waiting on you".
  patchThread(threadId, (t) => (t.needsReply ? { ...t, needsReply: undefined } : t))
  const handle = sendChat(args, (e) => handleEvent(threadId, e), (err: any) => {
    if (fail(err)) { setRun(threadId, null); return }
    // Never reached the bridge: the message stays, marked unsent, with Retry —
    // and with no empty reply bubble under it. (A 4xx is a real refusal, not a
    // lost message: that keeps the old error-on-the-reply behaviour.)
    const box = readOutbox()[threadId]
    if (box && !(err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429)) {
      const reason = navigator.onLine === false ? 'You were offline' : (err.message || 'The connection dropped')
      box.message.sendError = reason
      outboxPut(threadId, box)
      patchThread(threadId, (t) => ({
        ...t,
        messages: t.messages
          .filter((m) => !(m.role === 'assistant' && m.status === 'streaming' && !m.content && !(m.parts || []).length))
          .map((m) => (m.id === box.message.id ? { ...m, unsent: true, sendError: reason } : m)),
      }))
      setRun(threadId, null)
      return
    }
    if (box) outboxDrop(threadId)
    // The bridge refused before starting (busy, bad input): show it on the reply.
    patchAssistant(threadId, (m) => (m.status === 'streaming' && !m.content ? { ...m, status: 'error', error: err.message } : m))
    setRun(threadId, null)
    if (err.status !== 409) pushError(err.message)
  })
  setRun(threadId, { handle })
  handle.done.then(() => {
    if (state.runs[threadId]?.handle === handle) {
      // Detached without an `end` — the connection dropped mid-run. The run is
      // still going on the bridge, so attach again from where we were.
      const seq = state.runs[threadId].seq
      setRun(threadId, null)
      if (seq > 0) watchRun(threadId, seq, args.mode || 'chat', now())
    }
  })
  return threadId
}

export function stop(threadId: string) {
  stopChat(threadId).catch(fail)
}

/**
 * Talk to a chat while it is answering. The steer shows up through the run's
 * own stream, so nothing is added here. False when the run had already finished
 * (or was a skill, which cannot take one): the caller keeps the text.
 */
export async function steer(threadId: string, text: string): Promise<boolean> {
  if (!state.runs[threadId] || !text.trim()) return false
  try {
    await steerChat(threadId, text)
    return true
  } catch (e: any) {
    if (!fail(e)) pushError(e?.status === 409 ? 'That reply had already finished. Your message is still in the box.' : `Couldn't send that: ${e.message}`)
    return false
  }
}

export function regenerate(threadId: string, override?: { provider?: string; modelSettings?: Partial<ModelSettings> }) {
  const thread = state.threads.find((t) => t.id === threadId)
  if (!thread || state.runs[threadId]) return
  if (override) setThreadModel(threadId, override)
  const { provider, row, settings } = threadChoice({ ...thread, ...(override || {}) } as ChatThread)
  const wire = wireModel(row?.driver || 'cursor', settings)
  const lastUser = [...thread.messages].reverse().find((m) => m.role === 'user')
  patchThread(threadId, (t) => {
    const msgs = t.messages.slice()
    while (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop()
    msgs.push({ id: `local-${newId()}`, role: 'assistant', content: '', parts: [], status: 'streaming', provider, createdAt: now() })
    return { ...t, messages: msgs }
  })
  startRun(threadId, {
    threadId, text: lastUser?.content || '', provider, model: wire.model, effort: wire.effort,
    regenerate: true, mode: lastUser?.mode || 'chat', preset: wire.preset, level: wire.level, ...(wire.power ? { power: wire.power } : {}),
  })
}

export function editAndResend(threadId: string, messageId: string, text: string) {
  const thread = state.threads.find((t) => t.id === threadId)
  if (!thread || state.runs[threadId]) return
  const at = thread.messages.findIndex((m) => m.id === messageId)
  if (at < 0) return
  const original = thread.messages[at]
  const { provider, row, settings } = threadChoice(thread)
  const wire = wireModel(row?.driver || 'cursor', settings)
  patchThread(threadId, (t) => ({
    ...t,
    messages: [
      ...t.messages.slice(0, at),
      { ...original, id: `local-${newId()}`, content: text },
      { id: `local-${newId()}`, role: 'assistant', content: '', parts: [], status: 'streaming', provider, createdAt: now() },
    ],
  }))
  startRun(threadId, {
    threadId, text, attachments: (original.attachments || []).map((a) => a.id), provider,
    model: wire.model, effort: wire.effort, editMessageId: messageId, mode: original.mode || 'chat', preset: wire.preset, level: wire.level, ...(wire.power ? { power: wire.power } : {}),
  })
}

function endOfToday() {
  const d = new Date()
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}

// --- presentation helpers -----------------------------------------------------

export function threadTitle(t: ChatThread | null | undefined): string {
  if (!t) return 'New chat'
  if (t.title) return t.title
  const first = t.messages.find((m) => m.role === 'user')?.content?.replace(/\s+/g, ' ').trim()
  if (first) return first.length > 48 ? `${first.slice(0, 48)}…` : first
  return t.kind === 'temporary' ? 'Temporary chat' : 'New chat'
}

/** Sidebar buckets, newest first, the way ChatGPT and T3 group history. */
export function groupThreads(threads: ChatThread[]): { label: string; threads: ChatThread[] }[] {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const today = startOfDay(new Date())
  const day = 86_400_000
  const buckets: [string, (ts: number) => boolean][] = [
    ['Today', (ts) => ts >= today],
    ['Yesterday', (ts) => ts >= today - day],
    ['Previous 7 days', (ts) => ts >= today - 7 * day],
    ['Previous 30 days', (ts) => ts >= today - 30 * day],
  ]
  const pinned = threads.filter((t) => t.pinned)
  const groups: { label: string; threads: ChatThread[] }[] = pinned.length ? [{ label: 'Pinned', threads: pinned }] : []
  const rest = threads.filter((t) => !t.pinned)
  const used = new Set<string>()
  for (const [label, test] of buckets) {
    const list = rest.filter((t) => !used.has(t.id) && test(t.updatedAt))
    list.forEach((t) => used.add(t.id))
    if (list.length) groups.push({ label, threads: list })
  }
  const byMonth = new Map<string, ChatThread[]>()
  for (const t of rest.filter((t) => !used.has(t.id))) {
    const d = new Date(t.updatedAt)
    const label = d.getFullYear() === new Date().getFullYear()
      ? d.toLocaleDateString([], { month: 'long' })
      : d.toLocaleDateString([], { month: 'long', year: 'numeric' })
    byMonth.set(label, [...(byMonth.get(label) || []), t])
  }
  for (const [label, list] of byMonth) groups.push({ label, threads: list })
  return groups
}
