import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { COMMANDS } from '../shortcuts'
import { useCommand } from '../useShortcuts'
import { getSkills, AuthError } from '../api'
import { setChatCommands } from '../studio'
import {
  useChat, initChat, send, stop, regenerate, editAndResend, setActive, setThreadModel, keepThread, threadChoice,
  threadTitle, providerById, loadCapabilities, retryUnsent, discardUnsent, loadProviders, ensureModels, getState, takeVoiceRequest, regenerateTitle,
  openProject, threadProject, projectById, setProjectContext,
} from '../chat/store'
import ProjectHome from '../chat/ProjectHome'
import ProjectIcon from '../chat/ProjectIcon'
import Composer, { type ComposerHandle } from '../chat/Composer'
import { UserMessage, AssistantMessage } from '../chat/Message'
import ModelPicker from '../chat/ModelPicker'
import ThinkingControl, { hintFor } from '../chat/ThinkingControl'
import PowerControl, { useRoutePreview } from '../chat/PowerControl'
import { EFFORT_LABELS, LEVEL_NAMES, visibleModels } from '../chat/models'
import VoiceMode from '../chat/VoiceMode'
import QuickChat from '../chat/QuickChat'
import ArtifactPanel from '../chat/ArtifactPanel'
import BrowserPanel, { BrowserChip } from '../chat/BrowserPanel'
import UsageChips from '../chat/UsageChips'
import ThreadIcon from '../chat/ThreadIcon'
import { useChatPresence } from '../chat/presence'
import { TI } from '../chat/ui'
import { IconArrowDown, IconEdit, IconGhost2, IconMenu, IconPaperclip, IconLayoutSidebar, IconSparkles, IconFolder, IconFolderOff } from '../chat/icons'
import type { Attachment, ChatMode, ModelSettings } from '../chat/types'
import '../chat/chat.css'
import { useOwnerName } from '../useOwnerName'

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
  onAuthError: () => void
  visible?: boolean
  /** Bring the Chat tab forward (quick chat's "Open in chat"). */
  onOpenChat?: () => void
  /** Phone: open the app drawer (tabs + chats). */
  onOpenMenu?: () => void
  /** Desktop: whether the chats panel is showing, and a way to bring it back. */
  panelOpen?: boolean
  onShowPanel?: () => void
}

export default function ChatView({ onAuthError, visible = true, onOpenChat, onOpenMenu, panelOpen = true, onShowPanel }: ChatViewProps) {
  const ownerName = useOwnerName()
  const narrow = useNarrow()
  const threads = useChat((s) => s.threads)
  const runs = useChat((s) => s.runs)
  const activeId = useChat((s) => s.activeId)
  const caps = useChat((s) => s.caps)
  const artifact = useChat((s) => s.artifact)
  const browserShown = useChat((s) => s.browserOpen && !!(s.activeId && s.browser[s.activeId]))
  const retitling = useChat((s) => !!(s.activeId && s.retitling[s.activeId]))
  const [artifactWide, setArtifactWide] = useState(false)
  const providers = useChat((s) => s.providers)
  const models = useChat((s) => s.models)
  const [draftKind, setDraftKind] = useState<'regular' | 'temporary'>('regular')
  const [draftModel, setDraftModel] = useState<{ provider?: string; modelSettings?: ModelSettings }>({})
  // A new project chat can start without the project's instructions, memory and files.
  const [draftContextOff, setDraftContextOff] = useState(false)
  // The project the panel is showing. A new chat here starts in it, on its default model.
  const scopeId = useChat((s) => s.projectId)
  const scopeProject = useChat((s) => s.projects.find((p) => p.id === s.projectId))
  const [drafts, setDrafts] = useState<Record<string, string>>(readDrafts)
  const [voice, setVoice] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const composer = useRef<ComposerHandle>(null)
  const dragDepth = useRef(0)

  useEffect(() => { initChat(onAuthError) }, [onAuthError])
  // Finished replies push to the phone unless this chat is on screen.
  useChatPresence(activeId, visible)

  // The "/" skill menu is whatever skills the bridge has; refreshed on focus so a
  // skill renamed in Studio shows up here without a reload.
  useEffect(() => {
    const load = () => getSkills().then((p) => setChatCommands(p.skills || [])).catch((e) => { if (e instanceof AuthError) onAuthError() })
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [onAuthError])

  // The phone's one-tap voice button: arrive on a new chat already talking.
  useEffect(() => {
    if (visible && takeVoiceRequest()) { setDraftKind('regular'); setVoice(true) }
  }, [visible])

  // Coming back to the tab: the Providers tab may have changed what's enabled.
  const wasVisible = useRef(visible)
  useEffect(() => {
    if (visible && !wasVisible.current) { loadProviders(); loadCapabilities() }
    wasVisible.current = visible
  }, [visible])

  const active = threads.find((t) => t.id === activeId) || null
  // An id in the URL that isn't a thread (deleted, expired) is a new chat —
  // but only once the bridge's list has arrived, not against a cold cache.
  const loaded = useChat((s) => s.loaded)
  useEffect(() => {
    if (loaded && activeId && !active && !runs[activeId]) setActive(null)
  }, [loaded, activeId, active, runs])

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
  const run = activeId ? runs[activeId] : undefined
  // The chat's project (or, for a new chat, the one the panel is in).
  const project = active ? threadProject(active) : scopeProject
  const parentProject = project?.parentId ? projectById(project.parentId) : undefined
  const contextOff = active ? !!active.projectContextOff : draftContextOff
  const kind = project ? 'regular' : active?.kind || draftKind
  const temporary = kind === 'temporary'
  // A new project chat starts on the project's model until he picks another.
  const draft = !active && project && !draftModel.provider && project.provider
    ? { provider: project.provider, modelSettings: project.modelSettings as ModelSettings | undefined }
    : draftModel
  const choice = threadChoice(active, draft)
  const messages = active?.messages || []
  const empty = messages.length === 0
  const draftKey = activeId || (project ? `new:project:${project.id}` : `new:${kind}`)
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

  // --- scrolling ---------------------------------------------------------------
  // Follow the reply while you're at the bottom; stop the moment you scroll up to
  // read something, and offer a way back.
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }
  const scrollToBottom = (smooth = true) => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }
  useLayoutEffect(() => { scrollToBottom(false); setAtBottom(true) }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps
  const lastContent = messages[messages.length - 1]?.content.length || 0
  const lastParts = messages[messages.length - 1]?.parts?.length || 0
  useLayoutEffect(() => { if (atBottom) scrollToBottom(false) }, [messages.length, lastContent, lastParts, run?.activity]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- actions -----------------------------------------------------------------
  function newChat(k: 'regular' | 'temporary' = 'regular') {
    // Leaving a chat for a new one keeps the panel's project: the new chat is in it.
    setActive(null)
    setDraftKind(k)
    setDraftModel({})
    setDraftContextOff(false)
    requestAnimationFrame(() => composer.current?.focus())
  }
  useCommand(COMMANDS.chatNew, () => newChat('regular'))

  function onSend({ text, attachments, mode, browser }: { text: string; attachments: Attachment[]; mode: ChatMode; browser?: boolean }) {
    const id = send({ threadId: activeId, text, attachments, mode, browser, kind, provider: draft.provider, modelSettings: draft.modelSettings, projectId: active ? undefined : project?.id, projectContextOff: !active && !!project && draftContextOff })
    setInput('')
    if (id !== activeId) {
      setDrafts((d) => { const n = { ...d }; delete n[draftKey]; return n })
      setActive(id)
    }
    setAtBottom(true)
    requestAnimationFrame(() => scrollToBottom())
  }

  function changeModel(patch: { provider: string; modelSettings: ModelSettings }) {
    if (active) setThreadModel(active.id, patch)
    else setDraftModel(patch)
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

  // Computer use moves the turn to Codex, so any enabled Codex account that can
  // do it counts; otherwise show why the first Codex account can't.
  const capList = Object.values(caps?.providers || {})
  const computerAny = capList.find((p) => p.computerUse?.available)?.computerUse
    || capList.find((p) => p.driver === 'codex')?.computerUse
    || { available: false, reason: 'Computer use runs on Codex. Enable a Codex account in Settings → Providers.' }
  const providerState = caps?.providers?.[choice.provider]?.state

  // ChatGPT's "Thinking effort": the Thinking preset's five levels, or — for a
  // hand-picked reasoning model — that model's own effort levels.
  // Auto: say what it will use before you send, live as you type.
  const isAuto = choice.settings.preset === 'auto'
  const preview = useRoutePreview({ enabled: isAuto, threadId: empty ? null : activeId, text: input, attachments: 0, mode: 'chat', power: choice.settings.power })

  const effortEl = (() => {
    const st = choice.settings
    if (st.preset === 'auto') {
      return (
        <PowerControl
          power={st.power || ''}
          preview={preview}
          onChange={(v) => changeModel({ provider: choice.provider, modelSettings: { ...st, power: v || undefined } })}
        />
      )
    }
    if (st.preset === 'thinking') {
      const efforts = ['low', 'medium', 'high', 'xhigh', 'max']
      return (
        <ThinkingControl
          stops={['1', '2', '3', '4', '5'].map((v, i) => ({ value: v, label: LEVEL_NAMES[v], hint: hintFor(efforts[i]) }))}
          value={st.level || '2'}
          onChange={(v) => changeModel({ provider: choice.provider, modelSettings: { ...st, level: v } })}
        />
      )
    }
    if (st.preset !== 'manual') return null
    const m = visibleModels(models[choice.provider]).concat(models[choice.provider] || []).find((x) => x.id === st.modelId)
    if (!m?.efforts?.length) return null
    return (
      <ThinkingControl
        stops={m.efforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] || e, hint: hintFor(e) }))}
        value={st.effort && st.effort !== 'default' ? st.effort : (m.defaultEffort || m.efforts[0])}
        onChange={(v) => changeModel({ provider: choice.provider, modelSettings: { ...st, effort: v } })}
      />
    )
  })()

  const composerEl = (
    <Composer
      leftSlot={<ModelPicker provider={choice.provider} settings={choice.settings} onChange={changeModel} locked={!empty} compact={isAuto} />}
      rightSlot={effortEl}
      onThinkLonger={choice.settings.preset === 'thinking' || (!empty && choice.settings.preset === 'manual') ? undefined : () => changeModel({ provider: choice.provider, modelSettings: { ...choice.settings, preset: 'thinking' } })}
      ref={composer}
      value={input}
      onChange={setInput}
      onSend={onSend}
      onStop={() => activeId && stop(activeId)}
      onVoice={() => setVoice(true)}
      busy={busy}
      autoFocus={visible}
      placeholder={temporary ? 'Temporary chat — gone at midnight' : project && empty ? `New chat in ${project.name}` : 'Ask Totem anything'}
      allowCommands={!temporary}
      computerUse={computerAny}
      maxUploadBytes={caps?.maxUploadBytes}
      onAuthError={onAuthError}
    />
  )

  if (!visible) return narrow ? null : <QuickChat onOpenChat={() => onOpenChat?.()} />

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  // A raw id ("gpt-6.1-sol", "composer-2.5[fast=true]") is shown as its catalog name.
  const modelNameFor = (provider?: string, model?: string) => {
    if (!provider || !model) return undefined
    const id = model.split('[')[0]
    return getState().models[provider]?.find((x) => x.id === id)?.name
  }

  return (
    <div className={`vc-split${artifact || browserShown ? ' has-artifact' : ''}${artifact && artifactWide ? ' artifact-wide' : ''}`}>
    <div className="vc" onDragEnter={onDragEnter} onDragOver={(e) => e.preventDefault()} onDragLeave={onDragLeave} onDrop={onDrop}>
      <header className="vc-top">
        {narrow && (
          <button type="button" className="vc-icon-btn" onClick={onOpenMenu} aria-label="Menu"><TI icon={IconMenu} size={21} /></button>
        )}
        {/* Panel collapsed: the header carries what it held — show chats, new chat. */}
        {!narrow && !panelOpen && (
          <>
            <button type="button" className="vc-icon-btn" onClick={onShowPanel} aria-label="Show chats" title="Show chats"><TI icon={IconLayoutSidebar} size={19} /></button>
            <button type="button" className="vc-icon-btn" onClick={() => newChat()} aria-label="New chat" title="New chat"><TI icon={IconEdit} size={19} /></button>
          </>
        )}
        <div className="vc-top-title-wrap">
          {parentProject && (
            <>
              <button type="button" className="vc-top-project" onClick={() => openProject(parentProject.id)} title={`Open ${parentProject.name}`}>
                <ProjectIcon p={parentProject} size={16} />
                <span>{parentProject.name}</span>
              </button>
              <span className="vc-top-sep" aria-hidden>/</span>
            </>
          )}
          {project && (
            <button type="button" className={`vc-top-project ${contextOff ? 'context-off' : ''}`} onClick={() => openProject(project.id)} title={`Open ${project.name}`}>
              <ProjectIcon p={project} size={16} />
              <span>{project.name}</span>
            </button>
          )}
          {project && active && !empty && <span className="vc-top-sep" aria-hidden>/</span>}
          {active?.totemId && (
            <>
              <button
                type="button"
                className="vc-top-project"
                title="Open this totem's settings, memory and runs"
                onClick={() => { window.history.pushState({}, '', `/totems?totem=${encodeURIComponent(active.totemId!)}`); window.dispatchEvent(new PopStateEvent('popstate')) }}
              >
                <TI icon={IconSparkles} size={15} /><span>Totem</span>
              </button>
              <span className="vc-top-sep" aria-hidden>/</span>
            </>
          )}
          {active && !empty && <ThreadIcon t={active} size={17} busy={retitling} />}
          {(!project || (active && !empty)) && <div className={`vc-top-title ${retitling ? 'vc-shimmer vc-retitling' : ''}`}>{active && !empty ? threadTitle(active) : temporary ? 'Temporary chat' : 'New chat'}</div>}
          {active && !empty && (
            <button type="button" className="vc-retitle" onClick={() => regenerateTitle(active.id)} disabled={retitling} aria-label="Regenerate title and icon" title="Regenerate title and icon from the whole chat">
              <TI icon={IconSparkles} size={15} className={retitling ? 'vc-retitle-spin' : ''} />
            </button>
          )}
        </div>
        <div className="vc-top-right">
          {project && (
            <button
              type="button"
              className={`vc-icon-btn ${contextOff ? 'on' : ''}`}
              onClick={() => (active ? setProjectContext(active.id, contextOff) : setDraftContextOff(!contextOff))}
              aria-pressed={contextOff}
              aria-label={contextOff ? 'Project context is off for this chat' : 'Project context is on for this chat'}
              title={contextOff
                ? `Project context off: this chat doesn't read ${project.name}'s instructions, memory or files, and adds nothing to them. Click to turn it on.`
                : `Project context on: this chat reads ${project.name}'s instructions, memory and files. Click to leave them out of this chat.`}
            >
              <TI icon={contextOff ? IconFolderOff : IconFolder} size={19} />
            </button>
          )}
          <BrowserChip threadId={activeId} />
          <UsageChips compact={narrow} />
          {temporary && active && (
            <button type="button" className="vc-btn sm" onClick={() => keepThread(active.id)} title="Keep this chat after midnight">Keep</button>
          )}
          {(!active || empty) && !project && (
            <button
              type="button"
              className={`vc-icon-btn ${temporary ? 'on' : ''}`}
              onClick={() => newChat(temporary ? 'regular' : 'temporary')}
              aria-pressed={temporary}
              title={temporary ? 'Turn off temporary chat' : 'Temporary chat — not kept past midnight'}
            >
              <TI icon={IconGhost2} size={19} />
            </button>
          )}
          {narrow && (
            <button type="button" className="vc-icon-btn" onClick={() => newChat()} aria-label="New chat"><TI icon={IconEdit} size={19} /></button>
          )}
        </div>
      </header>

      <div className="vc-scroll" ref={scrollRef} onScroll={onScroll}>
        {empty && project ? (
          <ProjectHome projectId={project.id} composer={composerEl} maxUploadBytes={caps?.maxUploadBytes} />
        ) : empty ? (
          <div className="vc-empty">
            <h1 className="vc-greet">{temporary ? 'Temporary chat' : greeting(ownerName)}</h1>
            {temporary && <p className="vc-empty-note">This chat won’t be kept after midnight.</p>}
            {choice.settings.preset === 'manual' && providerState && providerState !== 'ready' && providerState !== 'unknown' && (
              <p className="vc-empty-warn">{providerById(choice.provider)?.name} is {providerState === 'missing' ? 'not installed on this machine' : providerState === 'logged-out' ? 'signed out' : 'not responding'}. Pick another account above{caps?.providers?.[choice.provider]?.fix ? `, or run ${caps.providers[choice.provider].fix}` : ''}.</p>
            )}
            {!narrow && <div className="vc-empty-composer">{composerEl}</div>}
            {!temporary && (
              <div className="vc-starters">
                {STARTERS.map((s) => (
                  <button key={s.text} type="button" className="vc-starter" onClick={() => {
                    if (s.fill) { setInput(s.text); requestAnimationFrame(() => composer.current?.focus()) }
                    else onSend({ text: s.text, attachments: [], mode: 'chat' })
                  }}>
                    {s.text}{s.fill ? '…' : ''}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="vc-log">
            {messages.map((m, i) => (
              m.role === 'user'
                ? <UserMessage
                    key={m.id}
                    m={m}
                    canEdit={!busy && !m.id.startsWith('local-')}
                    onEdit={(text) => active && editAndResend(active.id, m.id, text)}
                    onRetry={m.unsent && active && !busy ? () => retryUnsent(active.id) : undefined}
                    onDiscard={m.unsent && active && !busy ? () => { const text = discardUnsent(active.id); if (text) setInput(text); requestAnimationFrame(() => composer.current?.focus()) } : undefined}
                  />
                : <AssistantMessage
                    key={m.id}
                    m={m}
                    live={busy && i === messages.length - 1}
                    activity={run?.activity}
                    provider={providerById(m.provider || choice.provider) || providers.find((p) => p.driver === m.provider)}
                    modelName={modelNameFor(m.provider, m.model)}
                    isLast={m === lastAssistant && i === messages.length - 1}
                    onRegenerate={!busy && active ? () => regenerate(active.id) : undefined}
                  />
            ))}
          </div>
        )}
      </div>

      {!empty && !atBottom && (
        <button type="button" className="vc-jump" onClick={() => scrollToBottom()} aria-label="Scroll to the latest message"><TI icon={IconArrowDown} size={18} /></button>
      )}
      {(!empty || (narrow && !project)) && <div className="vc-dock">{composerEl}</div>}

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
    {artifact && <ArtifactPanel threadId={activeId} expanded={artifactWide} onExpand={setArtifactWide} />}
    {!artifact && <BrowserPanel threadId={activeId} />}
    </div>
  )
}

export { threadTitle }
