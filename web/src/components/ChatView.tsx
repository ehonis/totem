import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { COMMANDS } from '../shortcuts'
import { useCommand } from '../useShortcuts'
import { getSkills, AuthError } from '../api'
import { setChatCommands } from '../studio'
import {
  useChat, initChat, send, stop, steer, queueMessage, updateQueue, setActive, setThreadModel, keepThread, threadChoice, draftFor, type DraftPick,
  threadTitle, providerById, loadCapabilities, loadProviders, ensureModels, getState, takeVoiceRequest, regenerateTitle,
  openProject, threadProject, projectById, setProjectContext, settleThread, unsettleThread, wakeThread, markRead, setMembers,
  loadFiles, openArtifact, openFile, openResource, takePendingFile, respondToApproval,
} from '../chat/store'
import { useTotemDirectory } from '../totems/shared'
import { GroupPicker } from './TotemsView'
import { isSnoozed, settledAt, wakeDescription } from '../chat/settle'
import ProjectHome from '../chat/ProjectHome'
import ProjectIcon from '../chat/ProjectIcon'
import Composer, { type ComposerHandle, type FollowUpPayload } from '../chat/Composer'
import QueuedMessages from '../chat/QueuedMessages'
import { pushToast } from '../toast'
import MessageLog from '../chat/MessageLog'
import { useQuestionFlow } from '../chat/QuestionsPanel'
import { pendingQuestions } from '../chat/questions'
import { DECLINE_PLACEHOLDER, pendingApproval } from '../chat/approvals'
import ModelPicker from '../chat/ModelPicker'
import HandoffMark from '../chat/HandoffMark'
import VoiceMode from '../chat/VoiceMode'
import ArtifactPanel from '../chat/ArtifactPanel'
import BrowserPanel from '../chat/BrowserPanel'
import AgentsPanel from '../chat/AgentsPanel'
import ChatHeader, { MembersPop } from '../chat/ChatHeader'
import { usePanelItems } from '../chat/HeaderPanels'
import FilesPanel from '../chat/FilesPanel'
import { useChatPresence } from '../chat/presence'
import { useViewing } from '../chat/onScreen'
import { contextVersion, subscribeContext, takeContext } from '../chat/pendingContext'
import { TI } from '../chat/ui'
import { IconArrowDown, IconPaperclip } from '../chat/icons'
import type { Attachment, ModelSettings, QueuedMessage } from '../chat/types'
import '../chat/chat.css'
import { chatGlow } from '../chat/glow'
import { useSettings } from '../settings'
import { useOwnerName } from '../useOwnerName'
import ResizeHandle, { SIDE_PANEL_VAR } from './ResizeHandle'

function greeting(name: string) {
  const h = new Date().getHours()
  const part = h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  return name ? `${part}, ${name}` : part
}

// Starters for an empty chat. Things Totem can actually do with what it's
// connected to; "fill" puts text in the box for him to finish.
const STARTERS: { text: string; fill?: boolean }[] = [
  { text: 'What’s on my plate today?' },
  { text: 'How am I doing on this week’s goals?' },
  { text: 'Plan my week around my calendar' },
  { text: 'Remind me to ', fill: true },
]

const DRAFTS_KEY = 'totem.chat.drafts'
function readDrafts(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}') || {} } catch { return {} }
}

/** The Totems tab, on one totem's settings when given its id. */
function goTotems(id?: string) {
  window.history.pushState({}, '', id ? `/totems?totem=${encodeURIComponent(id)}` : '/totems')
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.('(max-width: 720px)').matches ?? false)
  useEffect(() => {
    const mq = window.matchMedia?.('(max-width: 720px)')
    if (!mq) return
    const on = (e: MediaQueryListEvent) => setNarrow(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return narrow
}

interface ChatViewProps {
  /** Opens the CLIProxy tab from the usage panel; unset when the proxy is not set up. */
  onManageUsage?: () => void
  onAuthError: () => void
  visible?: boolean
  /** Phone: open the app drawer (tabs + chats). */
  onOpenMenu?: () => void
  /** Desktop: whether the chats panel is showing, and a way to bring it back. */
  panelOpen?: boolean
  onShowPanel?: () => void
}

export default function ChatView({ onAuthError, visible = true, onOpenMenu, panelOpen = true, onShowPanel, onManageUsage }: ChatViewProps) {
  const ownerName = useOwnerName()
  const narrow = useNarrow()
  const threads = useChat((s) => s.threads)
  const runs = useChat((s) => s.runs)
  const activeId = useChat((s) => s.activeId)
  const caps = useChat((s) => s.caps)
  const artifact = useChat((s) => s.artifact)
  const browserShown = useChat((s) => s.browserOpen && !!(s.activeId && s.browser[s.activeId]))
  const agentsShown = useChat((s) => s.agentsOpen && !!s.activeId)
  const filesShown = useChat((s) => s.filesOpen && !!s.activeId)
  const retitling = useChat((s) => !!(s.activeId && s.retitling[s.activeId]))
  const [artifactWide, setArtifactWide] = useState(false)
  const providers = useChat((s) => s.providers)
  const models = useChat((s) => s.models)
  const [draftKind, setDraftKind] = useState<'regular' | 'temporary'>('regular')
  // A model picked for a new chat, for the place (project, folder or Home) it was picked in.
  const [draftPick, setDraftPick] = useState<DraftPick | null>(null)
  // A new project chat can start without the project's instructions, memory and files.
  const [draftContextOff, setDraftContextOff] = useState(false)
  // The project the panel is showing. A new chat here starts in it, on its default model.
  const scopeId = useChat((s) => s.projectId)
  const scopeProject = useChat((s) => s.projects.find((p) => p.id === s.projectId))
  // Home's new chat offers the projects to start in instead, most recently used first.
  const allProjects = useChat((s) => s.projects)
  const startInProjects = useMemo(() => allProjects.filter((p) => !p.parentId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6), [allProjects])
  const [drafts, setDrafts] = useState<Record<string, string>>(readDrafts)
  const [voice, setVoice] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [picking, setPicking] = useState(false)
  const totemDir = useTotemDirectory()
  const panelItems = usePanelItems(activeId)
  const membersRef = useRef<HTMLButtonElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const composer = useRef<ComposerHandle>(null)
  const dragDepth = useRef(0)

  useEffect(() => { initChat(onAuthError) }, [onAuthError])
  // Finished replies push to the phone unless this chat is on screen.
  useChatPresence(activeId, visible)
  // and the running-chats panel leaves it out.
  useViewing('main', visible ? activeId : null)

  // The "/" skill menu is whatever skills the bridge has; refreshed on focus so a
  // skill renamed in Studio shows up here without a reload.
  useEffect(() => {
    const load = () => getSkills().then((p) => setChatCommands(p.skills || [], p.agentSkills || [])).catch((e) => { if (e instanceof AuthError) onAuthError() })
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [onAuthError])

  // The phone's one-tap voice button: arrive on a new chat already talking.
  useEffect(() => {
    if (visible && takeVoiceRequest()) { setDraftKind('regular'); setVoice(true) }
  }, [visible])

  // Search's "Add to chat": results waiting for the composer, as attachment chips.
  const pendingContext = useSyncExternalStore(subscribeContext, contextVersion, contextVersion)
  useEffect(() => {
    if (!visible) return
    const items = takeContext()
    if (!items.length) return
    // The composer mounts with the tab; wait a frame for its ref.
    requestAnimationFrame(() => {
      items.forEach((a) => composer.current?.addAttachment(a))
      composer.current?.focus()
    })
  }, [visible, pendingContext])

  // Coming back to the tab: the Providers tab may have changed what's enabled.
  const wasVisible = useRef(visible)
  useEffect(() => {
    if (visible && !wasVisible.current) { loadProviders(); loadCapabilities() }
    wasVisible.current = visible
  }, [visible])

  const active = threads.find((t) => t.id === activeId) || null
  const autoSettleDays = useChat((s) => s.prefs.autoSettleDays ?? 3)
  // An id in the URL that isn't a thread (deleted, expired) is a new chat —
  // but only once the bridge's list has arrived, not against a cold cache.
  const loaded = useChat((s) => s.loaded)
  useEffect(() => {
    if (loaded && activeId && !active && !runs[activeId]) setActive(null)
  }, [loaded, activeId, active, runs])

  // Looking at a finished chat reads it, including a reply that lands while it's
  // open, but only while the tab is in front of him. One he marked unread to
  // come back to stays unread until he replies or marks it read.
  const unread = !!(active?.needsReply && !active.keepUnread)
  useEffect(() => {
    if (!visible || !activeId || !unread) return
    const read = () => { if (document.visibilityState === 'visible') markRead(activeId) }
    read()
    document.addEventListener('visibilitychange', read)
    return () => document.removeEventListener('visibilitychange', read)
  }, [visible, activeId, unread])

  // Mirror the open chat into the address bar while this tab is showing, so a
  // reload or a shared link lands on it.
  useEffect(() => {
    if (!visible) return
    const url = new URL(window.location.href)
    if (scopeId) url.searchParams.set('project', scopeId)
    else url.searchParams.delete('project')
    if (activeId) url.searchParams.set('thread', activeId)
    else url.searchParams.delete('thread')
    const next = url.pathname + url.search + url.hash
    if (next !== window.location.pathname + window.location.search + window.location.hash) window.history.replaceState(window.history.state, '', next)
  }, [activeId, scopeId, visible])
  useEffect(() => {
    const onPop = () => {
      const q = new URLSearchParams(window.location.search)
      const thread = q.get('thread')
      if (thread) setActive(thread)
      else openProject(q.get('project'))
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const busy = activeId ? !!runs[activeId] : false

  // The chat's saved files, listed on opening it and again when a reply ends.
  useEffect(() => { if (activeId && !busy) loadFiles(activeId) }, [activeId, busy])
  // A file path in a reply opens in the canvas (links.ts routes the click), and so
  // does one the bridge redirected here (?file=, read at load by the store). In the
  // desktop app, anything else on the Totem server a link points at opens here too.
  useEffect(() => {
    if (!visible) return
    const onFile = (e: Event) => { e.preventDefault(); openFile((e as CustomEvent<string>).detail) }
    const onResource = (e: Event) => { e.preventDefault(); openResource((e as CustomEvent<string>).detail) }
    window.addEventListener('totem:open-file', onFile)
    window.addEventListener('totem:open-resource', onResource)
    return () => { window.removeEventListener('totem:open-file', onFile); window.removeEventListener('totem:open-resource', onResource) }
  }, [visible])
  useEffect(() => {
    const path = visible ? takePendingFile() : null
    if (path) openFile(path)
  }, [visible])

  const glow = chatGlow(activeId)
  const glowOn = useSettings().chatGlow
  // The glow keeps its brightening filter while the swing dies away after a
  // reply (glow.css), then drops it so an idle chat skips that render pass.
  const [glowSettling, setGlowSettling] = useState(false)
  useEffect(() => {
    if (busy) { setGlowSettling(true); return }
    const t = window.setTimeout(() => setGlowSettling(false), 1200)
    return () => window.clearTimeout(t)
  }, [busy])
  const run = activeId ? runs[activeId] : undefined
  // The chat's project (or, for a new chat, the one the panel is in).
  const project = active ? threadProject(active) : scopeProject
  const parentProject = project?.parentId ? projectById(project.parentId) : undefined
  const contextOff = active ? !!active.projectContextOff : draftContextOff
  const kind = project ? 'regular' : active?.kind || draftKind
  const temporary = kind === 'temporary'
  const draftKey = activeId || (project ? `new:project:${project.id}` : `new:${kind}`)
  // A new chat starts on what was picked for it here, else its folder's or
  // project's model (threadChoice). A pick never follows him to another place,
  // and an open chat keeps its own model.
  const draft = draftFor(draftPick, draftKey, { open: !!active, projectId: project?.id })
  const choice = threadChoice(active, draft)
  const messages = active?.messages || []
  const empty = messages.length === 0
  const input = drafts[draftKey] || ''
  useEffect(() => { ensureModels(choice.provider) }, [choice.provider])

  const setInput = useCallback((v: string) => {
    setDrafts((d) => {
      const next = { ...d, [draftKey]: v }
      if (!v) delete next[draftKey]
      try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(next)) } catch {}
      return next
    })
  }, [draftKey])

  // A discarded unsent message goes back in the composer. Stable, so the message log stays memoized.
  const onDiscarded = useCallback((text: string) => {
    setInput(text)
    requestAnimationFrame(() => composer.current?.focus())
  }, [setInput])

  /** Open a project for a new chat, taking what's already typed along. */
  function startIn(id: string) {
    if (input.trim()) {
      setDrafts((d) => {
        const next = { ...d, [`new:project:${id}`]: d[`new:project:${id}`] || input }
        delete next[draftKey]
        try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(next)) } catch {}
        return next
      })
    }
    openProject(id)
  }

  // --- scrolling ---------------------------------------------------------------
  // Follow the reply while you're at the bottom; stop the moment you scroll up to
  // read something, and offer a way back. Opening a chat always starts at the bottom.
  const pinned = useRef(true)
  const onScroll = () => {
    const el = scrollRef.current
    // Hidden behind another tab there is no layout to judge by.
    if (!el || !el.clientHeight) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    setAtBottom(pinned.current)
  }
  const scrollToBottom = (smooth = true) => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }
  // The view isn't rendered behind another tab, so showing it is opening the chat too.
  useLayoutEffect(() => { pinned.current = true; scrollToBottom(false); setAtBottom(true) }, [activeId, visible]) // eslint-disable-line react-hooks/exhaustive-deps
  const lastContent = messages[messages.length - 1]?.content.length || 0
  const lastParts = messages[messages.length - 1]?.parts?.length || 0
  useLayoutEffect(() => { if (pinned.current) scrollToBottom(false) }, [messages.length, lastContent, lastParts, run?.activity]) // eslint-disable-line react-hooks/exhaustive-deps
  // Code blocks, images and Markdown keep growing the log after its first layout:
  // stay at the bottom through that while pinned.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => { if (pinned.current) el.scrollTop = el.scrollHeight })
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [empty, activeId, visible])

  // --- actions -----------------------------------------------------------------
  function newChat(k: 'regular' | 'temporary' = 'regular') {
    // Leaving a chat for a new one keeps the panel's project: the new chat is in it.
    setActive(null)
    setDraftKind(k)
    setDraftPick(null)
    setDraftContextOff(false)
    requestAnimationFrame(() => composer.current?.focus())
  }
  useCommand(COMMANDS.chatNew, () => newChat('regular'))
  // A new chat started from anywhere (the panel, the rail, a project) is ready to type
  // into; not on a touch screen, where focusing would throw up the keyboard.
  useEffect(() => {
    if (!visible || activeId || window.matchMedia?.('(pointer: coarse)').matches) return undefined
    const raf = requestAnimationFrame(() => composer.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [visible, activeId, draftKey])
  // T3's settle toggle, on the leader (`g c s`).
  useCommand(COMMANDS.chatSettle, () => {
    const id = getState().activeId
    const t = id ? getState().threads.find((x) => x.id === id) : null
    if (!t || !t.messages.length) return
    if (t.settledOverride === 'settled') unsettleThread(t.id)
    else settleThread(t.id)
  })

  function onSend({ text, attachments }: { text: string; attachments: Attachment[] }) {
    const id = send({ threadId: activeId, text, attachments, kind, provider: draft.provider, modelSettings: draft.modelSettings, projectId: active ? undefined : project?.id, projectContextOff: !active && !!project && draftContextOff })
    setInput('')
    if (id !== activeId) {
      setDraftPick(null)
      setDrafts((d) => { const n = { ...d }; delete n[draftKey]; return n })
      setActive(id)
    }
    setAtBottom(true)
    requestAnimationFrame(() => scrollToBottom())
  }

  // --- the queue (T3 Code's follow-ups) ----------------------------------------
  // Enter while a reply runs queues or steers, as Settings → Chat says; Ctrl/⌘ the other.
  const followUp = useChat((s) => s.prefs.followUp ?? 'queue')
  const queue = active?.queue || []
  // A queued message being edited in the composer, and the draft it displaced.
  const [queueEdit, setQueueEdit] = useState<{ id: string; threadId: string; draftKey: string; stash: { text: string; attachments: Attachment[] } } | null>(null)
  const putBack = (stash: { text: string; attachments: Attachment[] }) => {
    setInput(stash.text)
    composer.current?.setAttachments(stash.attachments)
  }
  function editQueued(q: QueuedMessage) {
    if (!activeId) return
    const stash = queueEdit ? queueEdit.stash : { text: input, attachments: composer.current?.takeAttachments() || [] }
    setQueueEdit({ id: q.id, threadId: activeId, draftKey, stash })
    setInput(q.text)
    composer.current?.setAttachments(q.attachments || [])
    requestAnimationFrame(() => composer.current?.focus())
  }
  function cancelQueueEdit() {
    if (!queueEdit) return
    putBack(queueEdit.stash)
    setQueueEdit(null)
  }
  // Leaving the chat drops the edit; his own draft goes back where it was.
  useEffect(() => {
    if (queueEdit && queueEdit.threadId !== activeId) {
      setDrafts((d) => ({ ...d, [queueEdit.draftKey]: queueEdit.stash.text }))
      setQueueEdit(null)
    }
  }, [activeId, queueEdit])
  // It started (or another device removed it) mid-edit: as T3 Code does, keep
  // the edit as the draft if the box had none, otherwise put his draft back.
  const editGone = !!queueEdit && queueEdit.threadId === activeId && !queue.some((q) => q.id === queueEdit.id)
  useEffect(() => {
    if (!editGone || !queueEdit) return
    const { stash } = queueEdit
    setQueueEdit(null)
    if (!stash.text.trim() && !stash.attachments.length) pushToast('Queued message is no longer queued. Your unsaved edit was kept in the composer.', 'info')
    else { putBack(stash); pushToast('Queued message is no longer queued. Your unsaved edit was discarded.', 'info') }
  }, [editGone])
  // A tool call waiting on his approval (chat/approvals.ts): as in T3 Code, a
  // message declines it and its words tell the agent why. Files go on as a steer.
  const waitingApproval = active ? pendingApproval(active) : null
  const declineWith = async (p: FollowUpPayload) => {
    if (!activeId || !waitingApproval) return false
    const ok = await respondToApproval(activeId, waitingApproval.message.id, waitingApproval.part.id, 'decline', p.text.trim() || undefined)
    if (ok && p.attachments.length) await steer(activeId, '', p.attachments.map((a) => a.id))
    return ok
  }
  const onQueue = (p: FollowUpPayload) => (waitingApproval ? declineWith(p) : activeId ? queueMessage(activeId, p.text, p.attachments) : false)
  const onSteerNow = (p: FollowUpPayload) => (waitingApproval ? declineWith(p) : activeId ? steer(activeId, p.text, p.attachments.map((a) => a.id)) : false)
  const saveQueueEdit = async (p: FollowUpPayload) => {
    if (!queueEdit) return false
    const ok = await updateQueue(queueEdit.threadId, { action: 'edit', id: queueEdit.id, text: p.text, attachments: p.attachments.map((a) => a.id) })
    if (ok) { putBack(queueEdit.stash); setQueueEdit(null) }
    return ok
  }
  const queueEl = activeId && queue.length ? (
    <QueuedMessages
      queue={queue}
      canSteer={busy}
      editingId={queueEdit?.threadId === activeId ? queueEdit.id : null}
      onEdit={editQueued}
      onCancelEdit={cancelQueueEdit}
      onSteer={(id) => { void updateQueue(activeId, { action: 'steer', id }) }}
      onRemove={(id) => { if (queueEdit?.id === id) cancelQueueEdit(); void updateQueue(activeId, { action: 'remove', id }) }}
      onMove={(id, beforeId) => { void updateQueue(activeId, { action: 'move', id, beforeId }) }}
    />
  ) : null

  function changeModel(patch: { provider: string; modelSettings: ModelSettings }) {
    // Picking a model builds its settings afresh; the chat's access stays.
    const access = patch.modelSettings.access ?? choice.settings.access
    if (access) patch = { ...patch, modelSettings: { ...patch.modelSettings, access } }
    if (active) setThreadModel(active.id, patch)
    else setDraftPick({ key: draftKey, ...patch })
  }

  // --- drag and drop anywhere on the chat --------------------------------------
  const onDragEnter = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    dragDepth.current += 1
    setDragging(true)
  }
  const onDragLeave = () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false) }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (e.dataTransfer.files?.length) composer.current?.addFiles(e.dataTransfer.files)
  }

  const providerState = caps?.providers?.[choice.provider]?.state

  // The agent's questions (T3's pending user input): a panel above the composer,
  // and the composer's box is the typed answer while they are open.
  const questionFlow = useQuestionFlow({
    threadId: activeId,
    pending: active ? pendingQuestions(active) : null,
    // The run that asked has ended: the answers are the next message.
    sendText: (text, files) => {
      if (!activeId) return
      if (busy) void steer(activeId, text, files.map((f) => f.id))
      else send({ threadId: activeId, text, attachments: files, kind })
    },
    displace: (text) => setInput(input.trim() ? `${input.replace(/\s+$/, '')}\n${text}` : text),
  })

  const composerEl = (
    <Composer
      rightSlot={
        <div className="vc-model-group">
          {/* T3 Code's chip: the model and its effort as one control, whose picker also
              holds speed and the chat's access. Answering questions, it names the model
              only, to leave room for the answer buttons. */}
          <ModelPicker provider={choice.provider} settings={choice.settings} onChange={changeModel} started={!empty} locked={temporary && !empty} align="end" traits compact={!!questionFlow?.answering} />
        </div>
      }
      ref={composer}
      value={questionFlow ? questionFlow.value : input}
      onChange={questionFlow ? questionFlow.onChange : setInput}
      answering={questionFlow?.answering}
      onSend={onSend}
      onStop={() => activeId && stop(activeId)}
      onSteer={onSteerNow}
      onQueue={empty ? undefined : onQueue}
      followUp={followUp}
      queueEdit={queueEdit && queueEdit.threadId === activeId ? { onSave: saveQueueEdit } : undefined}
      onResume={!busy && active?.queueHeld && queue.length && activeId ? () => { void updateQueue(activeId, { action: 'resume' }) } : undefined}
      above={queueEl}
      onVoice={() => setVoice(true)}
      busy={busy}
      autoFocus={visible}
      placeholder={waitingApproval ? DECLINE_PLACEHOLDER : temporary ? 'Temporary chat — gone at midnight' : project && empty ? `New chat in ${project.name}` : 'Ask Totem anything'}
      allowCommands={!temporary}
      maxUploadBytes={caps?.maxUploadBytes}
      onAuthError={onAuthError}
    />
  )

  // A settled or snoozed chat says so above the composer, as T3 does.
  const parkedEl = (() => {
    if (!active || empty || busy) return null
    const at = Date.now()
    if (isSnoozed(active, at)) {
      return (
        <div className="vc-parked">
          <span>Snoozed until {wakeDescription(active.snoozedUntil!, at)}. Send a message to wake it.</span>
          <button type="button" className="vc-btn sm ghost" onClick={() => wakeThread(active.id)}>Wake now</button>
        </div>
      )
    }
    if (!settledAt(active, at, autoSettleDays)) return null
    return (
      <div className="vc-parked">
        <span>This chat is settled. Send a message to bring it back.</span>
        <button type="button" className="vc-btn sm ghost" onClick={() => unsettleThread(active.id)}>Un-settle</button>
      </div>
    )
  })()

  if (!visible) return null

  // The chat moving to another account (chat/handoff.ts): a row over the
  // composer once a new account is picked (MessageLog marks each move).
  const lastProvider = [...messages].reverse().find((m) => m.role === 'assistant' && m.provider)?.provider
  const pendingHandoff = active && !temporary && lastProvider && lastProvider !== choice.provider
    ? <HandoffMark s={{ from: lastProvider, to: choice.provider }} pending />
    : null

  // The one side panel showing, if any, and its own remembered width.
  const sidePanel = artifact ? { id: 'canvas', label: 'Resize the canvas' }
    : agentsShown ? { id: 'agents', label: 'Resize the agents panel' }
    : filesShown ? { id: 'files', label: 'Resize the files panel' }
    : browserShown ? { id: 'browser', label: 'Resize the browser panel' }
    : null

  return (
    <div className={`vc-split${artifact || browserShown || agentsShown || filesShown ? ' has-artifact' : ''}${artifact && artifactWide ? ' artifact-wide' : ''}`}>
    <div className={`vc${glowOn ? '' : ' no-glow'}`} onDragEnter={onDragEnter} onDragOver={(e) => e.preventDefault()} onDragLeave={onDragLeave} onDrop={onDrop}>
      {/* This chat's own colours; they wobble while the agent is replying. Settings → Chat can turn them off on this device. */}
      {glowOn && <div className={`page-glow${busy ? ' live' : glowSettling ? ' settling' : ''}`} style={{ '--glow-a': glow.a, '--glow-b': glow.b } as React.CSSProperties} aria-hidden />}
      {glowOn && <div className="vc-veil" aria-hidden />}
      <ChatHeader
        start={narrow ? 'menu' : !panelOpen ? 'panel' : null}
        onOpenMenu={onOpenMenu}
        onShowPanel={onShowPanel}
        onNewChat={() => newChat()}
        parentProject={parentProject}
        project={project}
        projectIsLast={!(active && !empty)}
        contextOff={contextOff}
        onOpenProject={openProject}
        onToggleContext={project ? () => (active ? setProjectContext(active.id, contextOff) : setDraftContextOff(!contextOff)) : undefined}
        totemsCrumb={!!(active?.totemId || active?.members?.length)}
        onTotems={goTotems}
        thread={active && !empty ? active : undefined}
        title={!project || (active && !empty) ? (active && !empty ? threadTitle(active) : temporary ? 'Temporary chat' : 'New chat') : undefined}
        retitling={retitling}
        onRetitle={active && !empty ? () => regenerateTitle(active.id) : undefined}
        totem={active?.totemId ? { id: active.totemId, job: totemDir.get(active.totemId) } : undefined}
        members={active && !active.totemId ? { ids: active.members || [], dir: totemDir, onPick: () => setPicking((v) => !v), ref: membersRef } : undefined}
        panels={panelItems}
        onManageUsage={onManageUsage}
        onKeep={temporary && active ? () => keepThread(active.id) : undefined}
        temporary={(!active || empty) && !project ? { on: temporary, onToggle: () => newChat(temporary ? 'regular' : 'temporary') } : undefined}
        newChatAtEnd={narrow}
      />
      {picking && active && !active.totemId && (
        <MembersPop anchor={membersRef} onClose={() => setPicking(false)}>
          <GroupPicker
            jobs={[...totemDir.values()]}
            initial={active.members?.length ? active.members : []}
            title={active.members?.length ? 'Totems in this chat' : 'Bring totems into this chat'}
            action="Save"
            allowEmpty={!!active.members?.length}
            onCancel={() => setPicking(false)}
            onDone={(ids) => { setMembers(active.id, ids); setPicking(false) }}
          />
        </MembersPop>
      )}

      <div className="vc-scroll" ref={scrollRef} onScroll={onScroll}>
        {empty && project ? (
          <ProjectHome projectId={project.id} composer={composerEl} maxUploadBytes={caps?.maxUploadBytes} />
        ) : empty ? (
          <div className="vc-empty">
            <h1 className="vc-greet">{temporary ? 'Temporary chat' : greeting(ownerName)}</h1>
            {temporary && <p className="vc-empty-note">This chat won’t be kept after midnight.</p>}
            {providerState && providerState !== 'ready' && providerState !== 'unknown' && (
              <p className="vc-empty-warn">{providerById(choice.provider)?.name} is {providerState === 'missing' ? 'not installed on this machine' : providerState === 'logged-out' ? 'signed out' : 'not responding'}. Pick another account above{caps?.providers?.[choice.provider]?.fix ? `, or run ${caps.providers[choice.provider].fix}` : ''}.</p>
            )}
            {!narrow && <div className="vc-empty-composer">{composerEl}</div>}
            {!temporary && startInProjects.length > 0 && (
              <div className="vc-start-in">
                <span className="vc-start-in-label">Start in</span>
                {startInProjects.map((p) => (
                  <button key={p.id} type="button" className="vc-start-in-chip" onClick={() => startIn(p.id)} title={`New chat in ${p.name}`}>
                    <ProjectIcon p={p} size={15} />
                    <span>{p.name}</span>
                  </button>
                ))}
              </div>
            )}
            {!temporary && (
              <div className="vc-starters">
                {STARTERS.map((s) => (
                  <button key={s.text} type="button" className="vc-starter" onClick={() => {
                    if (s.fill) { setInput(s.text); requestAnimationFrame(() => composer.current?.focus()) }
                    else onSend({ text: s.text, attachments: [] })
                  }}>
                    {s.text}{s.fill ? '…' : ''}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <MessageLog
            threadId={active?.id ?? null}
            messages={messages}
            busy={busy}
            activity={run?.activity}
            provider={choice.provider}
            providers={providers}
            models={models}
            onDiscarded={onDiscarded}
          />
        )}
      </div>

      {(!empty || (narrow && !project)) && (
        <div className="vc-dock">
          {!empty && !atBottom && (
            <button type="button" className="vc-jump" onClick={() => scrollToBottom()} aria-label="Scroll to the latest message"><TI icon={IconArrowDown} size={18} /></button>
          )}
          {questionFlow ? questionFlow.panel : <>{parkedEl}{pendingHandoff}</>}
          {composerEl}
        </div>
      )}

      {dragging && (
        <div className="vc-drop">
          <div className="vc-drop-inner"><TI icon={IconPaperclip} size={28} /><span>Drop files to add them to the chat</span></div>
        </div>
      )}

      {voice && (
        <VoiceMode
          threadId={activeId}
          kind={kind}
          onThread={(id) => setActive(id)}
          onClose={() => setVoice(false)}
        />
      )}
    </div>
    {sidePanel && (
      <ResizeHandle
        key={`${sidePanel.id}${artifact && artifactWide ? ':wide' : ''}`}
        role="side"
        className="inline"
        storageKey={`totem.panel.${sidePanel.id}.width`}
        cssVar={SIDE_PANEL_VAR}
        label={sidePanel.label}
      />
    )}
    {artifact && <ArtifactPanel threadId={activeId} expanded={artifactWide} onExpand={setArtifactWide} />}
    {!artifact && <AgentsPanel threadId={activeId} />}
    {!artifact && <FilesPanel threadId={activeId} />}
    {!artifact && <BrowserPanel threadId={activeId} />}
    </div>
  )
}

export { threadTitle }
