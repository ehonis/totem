// The Chat (web components/ChatView.tsx, phone layout): ChatGPT's top bar (☰,
// the chat's title, the usage pill, temporary-chat ghost, new chat), the
// conversation, and the composer docked at the bottom riding the keyboard.
// Everything about a chat's data lives in lib/chat/store (one sync loop shared
// with the drawer); this screen only renders it and turns taps into store calls.
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AppState, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useFocusEffect, useIsFocused, useNavigation } from 'expo-router'
import { MenuView } from '@react-native-menu/menu'
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated'
import {
  useChat, send, stop, steer, regenerate, editAndResend, setActive, setThreadModel, keepThread, threadChoice,
  threadTitle, providerById, loadCapabilities, retryUnsent, discardUnsent, loadProviders, ensureModels, getState,
  takeVoiceRequest, openProject, threadProject, projectById, setProjectContext,
} from '../../lib/chat/store'
import { contextVersion, subscribeContext, takeContext } from '../../lib/chat/pendingContext'
import { useViewing } from '../../lib/chat/onScreen'
import { EFFORT_LABELS, visibleModels } from '../../lib/chat/models'
import { isSnoozed, settledAt, shelfOf, wakeDescription, wokeAt } from '../../lib/chat/settle'
import type { ChatThread } from '../../lib/chat/types'
import type { Attachment, ChatMessage, ChatMode, ModelSettings } from '../../lib/chat/types'
import { useOwnerName } from '../../lib/useOwnerName'
import { AuthError, getSkills } from '../../lib/api'
import { setChatCommands } from '../../lib/studio'
import { pushToast } from '../../lib/toast'
import { openDrawer } from '../../shell/nav'
import { openVoice, takeDictationHandoff } from '../voice/handoff'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { impact, tap } from '../../ui/haptics'
import Composer, { type ComposerHandle } from './Composer'
import { UserMessage, AssistantMessage } from './Message'
import { ModelChip } from './ModelPicker'
import { AccessControl, ThinkingControl, hintFor } from './controls'
import UsageChips from './UsageChips'
import { AgentsChip } from './AgentsPanel'
import RunningChats from './RunningChats'
import ChatFrame, { type ChatFrameHandle } from './ChatFrame'
import { ThreadIcon, ProjectIcon } from './ThreadIcon'
import ProjectHome from './ProjectHome'
import { threadMenu } from './threadMenu'
import { markRead, unsettleThread, wakeThread } from './threadOps'
import { useChatPresence } from './presence'
import { TI, vc } from './ui'
import { PageGlow } from '../../ui/PageGlow'
import { chatGlow } from '../../lib/chat/glow'
import { IconArrowDown, IconEdit, IconGhost2, IconMenu, IconFolder, IconFolderOff, IconSparkles, IconChevronDown } from './icons'

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

export default function ChatScreen() {
  const insets = useSafeAreaInsets()
  const navigation = useNavigation()
  const focused = useIsFocused()
  const ownerName = useOwnerName()
  const threads = useChat((s) => s.threads)
  const runs = useChat((s) => s.runs)
  const activeId = useChat((s) => s.activeId)
  const caps = useChat((s) => s.caps)
  const providers = useChat((s) => s.providers)
  const models = useChat((s) => s.models)
  const loaded = useChat((s) => s.loaded)
  const retitling = useChat((s) => !!(s.activeId && s.retitling[s.activeId]))
  const autoSettleDays = useChat((s) => s.prefs.autoSettleDays ?? 3)
  const scopeProject = useChat((s) => s.projects.find((p) => p.id === s.projectId))
  const [draftKind, setDraftKind] = useState<'regular' | 'temporary'>('regular')
  const [draftModel, setDraftModel] = useState<{ provider?: string; modelSettings?: ModelSettings }>({})
  const [draftContextOff, setDraftContextOff] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>(readDrafts)
  const [atEnd, setAtEnd] = useState(true)
  const composer = useRef<ComposerHandle>(null)
  const frame = useRef<ChatFrameHandle>(null)

  const active = (threads.find((t) => t.id === activeId) || null) as ChatThread | null
  // An id that isn't a thread (deleted, expired) is a new chat, once the bridge's list has arrived.
  useEffect(() => {
    if (loaded && activeId && !active && !runs[activeId]) setActive(null)
  }, [loaded, activeId, active, runs])

  // Finished replies push to the phone unless this chat is on screen,
  // and the running-chats pill leaves it out.
  useChatPresence(activeId, focused)
  useViewing('main', focused ? activeId : null)

  // The "/" skill menu is whatever skills the bridge has; refreshed when the app
  // comes back so a skill renamed on the web shows up here.
  useEffect(() => {
    const load = () => getSkills().then((p: any) => setChatCommands(p.skills || [], p.agentSkills || [])).catch((e) => { if (!(e instanceof AuthError)) console.warn('skills', e?.message) })
    load()
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') load() })
    return () => sub.remove()
  }, [])

  // Opening a chat that woke from a snooze is seeing it: the "Woke" mark goes.
  useEffect(() => { if (active && wokeAt(active, Date.now())) wakeThread(active.id) }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Looking at a finished chat reads it, including a reply that lands while it's
  // open, but only while the app is in front of him. One he marked unread to
  // come back to stays unread until he replies or marks it read.
  const unread = !!(active?.needsReply && !active.keepUnread)
  useEffect(() => {
    if (!focused || !activeId || !unread) return
    const read = () => { if (AppState.currentState === 'active') markRead(activeId) }
    read()
    const sub = AppState.addEventListener('change', read)
    return () => sub.remove()
  }, [focused, activeId, unread])

  // Coming back to the screen: the Providers tab may have changed what's enabled.
  const wasFocused = useRef(focused)
  useEffect(() => {
    if (focused && !wasFocused.current) { loadProviders(); loadCapabilities() }
    wasFocused.current = focused
  }, [focused])

  // The voice button from anywhere: a fresh chat with voice mode over it. And
  // voice mode that couldn't run (no realtime on the bridge) hands back here to
  // dictate instead, saying why.
  useFocusEffect(useCallback(() => {
    if (takeVoiceRequest()) {
      setDraftKind('regular')
      const t = setTimeout(() => openVoice({ threadId: null, kind: 'regular' }), 50)
      return () => clearTimeout(t)
    }
    const why = takeDictationHandoff()
    if (!why) return
    const t = setTimeout(() => {
      composer.current?.dictate()
      pushToast(`${why} Dictating instead: talk, then tap ✓.`, 'info', { duration: 5000 })
    }, 350)
    return () => clearTimeout(t)
  }, []))

  // Search's "Add to chat": results waiting for the composer, as attachment chips.
  const pendingContext = useSyncExternalStore(subscribeContext, contextVersion, contextVersion)
  useEffect(() => {
    if (!focused) return
    const items = takeContext()
    if (!items.length) return
    requestAnimationFrame(() => { items.forEach((a) => composer.current?.addAttachment(a)); composer.current?.focus() })
  }, [focused, pendingContext])

  const busy = activeId ? !!runs[activeId] : false
  const run = activeId ? runs[activeId] : undefined
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

  function newChat(k: 'regular' | 'temporary' = 'regular') {
    impact()
    setActive(null)
    setDraftKind(k)
    setDraftModel({})
    setDraftContextOff(false)
  }

  // Every run may use the browser, computer use and the long task budget; the
  // agent decides, so the app sends neither a mode switch nor a browser flag.
  function onSend({ text, attachments, mode }: { text: string; attachments: Attachment[]; mode: ChatMode }) {
    const id = send({ threadId: activeId, text, attachments, mode, kind, provider: draft.provider, modelSettings: draft.modelSettings, projectId: active ? undefined : project?.id, projectContextOff: !active && !!project && draftContextOff })
    setInput('')
    if (id !== activeId) {
      setDrafts((d) => { const n = { ...d }; delete n[draftKey]; return n })
      setActive(id)
    }
    setAtEnd(true)
    requestAnimationFrame(() => frame.current?.scrollToEnd())
  }

  function changeModel(patch: { provider: string; modelSettings: ModelSettings }) {
    // Picking a model builds its settings afresh; the chat's access stays.
    const access = patch.modelSettings.access ?? choice.settings.access
    if (access) patch = { ...patch, modelSettings: { ...patch.modelSettings, access } }
    if (active) setThreadModel(active.id, patch)
    else setDraftModel(patch)
  }

  const providerState = caps?.providers?.[choice.provider]?.state

  // ChatGPT's "Thinking effort": the picked reasoning model's own effort levels.
  const effortEl = (() => {
    const st = choice.settings
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

  // A settled or snoozed chat says so above the composer, as T3 does.
  const parkedEl = (() => {
    if (!active || empty || busy) return null
    const at = Date.now()
    if (isSnoozed(active, at)) {
      return (
        <View style={st.parked}>
          <T size={13} color={vc.soft} style={{ flex: 1 }}>Snoozed until {wakeDescription(active.snoozedUntil!, at)}. Send a message to wake it.</T>
          <Press style={st.ghostBtn} onPress={() => { tap(); wakeThread(active.id) }}><T size={13} weight={500} color={vc.soft}>Wake now</T></Press>
        </View>
      )
    }
    if (!settledAt(active, at, autoSettleDays)) return null
    return (
      <View style={st.parked}>
        <T size={13} color={vc.soft} style={{ flex: 1 }}>This chat is settled. Send a message to bring it back.</T>
        <Press style={st.ghostBtn} onPress={() => { tap(); unsettleThread(active.id) }}><T size={13} weight={500} color={vc.soft}>Un-settle</T></Press>
      </View>
    )
  })()

  const lastAssistantId = useMemo(() => [...messages].reverse().find((m) => m.role === 'assistant')?.id, [messages])
  // A raw id ("gpt-6.1-sol", "composer-2.5[fast=true]") is shown as its catalog name.
  const modelNameFor = (provider?: string, model?: string) => {
    if (!provider || !model) return undefined
    const id = model.split('[')[0]
    return getState().models[provider]?.find((x) => x.id === id)?.name
  }

  const renderItem = (m: ChatMessage, i: number) => {
    const last = i === messages.length - 1
    return (
      <View style={{ paddingHorizontal: 16, paddingBottom: last ? 16 : 24 }}>
        {m.role === 'user' ? (
          <UserMessage
            m={m}
            canEdit={!busy && !m.id.startsWith('local-')}
            onEdit={(text) => active && editAndResend(active.id, m.id, text)}
            onRetry={m.unsent && active && !busy ? () => retryUnsent(active.id) : undefined}
            onDiscard={m.unsent && active && !busy ? () => { const text = discardUnsent(active.id); if (text) setInput(text); requestAnimationFrame(() => composer.current?.focus()) } : undefined}
          />
        ) : (
          <AssistantMessage
            m={m}
            live={busy && last}
            activity={last ? run?.activity : undefined}
            provider={providerById(m.provider || choice.provider) || providers.find((p) => p.driver === m.provider)}
            modelName={modelNameFor(m.provider, m.model)}
            isLast={m.id === lastAssistantId && last}
            onRegenerate={!busy && active ? () => regenerate(active.id) : undefined}
          />
        )}
      </View>
    )
  }

  const emptyEl = !empty ? null : project ? (
    <ProjectHome projectId={project.id} />
  ) : (
    <View style={st.empty}>
      <T size={26} weight={500} style={{ letterSpacing: -0.26, marginBottom: 18 }} lineHeight={34}>{temporary ? 'Temporary chat' : greeting(ownerName)}</T>
      {temporary ? <T size={14} lineHeight={21} color={vc.soft} style={{ marginTop: -8, marginBottom: 16 }}>This chat won’t be kept after midnight.</T> : null}
      {providerState && providerState !== 'ready' && providerState !== 'unknown' ? (
        <T size={14} lineHeight={21} color="#f0cd72" style={{ marginTop: -8, marginBottom: 16 }}>
          {providerById(choice.provider)?.name} is {providerState === 'missing' ? 'not installed on this machine' : providerState === 'logged-out' ? 'signed out' : 'not responding'}. Pick another account below{caps?.providers?.[choice.provider]?.fix ? `, or run ${caps.providers[choice.provider].fix}` : ''}.
        </T>
      ) : null}
      {!temporary ? (
        <View style={st.starters}>
          {STARTERS.map((s) => (
            <Press
              key={s.text}
              style={st.starter}
              onPress={() => {
                tap()
                if (s.fill) { setInput(s.text); requestAnimationFrame(() => composer.current?.focus()) }
                else { impact(); onSend({ text: s.text, attachments: [], mode: 'chat' }) }
              }}
            >
              <T size={13.5} color={vc.soft}>{s.text}{s.fill ? '…' : ''}</T>
            </Press>
          ))}
        </View>
      ) : null}
    </View>
  )

  const titleText = active && !empty ? threadTitle(active) : temporary ? 'Temporary chat' : 'New chat'
  const titleMenu = active && !empty ? threadMenu(active, shelfOf(active, Date.now(), autoSettleDays, busy), busy) : null
  const titleEl = (
    <View style={st.titleRow}>
      {active && !empty ? <ThreadIcon t={active} size={17} busy={retitling} /> : null}
      <T size={17} weight={600} numberOfLines={1} style={{ flexShrink: 1, opacity: retitling ? 0.55 : 1 }}>{titleText}</T>
      {titleMenu ? <TI icon={IconChevronDown} size={14} color={vc.faint} /> : null}
    </View>
  )

  return (
    <View style={[st.screen, { paddingTop: insets.top }]}>
      {/* This chat's own colours; they wobble while the agent is replying. */}
      <PageGlow colors={chatGlow(activeId)} live={busy} />
      <View style={st.top}>
        <Press style={st.iconBtn} onPress={() => { tap(); openDrawer(navigation) }} accessibilityLabel="Menu" hitSlop={6}>
          <TI icon={IconMenu} size={22} color={colors.text} />
        </Press>
        <View style={st.titleWrap}>
          {/* With a chat open there's room only for the project's glyph; its page shows the names. */}
          {parentProject && !(active && !empty) ? (
            <>
              <Press style={st.crumb} onPress={() => { tap(); openProject(parentProject.id) }} accessibilityLabel={`Open ${parentProject.name}`}>
                <ProjectIcon p={parentProject} size={16} /><T size={14} color={vc.soft} numberOfLines={1} style={{ flexShrink: 1 }}>{parentProject.name}</T>
              </Press>
              <T size={14} color={vc.faint}>/</T>
            </>
          ) : null}
          {project ? (
            <Press style={[st.crumb, contextOff && { opacity: 0.6 }]} onPress={() => { tap(); openProject(project.id) }} accessibilityLabel={`Open ${project.name}`}>
              <ProjectIcon p={project} size={16} />
              {!(active && !empty) ? <T size={14} color={vc.soft} numberOfLines={1} style={{ flexShrink: 1 }}>{project.name}</T> : null}
            </Press>
          ) : null}
          {project && active && !empty ? <T size={14} color={vc.faint}>/</T> : null}
          {active?.totemId ? (
            <Press style={st.crumb} onPress={() => { tap(); router.navigate({ pathname: '/totems', params: { totem: active.totemId } }) }} accessibilityLabel="Open this totem">
              <TI icon={IconSparkles} size={15} /><T size={14} color={vc.soft}>Totem</T>
            </Press>
          ) : null}
          {!project || (active && !empty) ? (
            titleMenu ? (
              <MenuView style={{ flexShrink: 1 }} actions={titleMenu.actions} themeVariant="dark" onOpenMenu={tap} onPressAction={({ nativeEvent }) => { tap(); titleMenu.run(nativeEvent.event) }}>
                {titleEl}
              </MenuView>
            ) : titleEl
          ) : null}
        </View>
        <View style={st.topRight}>
          {project ? (
            <Press
              style={[st.iconBtn, contextOff && st.iconOn]}
              onPress={() => { tap(); if (active) setProjectContext(active.id, contextOff); else setDraftContextOff(!contextOff) }}
              accessibilityLabel={contextOff ? 'Project context is off for this chat' : 'Project context is on for this chat'}
              accessibilityState={{ selected: contextOff }}
            >
              <TI icon={contextOff ? IconFolderOff : IconFolder} size={20} color={contextOff ? colors.text : vc.soft} />
            </Press>
          ) : null}
          <AgentsChip threadId={activeId} />
          <UsageChips />
          {temporary && active ? (
            <Press style={st.keep} onPress={() => { tap(); keepThread(active.id) }} accessibilityLabel="Keep this chat after midnight"><T size={13} weight={500}>Keep</T></Press>
          ) : null}
          {(!active || empty) && !project ? (
            <Press
              style={[st.iconBtn, temporary && st.iconOn]}
              onPress={() => newChat(temporary ? 'regular' : 'temporary')}
              accessibilityLabel={temporary ? 'Turn off temporary chat' : 'Temporary chat — not kept past midnight'}
              accessibilityState={{ selected: temporary }}
            >
              <TI icon={IconGhost2} size={21} color={temporary ? colors.text : vc.soft} />
            </Press>
          ) : null}
          <Press style={st.iconBtn} onPress={() => newChat()} accessibilityLabel="New chat">
            <TI icon={IconEdit} size={21} color={vc.soft} />
          </Press>
        </View>
      </View>

      <ChatFrame
        ref={frame}
        listKey={activeId || 'new'}
        data={messages}
        keyExtractor={(m: ChatMessage) => m.id}
        renderItem={renderItem}
        extraData={`${busy}|${run?.activity || ''}|${lastAssistantId}|${providers.length}|${Object.keys(models).length}`}
        empty={emptyEl}
        // Low, into the home-indicator gap, as ChatGPT sits.
        dockBottom={Math.max(insets.bottom - 12, 10)}
        onAtEndChange={setAtEnd}
        dock={
          <View style={st.dock}>
            {!empty && !atEnd ? (
              <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(120)} style={st.jumpWrap} pointerEvents="box-none">
                <Press style={st.jump} onPress={() => { tap(); setAtEnd(true); frame.current?.scrollToEnd() }} accessibilityLabel="Scroll to the latest message">
                  <TI icon={IconArrowDown} size={18} color={colors.text} />
                </Press>
              </Animated.View>
            ) : null}
            <RunningChats />
            {parkedEl}
            <Composer
              ref={composer}
              value={input}
              onChange={setInput}
              onSend={onSend}
              onStop={() => activeId && stop(activeId)}
              onSteer={(text) => (activeId ? steer(activeId, text) : false)}
              onVoice={() => openVoice({ threadId: activeId, kind })}
              busy={busy}
              placeholder={temporary ? 'Temporary chat — gone at midnight' : project && empty ? `New chat in ${project.name}` : 'Ask Totem anything'}
              allowCommands={!temporary}
              maxUploadBytes={caps?.maxUploadBytes}
              leftSlot={<ModelChip provider={choice.provider} settings={choice.settings} onChange={changeModel} locked={!empty} />}
              rightSlot={
                <>
                  <AccessControl value={choice.settings.access} onChange={(v) => changeModel({ provider: choice.provider, modelSettings: { ...choice.settings, access: v } })} />
                  {effortEl}
                </>
              }
            />
          </View>
        }
      />
    </View>
  )
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  top: { height: 52, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, zIndex: 3 },
  iconBtn: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  iconOn: { backgroundColor: vc.raise },
  titleWrap: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 7, minWidth: 0 },
  crumb: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, maxWidth: 160, minHeight: 36 },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  keep: { height: 30, paddingHorizontal: 12, borderRadius: 999, backgroundColor: vc.raise, borderWidth: 1, borderColor: vc.line, alignItems: 'center', justifyContent: 'center' },
  empty: { paddingHorizontal: 20, paddingBottom: 40 },
  starters: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  starter: { height: 36, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: vc.line, justifyContent: 'center' },
  dock: { paddingHorizontal: 10, backgroundColor: 'transparent' },
  parked: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6, paddingVertical: 4, paddingLeft: 14, paddingRight: 4, borderRadius: 12, backgroundColor: vc.raise },
  ghostBtn: { height: 30, paddingHorizontal: 12, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  jumpWrap: { position: 'absolute', top: -50, left: 0, right: 0, alignItems: 'center', zIndex: 3 },
  jump: {
    width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
    backgroundColor: vc.raise, borderWidth: 1, borderColor: vc.line,
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 9, shadowOffset: { width: 0, height: 6 },
  },
})
