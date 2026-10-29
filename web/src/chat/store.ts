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
import { pushError, pushToast } from '../toast'
import { applyEvent } from './reduce'
import {
  sendChat, attachRun, stopChat, steerChat, changeQueue, getRuns, getCapabilities, probeCapabilities, listProjects, getProject, createProjectApi, patchProjectApi, projectFaviconApi,
  deleteProjectApi, putProjectMemory, addProjectFilesApi, removeProjectFilesApi, moveProjectMemoryApi, moveProjectFilesApi, type SendArgs, type StreamHandle,
} from './api'
import type { QueueAction } from './api'
import { defaultSettingsFor, fromPreset, normalizeModelSettings, parseModelSpec, visibleModels, wireModel } from './models'
import type { Attachment, BrowserFrame, BrowserHandoff, ChatCapabilities, ChatMessage, ChatThread, ModelRow, ModelSettings, Project, ProviderRow, QueuedMessage, StreamEvent } from './types'
import { activeAt, wokeAt, settleFieldsOf, settleChange, unsettleChange, snoozeChange, wakeChange, wakeDescription, type SettleFields } from './settle'

const CACHE_KEY = 'chat_threads_v2'
const OUTBOX_KEY = 'chat_outbox_v1' // see "outbox" below; up here because the initial state reads it
const LEGACY_KEY = 'chat_threads_v1'
const MIGRATED = 'chat_threads_migrated_v1'

export interface RunState {
  seq: number
  activity: string
  startedAt: number
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
  /** Settings → Chat (chat titles, auto-settle). */
  prefs: ChatPrefs
  /** Chats whose title is being rewritten right now (they shimmer). */
  retitling: Record<string, boolean>
  /** Each chat's browser, as last seen (live while its run is going). */
  browser: Record<string, BrowserFrame & { live: boolean }>
  /** The browser panel is open beside the active chat. */
  browserOpen: boolean
  /** Chats whose agent has handed the browser to the owner and is waiting. */
  handoffs: Record<string, BrowserHandoff>
  /** The Agents panel (AgentsPanel.tsx) is open beside the active chat. */
  agentsOpen: boolean
  /** The sub-agent it has open: the id of the tool card that started it. */
  agentFocus: string | null
  /** The Files panel (FilesPanel.tsx) is open beside the active chat. */
  filesOpen: boolean
  /** Each chat's saved files, as last listed. */
  files: Record<string, ChatFiles>
  /** Chat projects, without their files and memory. */
  projects: Project[]
  /** Projects fetched on their own (files and memory included), by id. */
  projectDetail: Record<string, Project>
  /** The project the chats panel is showing, or null for Home. */
  projectId: string | null
}

export interface ChatPrefs {
  /** Who writes chat titles; `off` keeps the first-line title. */
  titles: { provider: string; model: string; effort: string; off: boolean }
  /** Days without activity before a chat settles on its own; 0 never. */
  autoSettleDays: number
  /** Every chat's agent may find totems and bring them in (totems__*). Default on. */
  totemsInChat?: boolean
  /** What sending does while a reply runs: wait its turn or steer the reply. Ctrl/⌘ does the other. */
  followUp?: 'queue' | 'steer'
}

// A file the bridge sent here to be shown (chat/files.mjs, chatFileRedirect).
// Read at load: the router drops query params it does not know.
let pendingFile = new URLSearchParams(window.location.search).get('file')
export function takePendingFile() { const f = pendingFile; pendingFile = null; return f }

export interface Artifact { uploadId: string; name: string; mime: string; url?: string; size?: number; path?: string }

export interface FileEntry { path: string; rel: string; name: string; dir: boolean; size?: number; mtime?: number; mime?: string }
export interface ChatFiles { root: string; entries: FileEntry[]; truncated: boolean }

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
  handoffs: {},
  agentsOpen: false,
  agentFocus: null,
  filesOpen: false,
  files: {},
  retitling: {},
  projects: [],
  projectDetail: {},
  projectId: new URLSearchParams(window.location.search).get('project'),
  prefs: { titles: { provider: '', model: '', effort: '', off: false }, autoSettleDays: 3 },
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
  // Settings saved under the retired Auto/Instant/Thinking presets never named
  // the model, so they count as unset.
  const saved = thread ? thread.modelSettings : draft.modelSettings
  const own = saved && !fromPreset(saved) ? saved : null
  // A chat that never saved settings (one started through the API, an older
  // chat, or one that ran on a preset) carries on with the model that last
  // answered it, not the defaults a brand-new chat would get: reopening it must
  // not quietly switch models.
  const lastModel = thread && !own
    ? [...thread.messages].reverse().find((m) => m.role === 'assistant' && m.provider === provider && m.model)?.model
    : undefined
  // A brand-new chat starts on the default account's default model.
  let settings = normalizeModelSettings(
    own || (lastModel ? parseModelSpec(lastModel) : null) || defaultSettingsFor(row, state.defaultProvider, state.defaultModel),
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
  // Opening a chat that woke from a snooze is seeing it: the "Woke" mark goes.
  const opened = id ? state.threads.find((x) => x.id === id) : null
  if (opened && wokeAt(opened, now())) wakeThread(opened.id)
  // The panel follows the chat: opening a project's chat shows that project.
  const t = id ? state.threads.find((x) => x.id === id) : null
  const scope = t ? (t.projectId && state.projects.some((p) => p.id === t.projectId) ? t.projectId : null) : state.projectId
  set({ activeId: id, artifact: null, browserOpen: false, agentsOpen: false, filesOpen: false, agentFocus: null, projectId: scope })
  if (id && !state.browser[id]) loadBrowser(id)
}

// --- projects -----------------------------------------------------------------
// A project groups chats that share a default model, instructions, a memory the
// agent keeps, and files (chat/projects.mjs). The chats panel shows one scope at
// a time: Home (chats in no project, plus the project list) or one project.

/** Show a project's page (or Home with null) with no chat open. */
export function openProject(id: string | null) {
  set({ projectId: id, activeId: null, artifact: null, browserOpen: false, agentsOpen: false, filesOpen: false, agentFocus: null })
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
      // A removed picture is a missing key, which a spread would not clear.
      ? s.projects.map((p) => (p.id === project.id ? { ...p, ...summary, image: summary.image, imageUrl: summary.imageUrl } : p))
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

export async function updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'icon' | 'instructions' | 'provider' | 'modelSettings'>> & { image?: string | null }) {
  const before = state.projectDetail[id]
  if (before) {
    // Clearing the picture shows the icon at once; a new one shows when the bridge has signed it.
    const { image, ...rest } = patch
    const next = 'image' in patch ? { ...before, ...rest, image: image || undefined, imageUrl: undefined } : { ...before, ...rest }
    set((s) => ({ projectDetail: { ...s.projectDetail, [id]: next } }))
  }
  try { return takeProject((await patchProjectApi(id, patch)).project) } catch (e: any) {
    if (!fail(e)) pushError(`Couldn't save the project: ${e.message}`)
    if (before) set((s) => ({ projectDetail: { ...s.projectDetail, [id]: before } }))
    return null
  }
}

/** Wear a website's icon: the bridge fetches it and keeps it as the project's picture. */
export async function setProjectFavicon(id: string, site: string) {
  return takeProject((await projectFaviconApi(id, site)).project)
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

// --- settled and snoozed (settle.ts) ------------------------------------------------

/** Write a settle/snooze change here and on the bridge. A cleared field goes as null (JSON drops undefined). */
function writeSettle(id: string, change: SettleFields) {
  patchThread(id, (t) => ({ ...t, ...change }))
  const wire: Record<string, unknown> = { id }
  for (const [k, v] of Object.entries(change)) wire[k] = v ?? null
  putThread(wire as any).catch(fail)
}

function undoable(id: string, text: string, before: SettleFields) {
  pushToast(text, 'info', { action: { label: 'Undo', onClick: () => writeSettle(id, before) } })
}

export function settleThread(id: string) {
  const t = state.threads.find((x) => x.id === id)
  if (!t || state.runs[id]) return
  const before = settleFieldsOf(t)
  writeSettle(id, settleChange(now()))
  undoable(id, `Settled “${threadTitle(t)}”`, before)
}

export function unsettleThread(id: string) {
  const t = state.threads.find((x) => x.id === id)
  if (t) writeSettle(id, unsettleChange(now()))
}

export function snoozeThread(id: string, until: number) {
  const t = state.threads.find((x) => x.id === id)
  if (!t || until <= now()) return
  const before = settleFieldsOf(t)
  writeSettle(id, snoozeChange(until, now()))
  undoable(id, `Snoozed “${threadTitle(t)}” until ${wakeDescription(until, now())}`, before)
}

/** Wake a snoozed chat now, or clear the "Woke" mark on one that already has. */
export function wakeThread(id: string) {
  const t = state.threads.find((x) => x.id === id)
  if (t?.snoozedUntil) writeSettle(id, wakeChange(t, now()))
}

/** Clear a chat's "waiting on you" mark without replying. Opening the chat does this too (ChatView). */
export function markRead(threadId: string) {
  patchThread(threadId, (t) => ({ ...t, needsReply: undefined, keepUnread: undefined }))
  putThread({ id: threadId, needsReply: false, keepUnread: false }).catch(fail)
}

/** Put the mark back, to come back to the chat later. Unlike a finished reply, opening it doesn't clear this; replying or Mark as read does. */
export function markUnread(threadId: string) {
  patchThread(threadId, (t) => ({ ...t, needsReply: true, keepUnread: true }))
  putThread({ id: threadId, needsReply: true, keepUnread: true }).catch(fail)
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
    const r = await api<{ open: boolean; frame: BrowserFrame | null; handoff: BrowserHandoff | null }>(`/api/chat/browser?threadId=${encodeURIComponent(threadId)}`)
    if (r.frame && !state.browser[threadId]) set((s) => ({ browser: { ...s.browser, [threadId]: { ...r.frame!, live: !!s.runs[threadId] } } }))
    if (r.handoff) onHandoff(threadId, r.handoff)
  } catch {}
}

function onBrowserFrame(threadId: string, frame: BrowserFrame) {
  set((s) => ({ browser: { ...s.browser, [threadId]: { ...frame, live: true } } }))
  const waiting = !!state.handoffs[threadId]
  if (state.activeId === threadId && !state.browserOpen && (waiting || (!browserDismissed.has(threadId) && !narrowScreen()))) {
    set({ browserOpen: true, artifact: null, agentsOpen: false })
  }
}

// A handoff opens the panel even if it was closed, phone included: the owner has
// something to do in it.
function onHandoff(threadId: string, handoff: BrowserHandoff | null) {
  set((s) => {
    const handoffs = { ...s.handoffs }
    if (handoff) handoffs[threadId] = handoff
    else delete handoffs[threadId]
    return { handoffs }
  })
  if (handoff && state.activeId === threadId && state.browser[threadId]) {
    browserDismissed.delete(threadId)
    set({ browserOpen: true, artifact: null, agentsOpen: false })
  }
}

/** Done or Skip on a handoff. Past the agent's wait, it goes as his next message. */
export async function answerHandoff(threadId: string, action: 'done' | 'skip') {
  const handoff = state.handoffs[threadId]
  if (!handoff) return
  onHandoff(threadId, null)
  try {
    const r = await api<{ live: boolean; message: string | null }>('/api/chat/browser/handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId, id: handoff.id, action }) })
    if (!r.live && r.message) send({ threadId, text: r.message })
  } catch (e: any) { fail(e) }
}

const narrowScreen = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches

export function showBrowser(open: boolean) {
  const id = state.activeId
  if (id && !open) browserDismissed.add(id)
  if (id && open) browserDismissed.delete(id)
  set({ browserOpen: open, ...(open ? { artifact: null, agentsOpen: false, filesOpen: false } : {}) })
}

/** Open the Agents panel (on one sub-agent, by its tool card id) or close it. */
export function showAgents(open: boolean, focus: string | null = null) {
  set({ agentsOpen: open, ...(open ? { artifact: null, browserOpen: false, filesOpen: false, ...(focus ? { agentFocus: focus } : {}) } : {}) })
}

/** Open or close the Files panel: the chat's own folder on the box, T3 Code's files viewer. */
export function showFiles(open: boolean) {
  set({ filesOpen: open, ...(open ? { artifact: null, browserOpen: false, agentsOpen: false } : {}) })
  if (open && state.activeId) loadFiles(state.activeId)
}

/** List what the chat's agent has saved (data/chat-outputs/<thread>). */
export async function loadFiles(threadId: string) {
  try {
    const r = await api<ChatFiles>(`/api/chat/files?thread=${encodeURIComponent(threadId)}`)
    set((s) => ({ files: { ...s.files, [threadId]: r } }))
  } catch (e: any) { if (e instanceof AuthError) fail(e) }
}

/** A file on the box, by absolute path, as something the canvas can open. */
export function fileArtifact(path: string, size?: number): Artifact {
  const name = path.split('/').pop() || path
  const url = `/api/chat/files/raw?path=${encodeURIComponent(path)}`
  return { uploadId: `file:${path}`, name, mime: mimeOf(name), url, size, path }
}

const MIME_BY_EXT: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown', html: 'text/html', htm: 'text/html', csv: 'text/csv', tsv: 'text/tab-separated-values',
  txt: 'text/plain', log: 'text/plain', json: 'application/json', yml: 'text/yaml', yaml: 'text/yaml', xml: 'application/xml',
  ics: 'text/calendar', svg: 'image/svg+xml', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp',
}
export const mimeOf = (name: string) => MIME_BY_EXT[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream'

export function focusAgent(id: string | null) {
  set({ agentFocus: id })
}

export type BrowserInput =
  | { kind: 'click'; x: number; y: number }
  | { kind: 'type'; text: string }
  | { kind: 'press'; key: string; modifiers?: string[] }
  | { kind: 'scroll'; deltaX?: number; deltaY?: number }
  | { kind: 'look' }

// The owner's own clicks and keys, sent one at a time so they land in order.
let browserQueue: Promise<unknown> = Promise.resolve()

/** Drive the chat's browser by hand (sign in, dismiss a banner); shows the frame it leaves. */
export function browserInput(threadId: string, input: BrowserInput) {
  browserQueue = browserQueue.then(async () => {
    try {
      const r = await api<{ frame: BrowserFrame | null }>('/api/chat/browser/input', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId, ...input }) })
      if (r.frame) set((s) => ({ browser: { ...s.browser, [threadId]: { ...r.frame!, live: !!s.runs[threadId] } } }))
    } catch (e: any) { if (input.kind !== 'look') fail(e) }
  })
  return browserQueue
}

/** Close the chat's browser for good: tabs, cookies and all. */
export async function closeBrowser(threadId: string) {
  set((s) => { const b = { ...s.browser }; delete b[threadId]; const h = { ...s.handoffs }; delete h[threadId]; return { browser: b, handoffs: h, browserOpen: s.activeId === threadId ? false : s.browserOpen } })
  try { await api('/api/chat/browser/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId }) }) } catch (e: any) { fail(e) }
}

// One-tap voice from anywhere: the phone's voice button sets this, and the chat
// view opens voice mode on a fresh chat as soon as it is showing.
let voiceRequested = false
export function requestVoice() { voiceRequested = true; set({ activeId: null, artifact: null }) }
export function takeVoiceRequest() { const v = voiceRequested; voiceRequested = false; return v }

export function openArtifact(a: Artifact | null) {
  set({ artifact: a, ...(a ? { browserOpen: false, agentsOpen: false, filesOpen: false } : {}) })
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
    for (const r of runs) if (r.status === 'running' && !state.runs[r.threadId]) watchRun(r.threadId, 0, r.startedAt)
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
    // A run the bridge started from a queue, or from another device, shows live here too.
    if (!Object.keys(state.runs).length) syncThreads().then(resumeRuns)
    else resumeRuns()
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
  // A pinned chat is in use: pinning takes it off the Settled shelf and wakes it.
  const t = state.threads.find((x) => x.id === id)
  if (pinned && t && (t.settledOverride === 'settled' || t.snoozedUntil)) {
    writeSettle(id, { pinned, settledOverride: undefined, settledAt: undefined, snoozedUntil: undefined, snoozedAt: undefined })
    return
  }
  patchThread(id, (t) => ({ ...t, pinned }))
  putThread({ id, pinned }).catch(fail)
}

/** Who is in a group chat: totem ids. An empty list makes it a plain chat again. */
export function setMembers(id: string, members: string[]) {
  patchThread(id, (t) => ({ ...t, members: members.length ? members : undefined }))
  putThread({ id, members }).catch(fail)
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
    else runs[id] = { ...(runs[id] || { seq: 0, activity: '', startedAt: now(), handle: null }), ...patch }
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
        // The account that answered is the chat's account from now on.
        // A queued message that has started is no longer waiting.
        const queue = e.queuedId ? (t.queue || []).filter((q) => q.id !== e.queuedId) : t.queue
        return { ...t, messages: msgs, provider: e.provider, queue }
      })
      break
    case 'queue':
      patchThread(threadId, (t) => ({ ...t, queue: e.queue, queueHeld: e.queueHeld }))
      break
    case 'steer':
    case 'questions':
    case 'delta':
    case 'tool':
    case 'agent':
    case 'image':
      // A sub-agent's step is not the reply moving on: the activity line stays.
      if (e.type !== 'agent' && (e.type !== 'tool' || (e as any).tool?.phase !== 'end')) setRun(threadId, { activity: '' })
      patchAssistant(threadId, (m) => applyEvent(m, e))
      break
    case 'activity':
      setRun(threadId, { activity: e.text })
      break
    case 'browser':
      onBrowserFrame(threadId, { tabId: e.tabId, url: e.url, title: e.title, image: e.image, at: e.at })
      break
    case 'handoff':
      onHandoff(threadId, e.handoff)
      break
    case 'title':
      patchThread(threadId, (t) => ({ ...t, title: e.title, ...(e.icon ? { icon: e.icon } : {}) }))
      break
    case 'done':
      patchAssistant(threadId, (m) => ({ ...e.message, parts: e.message.parts?.length ? e.message.parts : m.parts }))
      // The bridge marks it waiting on him too; this shows it without a sync.
      if (e.message.status !== 'stopped') patchThread(threadId, (t) => (t.totemId ? t : { ...t, needsReply: true, ...(t.snoozedUntil && t.snoozedUntil > now() ? { snoozedUntil: now() } : {}) }))
      break
    case 'error':
      patchAssistant(threadId, (m) => ({ ...m, status: 'error', error: e.text }))
      break
    case 'end': {
      setRun(threadId, null)
      // The bridge starts the next queued message itself: pick its run up.
      if (state.threads.find((t) => t.id === threadId)?.queue?.length) watchQueue(threadId)
      const pid = state.threads.find((t) => t.id === threadId)?.projectId
      if (pid && state.projectDetail[pid]) loadProject(pid)
      browserDismissed.delete(threadId)
      if (state.browser[threadId]) set((s) => ({ browser: { ...s.browser, [threadId]: { ...s.browser[threadId], live: false } } }))
      break
    }
  }
}

/**
 * After a reply ends with messages queued, the bridge starts the next one (or
 * holds the queue). Look for that run a few times, then take the thread as the
 * bridge has it, which says whether the queue is held.
 */
function watchQueue(threadId: string) {
  let tries = 0
  const look = async () => {
    if (state.runs[threadId]) return
    try {
      const { runs } = await getRuns()
      const r = runs.find((x) => x.threadId === threadId && x.status === 'running')
      if (r) { if (!state.runs[threadId]) watchRun(threadId, 0, r.startedAt); return }
    } catch (e) { if (fail(e)) return }
    if (++tries < 4) setTimeout(look, 400 * tries)
    else syncThreads()
  }
  setTimeout(look, 150)
}

function watchRun(threadId: string, since: number, startedAt: number) {
  setRun(threadId, { seq: since, activity: '', startedAt })
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
  voice?: boolean
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
    modelSettings: settings, voice: input.voice,
    // Only read for a chat the bridge hasn't seen; an existing one keeps its project.
    ...(projectId ? { projectId } : {}),
    ...(contextOff ? { projectContextOff: true } : {}),
  }
  const { messages: _m, needsReply: _n, keepUnread: _k, ...meta } = thread
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
  setRun(threadId, { seq: 0, activity: '', startedAt: now() })
  // Replying (or regenerating, or editing) is what clears "waiting on you".
  // So does writing in a settled or snoozed chat, which brings it back (the bridge does the same).
  patchThread(threadId, (t) => (t.needsReply || t.settledOverride || t.snoozedUntil
    ? { ...t, needsReply: undefined, keepUnread: undefined, settledOverride: undefined, settledAt: undefined, snoozedUntil: undefined, snoozedAt: undefined, ...(t.settledOverride === 'settled' ? { unsettledAt: now() } : {}) }
    : t))
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
      if (seq > 0) watchRun(threadId, seq, now())
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
export async function steer(threadId: string, text: string, attachments?: string[]): Promise<boolean> {
  if (!state.runs[threadId] || (!text.trim() && !attachments?.length)) return false
  try {
    await steerChat(threadId, text, attachments)
    return true
  } catch (e: any) {
    if (!fail(e)) pushError(e?.status === 409 ? 'That reply had already finished. Your message is still in the box.' : `Couldn't send that: ${e.message}`)
    return false
  }
}

/** Patch the thread's queue from the bridge's answer. */
function takeQueue(threadId: string, r: { queue: QueuedMessage[]; queueHeld: boolean }) {
  patchThread(threadId, (t) => ({ ...t, queue: r.queue, queueHeld: r.queueHeld }))
}

/**
 * Queue a message behind the running reply (T3 Code's follow-up). It keeps the
 * model the composer shows now. False when it could not be queued: the caller
 * keeps the text.
 */
export async function queueMessage(threadId: string, text: string, attachments: Attachment[] = []): Promise<boolean> {
  const thread = state.threads.find((t) => t.id === threadId)
  if (!thread || (!text.trim() && !attachments.length)) return false
  const { provider, row, settings } = threadChoice(thread)
  const wire = wireModel(row?.driver || 'cursor', settings)
  try {
    takeQueue(threadId, await changeQueue(threadId, { action: 'add', text, attachments: attachments.map((a) => a.id), provider, model: wire.model, effort: wire.effort, modelSettings: settings }))
    // It ended as this was sent, so the bridge started it at once.
    if (!state.runs[threadId]) watchQueue(threadId)
    return true
  } catch (e: any) {
    if (!fail(e)) pushError(`Couldn't queue that: ${e.message}`)
    return false
  }
}

/** Edit, remove, reorder, steer with or resume a thread's queue. False when it did not happen. */
export async function updateQueue(threadId: string, change: Exclude<QueueAction, { action: 'add' }>): Promise<boolean> {
  try {
    takeQueue(threadId, await changeQueue(threadId, change))
    if (change.action === 'resume' && !state.runs[threadId]) watchQueue(threadId)
    return true
  } catch (e: any) {
    if (fail(e)) return false
    pushError(e?.status === 404 ? 'That message is no longer queued.' : e.message)
    syncThreads()
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
    regenerate: true,
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
    model: wire.model, effort: wire.effort, editMessageId: messageId,
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
  // Coming off the Settled shelf or out of a snooze counts as activity (settle.ts).
  const at = (t: ChatThread) => activeAt(t, Date.now())
  for (const [label, test] of buckets) {
    const list = rest.filter((t) => !used.has(t.id) && test(at(t)))
    list.forEach((t) => used.add(t.id))
    if (list.length) groups.push({ label, threads: list })
  }
  const byMonth = new Map<string, ChatThread[]>()
  for (const t of rest.filter((t) => !used.has(t.id))) {
    const d = new Date(at(t))
    const label = d.getFullYear() === new Date().getFullYear()
      ? d.toLocaleDateString([], { month: 'long' })
      : d.toLocaleDateString([], { month: 'long', year: 'numeric' })
    byMonth.set(label, [...(byMonth.get(label) || []), t])
  }
  for (const [label, list] of byMonth) groups.push({ label, threads: list })
  return groups
}
