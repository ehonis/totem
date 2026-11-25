// The chat's state, outside React so the app sidebar (recent chats) and the
// chat view read the same threads off one fetch. useSyncExternalStore-shaped:
// `subscribe` + `getState`, with `useChat()` as the hook.
//
// The bridge owns messages. This module renders them optimistically while a
// turn is starting, then replaces its guesses with what the bridge says
// (`start` carries the real ids, `done` the settled reply). localStorage is
// only an instant-paint cache.
import { useSyncExternalStore } from 'react'
import { isCompactionTurn } from './context'
import { AppState } from 'react-native'
import { getThreadSummaries, getThreadPage, peekThreadPage, forgetCached, isAccountChanged, putThread, deleteThread as apiDeleteThread, getChatModels, setProviderConfig, AuthError, api, onTaskStatus } from '../api'
import { pushError, pushToast } from '../toast'
import { oneAtATime } from '../oneAtATime'
import { applyEvent } from './reduce'
import {
  sendChat, attachRun, stopChat, steerChat, decideApproval, changeQueue, getRuns, getCapabilities, probeCapabilities, listProjects, peekProjects, getProject, createProjectApi, patchProjectApi,
  archiveProjectApi, restoreProjectApi, putProjectMemory, addProjectFilesApi, removeProjectFilesApi, moveProjectMemoryApi, moveProjectFilesApi, type SendArgs, type StreamHandle,
} from './api'
import type { QueueAction } from './api'
import { defaultSettingsFor, fromPreset, normalizeModelSettings, parseModelSpec, visibleModels, wireModel } from './models'
import type { ApprovalDecision, Attachment, BrowserFrame, BrowserHandoff, ChatCapabilities, ChatMessage, ChatMode, ChatThread, ModelRow, ModelSettings, Project, ProviderRow, QueuedMessage, StreamEvent } from './types'
import { projectList } from './projectList'
import { isLoaded, mergeEarlier, mergeLatest, mergeSummary, summarize, type ThreadPage } from './history'
import { OPENED_KEY, markOpened, readJson } from './recents'
import { plainRefs } from './refs'
import { activeAt, wokeAt, settledAt, settleFieldsOf, settleChange, unsettleChange, snoozeChange, wakeChange, ownerMessageChange, wakeDescription, type SettleFields } from './settle'
import { attentionOf } from './attention'

// Every chat as a summary, plus the windows of the chats opened last (cache below).
const CACHE_KEY = 'chat_threads_v3'
const OLD_CACHE_KEY = 'chat_threads_v2'
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
  /** The open chat when he opened it from the Settled shelf: it stays settled while open (settle.ts keptOpenId). */
  openedSettled: string | null
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
  /** Chats whose agent has handed the browser to the owner and is waiting (the web's; this app has no browser to hand over). */
  handoffs: Record<string, BrowserHandoff>
  /** The Agents panel (AgentsPanel.tsx) is open beside the active chat. */
  agentsOpen: boolean
  /** The sub-agent it has open: the id of the tool card that started it. */
  agentFocus: string | null
  /** Chat projects, without their files and memory. */
  projects: Project[]
  /** Projects fetched on their own (files and memory included), by id. */
  projectDetail: Record<string, Project>
  /** The project the chats panel is showing, or null for Home. */
  projectId: string | null
  /** Chats whose window is being read, or failed to be (by id). */
  pages: Record<string, PageState>
  /** A new chat being started from a task (a task's page): linked to it on its first send. */
  draftTaskId: string | null
}

/** A chat's window being read (history.ts): the latest turns, or an earlier page. */
export interface PageState {
  loading?: boolean
  error?: string
  earlier?: 'loading' | 'error'
}

export interface ChatPrefs {
  /** Who writes chat titles; `off` keeps the first-line title. */
  titles: { provider: string; model: string; effort: string; off: boolean }
  /** Days without activity before a chat settles on its own; 0 never. */
  autoSettleDays: number
  /** Every chat's agent may find totems and bring them in (totems__*). Default on. */
  totemsInChat?: boolean
  /** What sending does while a reply runs: wait its turn or steer the reply. A long press does the other. */
  followUp?: 'queue' | 'steer'
  /** Claude's auto-compact window: '' for Claude's default, else 100,000–1,000,000 (chat/context.mjs). */
  autoCompactWindow?: string
  /** What an idle Claude chat of 200k tokens or more does when its prompt cache goes cold (T3's Compact idle threads). */
  compactIdle?: 'onReturn' | 'beforeCacheExpires' | 'off'
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
  activeId: null,
  openedSettled: null,
  artifact: null,
  browser: {},
  browserOpen: false,
  handoffs: {},
  agentsOpen: false,
  agentFocus: null,
  retitling: {},
  projects: [],
  projectDetail: {},
  projectId: null,
  pages: {},
  draftTaskId: null,
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
function withOutbox(threads: ChatThread[], sending: Set<string> = new Set(), only?: string): ChatThread[] {
  const box = readOutbox()
  const out = threads.slice()
  for (const [id, e] of Object.entries(box)) {
    if (sending.has(id)) continue // on its way right now; the run owns it
    if (only && id !== only) continue
    const unsent: ChatMessage = { ...e.message, unsent: true, sendError: e.message.sendError || 'Not sent' }
    const i = out.findIndex((t) => t.id === id)
    if (i < 0) { out.push({ ...e.thread, messages: [unsent] } as ChatThread); continue }
    const t = out[i]
    // It did get through (the response was what got lost): nothing to keep.
    const lastUser = [...t.messages].reverse().find((m) => m.role === 'user')
    // A summary's preview is cut (SUMMARY_TEXT on the bridge), so it only has to start the same.
    const got = lastUser && (lastUser.content === e.message.content || (t.summary && lastUser.content.endsWith('…') && e.message.content.startsWith(lastUser.content.slice(0, -1))))
    const recent = !!lastUser && (lastUser.createdAt || 0) >= e.at - 60_000
    // Or it got through as a `/compact` (Compact and send), or was queued behind a run (one of those, or the bridge's own idle compaction).
    const queued = (t.queue || []).some((q) => !q.id.startsWith('local-') && (q.createdAt || 0) >= e.at - 60_000 && q.text === e.message.content)
    const compacting = !!e.args.compactFirst && recent && isCompactionTurn(lastUser)
    if ((got && recent) || compacting || queued) { outboxDrop(id); continue }
    if (!t.messages.some((m) => m.id === e.message.id)) out[i] = { ...t, messages: [...t.messages.filter((m) => !m.unsent), unsent] }
  }
  return out
}

// --- cache -----------------------------------------------------------------

// localStorage is expo-sqlite's (lib/boot.ts): synchronous and on disk, with no
// browser quota, but every write blocks the JS thread, so the cache stays small.
// It holds every chat as a summary and the loaded windows of the chats opened
// most recently, under CACHE_BYTES; every other chat is cut back to a summary.
const CACHE_WINDOWS = 12
const CACHE_BYTES = 2_000_000

function readCache(): ChatThread[] {
  try { localStorage.removeItem(OLD_CACHE_KEY) } catch {}
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')
    if (Array.isArray(v?.threads)) return withOutbox(v.threads)
  } catch {}
  return withOutbox([])
}

let cacheTimer: ReturnType<typeof setTimeout> | null = null
function scheduleCache() {
  if (cacheTimer) return
  // Streaming touches threads many times a second; the cache is for paint, so
  // writing it every two seconds is plenty.
  cacheTimer = setTimeout(() => {
    cacheTimer = null
    try {
      const opened = readJson<Record<string, number>>(localStorage, OPENED_KEY, {})
      const recent = new Set(state.threads.filter(isLoaded).sort((a, b) => (opened[b.id] || 0) - (opened[a.id] || 0)).slice(0, CACHE_WINDOWS).map((t) => t.id))
      if (state.activeId) recent.add(state.activeId)
      let budget = CACHE_BYTES
      const out = state.threads.map((t) => {
        if (!recent.has(t.id) || !isLoaded(t)) return summarize(t)
        const size = JSON.stringify(t).length
        if (size > budget) return summarize(t)
        budget -= size
        return t
      })
      localStorage.setItem(CACHE_KEY, JSON.stringify({ v: 3, threads: out }))
    } catch {}
  }, 2000)
}

const now = () => Date.now()
export const newId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`)

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

/**
 * The account and model a new chat in this project or folder starts on: the
 * folder's own default, else its parent project's; null when neither has one
 * (the default in Settings → Providers). An account that is no longer listed is
 * passed over. projectModelDefault in chat/projects.mjs is the bridge's twin.
 */
function projectDefault(projectId?: string | null): { provider: string; modelSettings?: Partial<ModelSettings> } | null {
  const own = projectById(projectId)
  if (!own) return null
  for (const p of [own, own.parentId ? projectById(own.parentId) : undefined]) {
    if (p?.provider && providerById(p.provider)) return { provider: p.provider, modelSettings: p.modelSettings }
  }
  return null
}

/**
 * The provider + settings a chat should use, resolving defaults. Most specific
 * first: the chat's own choice, then (for a new chat) the model picked in its
 * draft, then its folder's default, its project's, and Settings → Providers. `draft`
 * is only read for a new chat (`thread` null): an existing chat's model is its
 * own, never one picked somewhere else.
 */
export function threadChoice(thread: ChatThread | null, draft: { provider?: string; modelSettings?: Partial<ModelSettings>; projectId?: string | null } = {}) {
  // A chat's account is whichever answered it first (stored on the thread);
  // older chats fall back to the last reply's account.
  const lastReply = thread ? [...thread.messages].reverse().find((m) => m.role === 'assistant' && m.provider)?.provider : undefined
  const stored = thread?.provider || lastReply
  const picked = !thread && draft.provider && providerById(draft.provider) ? draft.provider : undefined
  const home = projectDefault(thread ? thread.projectId : draft.projectId)
  const provider = stored && providerById(stored) ? stored : picked || home?.provider || state.defaultProvider
  const row = providerById(provider)
  // Settings saved under the retired Auto/Instant/Thinking presets never named
  // the model, so they count as unset.
  const saved = thread ? thread.modelSettings : picked === provider ? draft.modelSettings : undefined
  const own = saved && !fromPreset(saved) ? saved : null
  // A chat that never saved settings (one started through the API, an older
  // chat, or one that ran on a preset) carries on with the model that last
  // answered it, not the defaults a brand-new chat would get: reopening it must
  // not quietly switch models.
  const lastModel = thread && !own
    ? [...thread.messages].reverse().find((m) => m.role === 'assistant' && m.provider === provider && m.model)?.model
    : undefined
  // Then the folder's or project's model, when the chat is on that account.
  const inherited = home && home.provider === provider && home.modelSettings && !fromPreset(home.modelSettings) ? home.modelSettings : null
  // A brand-new chat outside any project starts on the default account's default model.
  let settings = normalizeModelSettings(
    own || (lastModel ? parseModelSpec(lastModel) : null) || inherited || defaultSettingsFor(row, state.defaultProvider, state.defaultModel),
  )
  if (row?.supportsModelPicker && !settings.modelId) {
    const first = visibleModels(state.models[provider])[0]?.id
    if (first) settings = { ...settings, modelId: first }
  }
  return { provider, row, settings }
}

/** A model picked in a new chat's composer, for the place it was picked in (`key`). */
export interface DraftPick { key: string; provider: string; modelSettings: ModelSettings }

/**
 * What a composer passes threadChoice. A new chat gets the model picked for it
 * in this place (Home, a project or a folder; `key`) and the project it starts
 * in. An open chat gets nothing: its model is its own, never a pick made elsewhere.
 */
export function draftFor(pick: DraftPick | null, key: string, { open, projectId }: { open: boolean; projectId?: string }): { provider?: string; modelSettings?: ModelSettings; projectId?: string } {
  if (open) return {}
  return { ...(pick?.key === key ? { provider: pick.provider, modelSettings: pick.modelSettings } : {}), projectId }
}

// --- threads ----------------------------------------------------------------

export function setActive(id: string | null) {
  // A new chat asked for again drops the task it was being started for.
  if (state.activeId === id) { if (!id && state.draftTaskId) set({ draftTaskId: null }); return }
  // Opening a chat that woke from a snooze is seeing it: the "Woke" mark goes.
  const opened = id ? state.threads.find((x) => x.id === id) : null
  if (opened && wokeAt(opened, now())) wakeThread(opened.id)
  // The panel follows the chat: opening a project's chat shows that project.
  const t = id ? state.threads.find((x) => x.id === id) : null
  const scope = t ? (t.projectId && state.projects.some((p) => p.id === t.projectId) ? t.projectId : null) : state.projectId
  const openedSettled = t && settledAt(t, now(), state.prefs.autoSettleDays ?? 3, !!state.runs[t.id], false, !!attentionOf(t, state.handoffs[t.id])) ? t.id : null
  set({ activeId: id, openedSettled, artifact: null, browserOpen: false, agentsOpen: false, agentFocus: null, projectId: scope, draftTaskId: null })
  if (id && (!state.browser[id] || state.handoffs[id])) loadBrowser(id)
  if (id) {
    // Overview's Recent chats and the cache both go by when a chat was last opened here.
    try { localStorage.setItem(OPENED_KEY, JSON.stringify(markOpened(readJson(localStorage, OPENED_KEY, {}), id, now()))) } catch {}
    // Its latest window: drawn from what the phone has, then asked of the bridge (a 304 when unchanged).
    void loadThread(id)
  }
}

// --- one chat, a window at a time (history.ts) ------------------------------------
// The list holds summaries; a chat's messages are read when it is opened: the
// latest PAGE_TURNS turns, then "Load earlier" pages back. Reads of one chat are
// shared while one is out.

function setPage(id: string, patch: PageState | null) {
  set((s) => {
    const pages = { ...s.pages }
    if (patch === null) delete pages[id]
    else pages[id] = { ...pages[id], ...patch }
    return { pages }
  })
}

/**
 * The last turn of a chat whose reply is running here: the window read from the
 * bridge can be behind the live stream, so the live messages stay as they are.
 */
function keepLive(merged: ChatThread, local: ChatThread | undefined): ChatThread {
  if (!local || !state.runs[local.id]) return merged
  let i = local.messages.length - 1
  while (i >= 0 && local.messages[i].role !== 'user') i--
  if (i < 0) return merged
  const tail = local.messages.slice(i)
  const ids = new Set(tail.map((m) => m.id))
  const j = merged.messages.findIndex((m) => ids.has(m.id))
  return { ...merged, messages: [...(j < 0 ? merged.messages : merged.messages.slice(0, j)), ...tail] }
}

function takePage(id: string, page: ThreadPage) {
  set((s) => {
    const existing = s.threads.find((t) => t.id === id)
    // A reply running here owns the chat's last turn; an opened chat with one keeps its messages.
    if (s.runs[id] && isLoaded(existing)) return {}
    let thread = keepLive(mergeLatest(existing, page), existing)
    thread = withOutbox([thread], new Set(Object.keys(s.runs)), id).find((t) => t.id === id) || thread
    const rest = s.threads.filter((t) => t.id !== id)
    return { threads: sortThreads([thread, ...rest]) }
  })
}

const threadReads = new Map<string, Promise<void>>()
/** Read a chat's latest window. Drawn from the phone's copy first when it has none loaded. */
export function loadThread(id: string, { fresh = false } = {}): Promise<void> {
  const current = threadReads.get(id)
  // A read that went out before the run ended lacks its turn: read again after it.
  if (current) return fresh ? current.then(() => loadThread(id)) : current
  const have = state.threads.find((t) => t.id === id)
  if (!isLoaded(have)) {
    const stored = peekThreadPage(id) as ThreadPage | undefined
    if (stored?.id === id && Array.isArray(stored.messages)) takePage(id, stored)
  }
  setPage(id, { loading: true, error: undefined })
  const job = (async () => {
    try {
      const page = await getThreadPage(id) as ThreadPage
      if (page?.id === id) takePage(id, page)
      setPage(id, { loading: false })
    } catch (e: any) {
      if (fail(e) || isAccountChanged(e)) { setPage(id, null); return }
      // Gone on the bridge: deleted or expired elsewhere.
      if (e?.status === 404) {
        setPage(id, null)
        if (!state.runs[id] && !readOutbox()[id]) set((s) => ({ threads: s.threads.filter((t) => t.id !== id) }))
        return
      }
      setPage(id, { loading: false, error: e?.message || 'Could not load this chat' })
    } finally {
      threadReads.delete(id)
    }
  })()
  threadReads.set(id, job)
  return job
}

/** Read the page before the oldest message loaded. False when there was nothing to read or it failed. */
export async function loadEarlier(id: string): Promise<boolean> {
  const t = state.threads.find((x) => x.id === id)
  if (!isLoaded(t) || !t.history?.hasMore || !t.history.before || state.pages[id]?.earlier === 'loading') return false
  setPage(id, { earlier: 'loading' })
  try {
    const before = t.history.before
    const page = await getThreadPage(id, before) as ThreadPage
    // A newer window may have replaced the messages meanwhile: only the page in front of them fits.
    patchThread(id, (cur) => (isLoaded(cur) && cur.history?.before === before ? mergeEarlier(cur, page) : cur))
    setPage(id, { earlier: undefined })
    return true
  } catch (e: any) {
    if (fail(e) || isAccountChanged(e)) { setPage(id, { earlier: undefined }); return false }
    setPage(id, { earlier: 'error' })
    return false
  }
}

// --- projects -----------------------------------------------------------------
// A project groups chats that share a default model, instructions, a memory the
// agent keeps, and files (chat/projects.mjs). The chats panel shows one scope at
// a time: Home (chats in no project, plus the project list) or one project.

/** Show a project's page (or Home with null) with no chat open. */
export function openProject(id: string | null) {
  set({ projectId: id, activeId: null, artifact: null, browserOpen: false, agentsOpen: false, agentFocus: null, draftTaskId: null })
  if (id) loadProject(id)
}

/** A new chat for a task, in the project it should open in (its folder, or where its latest chat is). */
export function startTaskDraft(taskId: string, projectId: string | null) {
  set({ projectId, activeId: null, artifact: null, browserOpen: false, agentsOpen: false, agentFocus: null, draftTaskId: taskId })
  if (projectId) loadProject(projectId)
}

/** The new chat stays a plain one: the task it was started from is dropped. */
export function clearTaskDraft() { set({ draftTaskId: null }) }

export const projectById = (id?: string | null) => (id ? state.projects.find((p) => p.id === id) : undefined)

/** A project or folder's top-level project (itself for a top-level one). */
export const rootProject = (p?: Project | null) => (p?.parentId ? projectById(p.parentId) || p : p || undefined)
/** A project's folders, by name. */
export const foldersOf = (projects: Project[], id: string) => projects.filter((p) => p.parentId === id)

/** A chat's project, if it still exists (a chat in a deleted project shows in Home). */
export function threadProject(t: Pick<ChatThread, 'projectId'> | null | undefined) {
  return t?.projectId ? projectById(t.projectId) : undefined
}

const projectSync = projectList({ peek: peekProjects, list: listProjects, get: () => state, set, fail })
export const loadProjects = projectSync.load

function takeProject(project: Project) {
  const { files: _f, memory: _m, ...summary } = project
  set((s) => ({
    projectDetail: { ...s.projectDetail, [project.id]: project },
    projects: s.projects.some((p) => p.id === project.id)
      // A removed picture or model is a missing key, which a spread would not clear.
      ? s.projects.map((p) => (p.id === project.id ? { ...p, ...summary, image: summary.image, imageUrl: summary.imageUrl, provider: summary.provider, modelSettings: summary.modelSettings } : p))
      : [...s.projects, summary as Project].sort((a, b) => a.name.localeCompare(b.name)),
  }))
  return project
}

/** The bridge's answer to a change the phone made: a list asked for before it is out of date. */
function takeChange(project: Project) {
  projectSync.changed()
  return takeProject(project)
}

export async function loadProject(id: string) {
  try { return takeProject((await getProject(id)).project) } catch (e: any) {
    if (!fail(e) && e?.status === 404) set((s) => ({ projects: s.projects.filter((p) => p.id !== id), projectId: s.projectId === id ? null : s.projectId }))
    return null
  }
}

export async function createProject(body: { name: string; icon?: string; instructions?: string; parentId?: string }) {
  // No model of its own until one is picked: a folder follows its project, a
  // project the default in Settings → Providers (projectDefault).
  const { project } = await createProjectApi(body)
  takeChange(project)
  openProject(project.id)
  return project
}

export async function updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'icon' | 'instructions' | 'provider' | 'modelSettings'>>) {
  const before = state.projectDetail[id]
  if (before) set((s) => ({ projectDetail: { ...s.projectDetail, [id]: { ...before, ...patch } } }))
  try { return takeChange((await patchProjectApi(id, patch)).project) } catch (e: any) {
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
  try { takeChange((await addProjectFilesApi(id, uploadIds)).project) } catch (e: any) { if (!fail(e)) pushError(`Couldn't add the files: ${e.message}`) }
}

export async function removeProjectFiles(id: string, ids: string[]) {
  const p = state.projectDetail[id]
  if (p?.files) set((s) => ({ projectDetail: { ...s.projectDetail, [id]: { ...p, files: p.files!.filter((f) => !ids.includes(f.id)), fileCount: p.fileCount - ids.length } } }))
  try { takeChange((await removeProjectFilesApi(id, ids)).project) } catch (e: any) {
    if (!fail(e)) pushError(`Couldn't remove the files: ${e.message}`)
    loadProject(id)
  }
}

/**
 * Put a project (with its folders) or a folder away (the web's archiveProject).
 * Nothing is deleted: Settings → Archive brings it back with its chats.
 */
export async function archiveProject(id: string) {
  const parentId = projectById(id)?.parentId
  await archiveProjectApi(id)
  projectSync.changed()
  const gone = new Set([id, ...(parentId ? [] : foldersOf(state.projects, id).map((f) => f.id))])
  set((s) => {
    const detail = { ...s.projectDetail }
    for (const g of gone) delete detail[g]
    return {
      projects: s.projects.filter((p) => !gone.has(p.id)),
      projectDetail: detail,
      projectId: s.projectId && gone.has(s.projectId) ? (parentId || null) : s.projectId,
      threads: s.threads.filter((t) => !t.projectId || !gone.has(t.projectId) || t.id === s.activeId || !!s.runs[t.id]),
    }
  })
  loadProjects()
  return gone.size
}

/** Bring an archived project or folder back, with its chats. */
export async function restoreProject(id: string) {
  await restoreProjectApi(id)
  projectSync.changed()
  await Promise.all([loadProjects(), syncThreads()])
}

/** Move a folder's memory entries (by text) up into its project. */
export async function moveMemoryUp(folderId: string, entries: string[]) {
  const parentId = projectById(folderId)?.parentId
  const { moved, project } = await moveProjectMemoryApi(folderId, entries)
  takeChange(project)
  if (parentId && state.projectDetail[parentId]) loadProject(parentId)
  return moved
}

/** Move a folder's files up into its project. */
export async function moveFilesUp(folderId: string, ids: string[]) {
  const parentId = projectById(folderId)?.parentId
  const { moved, project } = await moveProjectFilesApi(folderId, ids)
  takeChange(project)
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
  backInPlay(id)
}

/** Off the shelf while open (un-settled, or written in): it keeps its place from now on (settle.ts keptOpenId). */
function backInPlay(id: string) {
  if (state.openedSettled === id) set({ openedSettled: null })
}

/**
 * settle.ts ownerMessageChange, shown at once rather than on the next list read. `answered`: a new
 * turn, which also clears "waiting on you".
 */
export function wakeOnOwnerMessage(id: string, answered = false) {
  backInPlay(id)
  patchThread(id, (t) => (t.settledOverride || t.settledAt || t.snoozedUntil || t.snoozedAt || t.doneAt || (answered && t.needsReply)
    ? { ...t, ...ownerMessageChange(t, now()), ...(answered ? { needsReply: undefined, keepUnread: undefined } : {}) }
    : t))
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

/** Link a chat to a task (its ref), or unlink it with null. The bridge reads the task into each turn. */
export function linkTask(threadId: string, taskId: string | null) {
  // The old task's finish no longer counts; the bridge's answer says whether the new one is done.
  const next = taskId || undefined
  patchThread(threadId, (t) => ({ ...t, taskId: next, taskDoneAt: undefined }))
  putThread({ id: threadId, taskId })
    .then((saved: { taskDoneAt?: number } | null) => {
      if (saved?.taskDoneAt) patchThread(threadId, (t) => (t.taskId === next ? { ...t, taskDoneAt: saved.taskDoneAt } : t))
    })
    .catch(fail)
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
  const sentAt = handoffClock
  try {
    const r = await api<{ open: boolean; frame: BrowserFrame | null; handoff?: BrowserHandoff | null }>(`/api/chat/browser?threadId=${encodeURIComponent(threadId)}`)
    if (r.frame && !state.browser[threadId]) set((s) => ({ browser: { ...s.browser, [threadId]: { ...r.frame!, live: !!s.runs[threadId] } } }))
    if (r.handoff && !answeredHandoffs.has(r.handoff.id)) onHandoff(threadId, r.handoff)
    // Answered elsewhere, or the browser closed: only one this device saw before asking.
    else if (!r.handoff && state.handoffs[threadId] && (handoffSeen.get(threadId) || 0) <= sentAt) onHandoff(threadId, null)
  } catch {}
}

// When this device last learned of each chat's handoff (a count, not a clock),
// and the ones it answered: a list or browser read sent before then cannot take
// one back, and none brings back one answered here.
let handoffClock = 0
const handoffSeen = new Map<string, number>()
const answeredHandoffs = new Set<string>()

/**
 * The handoffs a chat list names (`handoff` on a summary, the bridge's
 * withHandoff), taken off the threads. A chat whose run this device follows keeps
 * what its stream said; for the rest the list is the word, except that it cannot
 * undo what this device learned after asking, or bring back one it answered.
 */
function takeHandoffs(threads: ChatThread[], sentAt: number) {
  const named = new Map<string, BrowserHandoff>()
  for (const t of threads) {
    const h = (t as ChatThread & { handoff?: BrowserHandoff }).handoff
    if (h && !answeredHandoffs.has(h.id)) named.set(t.id, h)
    delete (t as { handoff?: unknown }).handoff
  }
  return (s: ChatState) => {
    const out: Record<string, BrowserHandoff> = {}
    for (const [id, h] of Object.entries(s.handoffs)) {
      if (s.runs[id] || named.has(id) || (handoffSeen.get(id) || 0) > sentAt) out[id] = h
    }
    for (const [id, h] of named) if (!s.runs[id] && out[id]?.id !== h.id) { out[id] = h; handoffSeen.set(id, ++handoffClock) }
    return out
  }
}

// The app has no browser to drive: a handoff shows as the chat's row over the
// composer (HandoffBar.tsx) and on its row in the drawer, with Done and Skip.
function onHandoff(threadId: string, handoff: BrowserHandoff | null) {
  handoffSeen.set(threadId, ++handoffClock)
  set((s) => {
    const handoffs = { ...s.handoffs }
    if (handoff) handoffs[threadId] = handoff
    else delete handoffs[threadId]
    return { handoffs }
  })
}

/** Done or Skip on a handoff. Past the agent's wait, it goes as his next message. */
export async function answerHandoff(threadId: string, action: 'done' | 'skip') {
  const handoff = state.handoffs[threadId]
  if (!handoff) return
  answeredHandoffs.add(handoff.id)
  onHandoff(threadId, null)
  try {
    const r = await api<{ live: boolean; message: string | null }>('/api/chat/browser/handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId, id: handoff.id, action }) })
    if (!r.live && r.message) send({ threadId, text: r.message })
  } catch (e: any) {
    // A 404: it was already over (answered elsewhere, or the browser closed).
    if ((e as { status?: number })?.status === 404) return
    // Not taken: it is still waiting on him.
    answeredHandoffs.delete(handoff.id)
    if (!state.handoffs[threadId]) onHandoff(threadId, handoff)
    if (!fail(e)) pushError(`Couldn't answer the browser handoff: ${e?.message || 'Totem is out of reach'}`)
  }
}

function onBrowserFrame(threadId: string, frame: BrowserFrame) {
  set((s) => ({ browser: { ...s.browser, [threadId]: { ...frame, live: true } } }))
  if (state.activeId === threadId && !state.browserOpen && !browserDismissed.has(threadId) && !narrowScreen()) {
    set({ browserOpen: true, artifact: null, agentsOpen: false })
  }
}

// Always a phone: the browser panel opens only when asked.
const narrowScreen = () => true

export function showBrowser(open: boolean) {
  const id = state.activeId
  if (id && !open) browserDismissed.add(id)
  if (id && open) browserDismissed.delete(id)
  set({ browserOpen: open, ...(open ? { artifact: null, agentsOpen: false } : {}) })
}

/** Open the Agents panel (on one sub-agent, by its tool card id) or close it. */
export function showAgents(open: boolean, focus: string | null = null) {
  set({ agentsOpen: open, ...(open ? { artifact: null, browserOpen: false, ...(focus ? { agentFocus: focus } : {}) } : {}) })
}

export function focusAgent(id: string | null) {
  set({ agentFocus: id })
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
  set({ artifact: a, ...(a ? { browserOpen: false, agentsOpen: false } : {}) })
}

// A summary that has not changed keeps its object, so the drawer's rows don't redraw.
const summaryText = new Map<string, string>()

// When this device last let go of each chat's run (a count, not a clock). A list
// asked for before then can predate the chat itself, so it does not drop it.
let listClock = 0
const runLeft = new Map<string, number>()
// Counts the bridge's lists applied; 0 until it first answers (a failed pull leaves it).
let listsApplied = 0
/** Changes each time the bridge's list of chats is applied; 0 until it first answers. */
export const listAnswered = () => listsApplied

/**
 * Pull the list (summaries). A chat with a live local run keeps its live copy; an
 * opened chat keeps its messages, and the open one reads its window again when
 * the bridge has moved on (mergeSummary's `stale`).
 *
 * One pull at a time: a call while one is out waits for it and then pulls once
 * more, shared by every call in between. On a slow link the calls queue behind
 * one download instead of each throwing away the answer before it.
 */
export const syncThreads = oneAtATime(pullThreads)

async function pullThreads() {
  try {
    if (!localStorage.getItem(MIGRATED)) {
      // One-time upload of chats that only ever lived in this browser.
      try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]')
        for (const t of Array.isArray(legacy) ? legacy : []) { if (!isExpired(t)) await putThread(t).catch(() => {}) }
      } catch {}
      localStorage.setItem(MIGRATED, '1')
    }
    const sentAt = handoffClock
    const askedAt = listClock
    const { threads } = await getThreadSummaries()
    // Not a list (a sign-in or captive page answered): keep what the app holds.
    if (!Array.isArray(threads)) throw new Error('The bridge did not answer with the chat list.')
    const listed = takeHandoffs(threads as ChatThread[], sentAt)
    const stale: string[] = []
    listsApplied++
    set((s) => {
      const byId = new Map(s.threads.map((t) => [t.id, t]))
      const merged = (threads as ChatThread[]).map((sum) => {
        const prev = byId.get(sum.id)
        if (prev && s.runs[sum.id]) return prev
        const text = JSON.stringify(sum)
        const same = summaryText.get(sum.id) === text
        summaryText.set(sum.id, text)
        // An unchanged summary keeps its object; an opened chat is checked every time,
        // so a re-read that failed is tried again on the next sync.
        if (same && prev && !isLoaded(prev)) return prev
        const { thread, stale: moved } = mergeSummary(prev, sum)
        // Nothing changed: the same object, so the open chat doesn't redraw on every sync.
        if (!moved) return same && prev ? prev : thread
        // Only the open chat is read again; any other goes back to its summary,
        // and opening it reads its window (loadThread).
        if (sum.id !== s.activeId) return sum
        stale.push(sum.id)
        return thread
      })
      const out = withOutbox(merged, new Set(Object.keys(s.runs)))
      // A thread created here a moment ago may not have reached the bridge yet, nor
      // be in a list asked for before its run ended here.
      const have = new Set(out.map((t) => t.id))
      for (const t of s.threads) {
        if (!have.has(t.id) && (s.runs[t.id] || threadReads.has(t.id) || (runLeft.get(t.id) || 0) > askedAt)) out.push(t)
      }
      return { threads: sortThreads(out), loaded: true, handoffs: listed(s) }
    })
    for (const [id, at] of runLeft) if (at <= askedAt) runLeft.delete(id)
    // The open chat moved on the bridge (another device, a totem, a queued reply): read it again.
    const open = state.activeId
    if (open && stale.includes(open) && !state.runs[open]) void loadThread(open)
  } catch (e) {
    if (!fail(e) && !isAccountChanged(e)) set({ loaded: true })
  }
}

/** Re-attach to runs still going on the bridge (a reload mid-answer). */
export async function resumeRuns() {
  try {
    const { runs } = await getRuns()
    for (const r of runs) {
      if (r.status !== 'running' || state.runs[r.threadId]) continue
      // The replay folds onto the saved reply, so read the chat's window first,
      // not onto a summary's cut preview.
      if (!isLoaded(state.threads.find((t) => t.id === r.threadId))) await loadThread(r.threadId)
      // Still a summary (the read failed): the next refresh attaches it.
      if (!isLoaded(state.threads.find((t) => t.id === r.threadId))) continue
      if (!state.runs[r.threadId]) watchRun(r.threadId, 0, r.mode as ChatMode, r.startedAt)
    }
  } catch (e) { fail(e) }
}

/**
 * Back in the app: iOS froze the sockets, and a stream that looks open may never
 * speak again. Drop every stream that has started and attach again from its seq.
 */
function reattachStreams() {
  for (const r of Object.values(state.runs)) if (r.handle && r.seq > 0) { r.handle.stalled = true; r.handle.detach() }
}

let started = false
export function initChat(authError: () => void) {
  onAuthError = authError
  if (started) return
  started = true
  // Every message of every chat, as the list was before summaries: nothing reads it now.
  forgetCached('/api/threads')
  projectSync.seed()
  syncThreads().then(resumeRuns)
  loadProjects()
  loadProviders()
  loadCapabilities()
  loadPrefs()
  // A task done or reopened here: the list reads again, so its chats settle or come back
  // (each chat's `taskDoneAt` is the bridge's reading of its task; settle.ts taskDoneSince).
  onTaskStatus(() => { void syncThreads() })
  const refresh = () => {
    // A run the bridge started from a queue, or from another device, shows live
    // here too. Summaries are small, so the list syncs even while a reply runs.
    syncThreads().then(resumeRuns)
    loadProjects()
    // The agent edits the memory and adds files while it works; keep the open project's page current.
    if (state.projectId) loadProject(state.projectId)
  }
  // Coming back to the app is the phone's "tab became visible". The first try can
  // fail while iOS brings the network back (its toast is muted, lib/wake.ts), so
  // try again once it has settled rather than wait for the 30-second tick.
  AppState.addEventListener('change', (s) => {
    if (s !== 'active') return
    reattachStreams()
    refresh()
    if (state.activeId) void loadThread(state.activeId)
    setTimeout(() => { if (AppState.currentState === 'active') { refresh(); if (state.activeId) void loadThread(state.activeId) } }, 3000)
  })
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
  if (patch === null && state.runs[id]) runLeft.set(id, ++listClock)
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
          // Compact and send's stand-in divider gives way to the bridge's own (same compaction, real id).
          const kept = (live.parts || []).filter((p) => !(p.type === 'compaction' && p.id.startsWith('local-')))
          msgs[ai] = { ...e.assistantMessage, parts: kept.length ? kept : e.assistantMessage.parts, content: live.content || e.assistantMessage.content }
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
    case 'approval':
    case 'inbox':
    case 'visual':
    case 'context':
    case 'compaction':
    case 'delta':
    case 'tool':
    case 'agent':
    case 'image':
    case 'tool_image':
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
      // Not after a compaction (`/compact`, context.ts): housekeeping is nothing to read.
      if (e.message.status !== 'stopped') patchThread(threadId, (t) => (t.totemId || isCompactionTurn(t.messages[t.messages.findIndex((m) => m.id === e.message.id) - 1]) ? t : { ...t, needsReply: true, ...(t.snoozedUntil && t.snoozedUntil > now() && !t.snoozeHeld ? { snoozedUntil: now() } : {}) }))
      break
    case 'error':
      patchAssistant(threadId, (m) => ({ ...m, status: 'error', error: e.text }))
      break
    case 'end': {
      setRun(threadId, null)
      // The bridge's copy is the settled one (ids, counts), and a chat sent to before
      // its window arrived has only the new turn: read the window now.
      void loadThread(threadId, { fresh: true })
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
      if (r) { if (!state.runs[threadId]) watchRun(threadId, 0, r.mode as ChatMode, r.startedAt); return }
    } catch (e) { if (fail(e)) return }
    if (++tries < 4) setTimeout(look, 400 * tries)
    else syncThreads()
  }
  setTimeout(look, 150)
}

function watchRun(threadId: string, since: number, mode: ChatMode, startedAt: number, tries = 0) {
  setRun(threadId, { seq: since, activity: '', mode, startedAt })
  let failed: any = null
  const handle = attachRun(threadId, since, (e) => handleEvent(threadId, e), (err) => {
    if (fail(err)) { setRun(threadId, null); return }
    failed = err
  })
  setRun(threadId, { handle })
  handle.done.then(() => {
    // Ended without an `end`: dropped, gone silent, or refused. Never leave the
    // run set (it locks send, retry and regenerate): attach again, or let go and re-read.
    if (state.runs[threadId]?.handle !== handle) return
    const seq = state.runs[threadId].seq
    setRun(threadId, null)
    // Dropped for going silent, or on coming back to the app: attach again at once.
    // Any other close without `end` counts as a try, so a cut-short stream backs off.
    void reattach(threadId, seq, mode, startedAt, handle.stalled && !failed ? tries : tries + 1, failed?.status === 404)
  })
}

/** After a stream ends early: watch the run again if the bridge still has it running, else re-read the chat. */
async function reattach(threadId: string, seq: number, mode: ChatMode, startedAt: number, tries: number, gone = false) {
  if (!gone && tries < 4) {
    if (tries) await new Promise((r) => setTimeout(r, 1000 * 2 ** tries))
    try {
      const { runs } = await getRuns()
      if (runs.some((r) => r.threadId === threadId && r.status === 'running')) {
        if (!state.runs[threadId]) watchRun(threadId, seq, mode, startedAt, tries)
        return
      }
    } catch (e) {
      if (fail(e)) return
      if (!state.runs[threadId]) return reattach(threadId, seq, mode, startedAt, tries + 1)
      return
    }
  }
  syncThreads()
  void loadThread(threadId)
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
  /** A new chat started from a task, linked to it from the first turn. */
  taskId?: string
  /** "Compact and send" (context.ts): the chat compacts first and the message waits right behind it. */
  compactFirst?: boolean
  /** The bridge refused the message before starting it (not a message that never reached it, which stays as "Not sent"). */
  onRefused?: () => void
}

/** Start a turn. Returns the thread id (new chats get one here). */
export function send(input: SendInput): string {
  const threadId = input.threadId || newId()
  if (state.runs[threadId]) return threadId
  let thread = state.threads.find((t) => t.id === threadId) || null
  const projectId = thread ? thread.projectId : (input.projectId || undefined)
  const kind = projectId ? 'regular' : thread?.kind || input.kind || 'regular'
  // Chosen from the chat as the list has it: a summary's preview still names its last reply's account and model.
  const { provider, row, settings } = threadChoice(thread, { provider: input.provider, modelSettings: input.modelSettings, projectId })
  // Sent before the chat's window arrived: its preview is no part of the chat. The
  // new turn stands alone until the run ends and the window is read (history.ts).
  if (thread?.summary) {
    const { summary: _s, ...rest } = thread
    thread = { ...rest, messages: [], history: { hasMore: (thread.messageCount || thread.messages.length) > 0, before: null } }
  }
  const wire = wireModel(row?.driver || 'cursor', settings)
  const t0 = now()
  // Compact and send: what shows at once is the compaction, with his message waiting behind it.
  const compactFirst = !!thread && !!input.compactFirst
  const userMessage: ChatMessage = compactFirst
    ? { id: `local-${newId()}`, role: 'user', content: '/compact', command: 'compact', createdAt: t0 }
    : {
        id: `local-${newId()}`, role: 'user', content: input.text, createdAt: t0,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.mode && input.mode !== 'chat' ? { mode: input.mode } : {}),
        ...(input.voice ? { voice: true } : {}),
      }
  const assistant: ChatMessage = {
    id: `local-${newId()}`, role: 'assistant', content: '', status: 'streaming', provider, createdAt: t0,
    parts: compactFirst ? [{ type: 'compaction', id: `local-${newId()}`, status: 'running', trigger: 'onReturn', startedAt: t0 }] : [],
  }
  const contextOff = !!projectId && !thread && !!input.projectContextOff
  const taskId = !thread && input.taskId ? input.taskId : undefined
  if (!thread) {
    thread = {
      id: threadId, kind, provider: kind === 'regular' ? provider : undefined, modelSettings: settings,
      ...(projectId ? { projectId } : {}), ...(contextOff ? { projectContextOff: true } : {}), ...(taskId ? { taskId } : {}),
      messages: [], createdAt: t0, updatedAt: t0, ...(kind === 'temporary' ? { expiresAt: endOfToday() } : {}),
    }
  }
  const queue = compactFirst ? [{ id: `local-${newId()}`, text: input.text, attachments: input.attachments || [], createdAt: t0 }, ...(thread.queue || [])] : thread.queue
  upsertThread({ ...thread, messages: [...thread.messages, userMessage, assistant], updatedAt: t0, ...(compactFirst ? { queue } : {}) })
  const args: SendArgs = {
    threadId, text: input.text, attachments: (input.attachments || []).map((a) => a.id), provider,
    // The bridge keeps this model only when the turn runs on `provider`; a
    // temporary chat held to the default account drops it there.
    model: wire.model, effort: wire.effort, kind,
    modelSettings: settings, mode: input.mode || 'chat', voice: input.voice,
    ...(input.browser ? { browser: true } : {}),
    // Only read for a chat the bridge hasn't seen; an existing one keeps its project.
    ...(projectId ? { projectId } : {}),
    ...(contextOff ? { projectContextOff: true } : {}),
    ...(taskId ? { taskId } : {}),
    ...(compactFirst ? { compactFirst: true } : {}),
  }
  const { messages: _m, needsReply: _n, keepUnread: _k, ...meta } = thread
  // Unsent, Retry and Discard work on what he wrote; a compact-first send carries it in its args.
  const unsentAs: ChatMessage = compactFirst
    ? { id: userMessage.id, role: 'user', content: input.text, createdAt: t0, ...(input.attachments?.length ? { attachments: input.attachments } : {}) }
    : userMessage
  outboxPut(threadId, { args, message: unsentAs, thread: { ...meta, updatedAt: t0 }, at: t0 })
  return startRun(threadId, args, input.onRefused)
}

/** Send an unsent message again (or drop it if it turns out the bridge got it). `onRefused` as for `send`. */
export async function retryUnsent(threadId: string, onRefused?: () => void) {
  const e = readOutbox()[threadId]
  if (!e || state.runs[threadId]) return
  await syncThreads() // maybe it reached the bridge after all
  const still = readOutbox()[threadId]
  if (!still) { resumeRuns(); return }
  patchThread(threadId, (t) => ({
    ...t,
    messages: [
      ...t.messages.map((m) => (m.id === e.message.id ? { ...e.message } : m)),
      { id: `local-${newId()}`, role: 'assistant' as const, content: '', parts: [], status: 'streaming' as const, provider: e.args.provider || undefined, createdAt: now() },
    ],
  }))
  startRun(threadId, e.args, onRefused)
}

/** Take an unsent message back out of the chat, returning its text for the composer. */
export function discardUnsent(threadId: string): string {
  const e = readOutbox()[threadId]
  outboxDrop(threadId)
  if (!e) return ''
  // Compact and send: what he wrote is the message, not the compaction shown for it.
  if (e.args.compactFirst) patchThread(threadId, (t) => ({ ...t, queue: (t.queue || []).filter((q) => !q.id.startsWith('local-')) }))
  patchThread(threadId, (t) => ({ ...t, messages: t.messages.filter((m) => m.id !== e.message.id) }))
  if (!state.threads.find((t) => t.id === threadId)?.messages.length) set((s) => ({ threads: s.threads.filter((t) => t.id !== threadId) }))
  return e.message.content
}

function startRun(threadId: string, args: SendArgs, onRefused?: () => void) {
  setRun(threadId, { seq: 0, activity: '', mode: args.mode || 'chat', startedAt: now() })
  // Replying (or regenerating, or editing) is what clears "waiting on you".
  wakeOnOwnerMessage(threadId, true)
  let began = false
  const handle = sendChat(args, (e) => { if (e.type === 'start') began = true; handleEvent(threadId, e) }, (err: any) => {
    if (fail(err)) { setRun(threadId, null); return }
    // Never reached the bridge: the message stays, marked unsent, with Retry —
    // and with no empty reply bubble under it. (A 4xx is a real refusal, not a
    // lost message: that keeps the old error-on-the-reply behaviour.)
    const box = readOutbox()[threadId]
    if (box && !(err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429)) {
      const reason = (err.message || 'The connection dropped')
      box.message.sendError = reason
      outboxPut(threadId, box)
      // Compact and send shows what he wrote, not the compaction that was to run first.
      const local = (m: ChatMessage) => (m.parts || []).every((p) => p.type === 'compaction' && p.id.startsWith('local-'))
      patchThread(threadId, (t) => ({
        ...t,
        ...(box.args.compactFirst ? { queue: (t.queue || []).filter((q) => !q.id.startsWith('local-')) } : {}),
        messages: t.messages
          .filter((m) => !(m.role === 'assistant' && m.status === 'streaming' && !m.content && local(m)))
          .map((m) => (m.id === box.message.id ? { ...box.message, unsent: true, sendError: reason } : m)),
      }))
      setRun(threadId, null)
      return
    }
    if (box) outboxDrop(threadId)
    if (!began) onRefused?.()
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
      // Dropped before `start`: the bridge may have it or not. The sync says which
      // (withOutbox drops a message that got through, else it shows Not sent).
      else { syncThreads().then(resumeRuns); void loadThread(threadId) }
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
    wakeOnOwnerMessage(threadId)
    return true
  } catch (e: any) {
    if (!fail(e)) pushError(e?.status === 409 ? 'That reply had already finished. Your message is still in the box.' : `Couldn't send that: ${e.message}`)
    return false
  }
}

/**
 * Decide on a tool call waiting for approval (chat/approvals.mjs). The new status
 * arrives through the run's own stream. False when the request had already ended.
 */
export async function respondToApproval(threadId: string, messageId: string, partId: string, decision: ApprovalDecision, feedback?: string): Promise<boolean> {
  try {
    await decideApproval(threadId, messageId, partId, decision, feedback)
    if (decision === 'decline' && feedback?.trim()) wakeOnOwnerMessage(threadId)
    return true
  } catch (e: any) {
    if (!fail(e)) pushError(e?.status === 409 ? (e.message || 'That request has ended.') : `Couldn't send that: ${e.message}`)
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
    takeQueue(threadId, await changeQueue(threadId, { action: 'add', text, attachments: attachments.map((a) => a.id), provider, model: wire.model ?? undefined, effort: wire.effort ?? undefined, modelSettings: settings }))
    wakeOnOwnerMessage(threadId)
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
    if (change.action === 'steer') wakeOnOwnerMessage(threadId)
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
    regenerate: true, mode: lastUser?.mode || 'chat',
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
    model: wire.model, effort: wire.effort, editMessageId: messageId, mode: original.mode || 'chat',
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
  // A summary's preview holds only the last turn; the first message comes with it.
  const first = plainRefs(t.firstUserText || t.messages.find((m) => m.role === 'user')?.content || '').replace(/\s+/g, ' ').trim()
  if (first) return first.length > 48 ? `${first.slice(0, 48)}…` : first
  return t.kind === 'temporary' ? 'Ghost chat' : 'New chat'
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
