// Everything under "New chat" in the phone drawer (web chat/ProjectNav.tsx's
// ChatsNav + ThreadList.tsx): Home's projects and recents, or one project's
// header, folders and chats. Each list keeps its parked chats on two folding
// shelves at the bottom, Snoozed and Settled (settle.ts). A row opens its chat
// on tap; swiped left it shows Snooze, Settle and "…" (the full menu), and
// long-press opens that menu too. A switch
// at the top turns it to Totems: group chats, then every totem, the one that ran
// last on top, each opening its own chat.
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { MenuView } from '@react-native-menu/menu'
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import { useChat, openProject, createProject, foldersOf, threadTitle } from '../../lib/chat/store'
import { pendingQuestions } from '../../lib/chat/questions'
import {
  shelve, shelfOf, wokeAt, countdown, ago, settledAt, isSnoozed, snoozePresets, type Shelf,
} from '../../lib/chat/settle'
import type { ChatThread, Project } from '../../lib/chat/types'
import { pushError } from '../../lib/toast'
import { colors, fonts, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { impact, tap } from '../../ui/haptics'
import { prompt, showActionTree } from '../../ui/menu'
import { groupThreads, useNow } from './threadOps'
import { threadMenu } from './threadMenu'
import { ThreadIcon, ProjectIcon } from './ThreadIcon'
import { TI } from './ui'
import Spark from './Spark'
import { totemNavRows, type TotemNavRow } from '../../lib/chat/totemNav'
import { TotemIcon, ensureTotemChat, loadJobs, useJobs } from '../totems/shared'
import {
  IconDots, IconSearch, IconX, IconFolderPlus, IconArrowLeft, IconChevronDown, IconChevronRight, IconChevronUp, IconPlus,
  IconUsersGroup, IconLayoutList, IconClock, IconCheck, IconArrowBackUp, IconAlarm,
} from './icons'
import { router } from 'expo-router'
import { navigateTo } from '../../shell/nav'
import { drawerPan } from '../../shell/drawerGesture'

const FOLDED_KEY = 'totem.projects.folded'
const OPEN_FOLDERS_KEY = 'totem.projects.openFolders'
const SHELVES_KEY = 'totem.chats.openShelves'
const SETTLED_FIRST = 10
const SETTLED_PAGE = 25
const muted80 = 'rgba(138, 145, 163, 0.8)'

const readSet = (key: string) => { try { return new Set<string>(JSON.parse(localStorage.getItem(key) || '[]')) } catch { return new Set<string>() } }

/** Some chat in these projects is waiting on the owner. A snoozed chat is out of the way until it wakes. */
function useWaiting(ids: string[]) {
  const key = ids.join(',')
  return useChat((s) => s.threads.some((t) => t.needsReply && !s.runs[t.id] && !isSnoozed(t as ChatThread, Date.now()) && !!t.projectId && key.split(',').includes(t.projectId)))
}

/** Ask for a name natively, then make the project or folder. */
async function nameAndCreate(title: string, body: (name: string) => Promise<unknown>) {
  const name = await prompt(title, { placeholder: 'Name' })
  if (!name) return
  try { await body(name) } catch (e: any) { pushError(`Couldn't create it: ${e.message}`) }
}

function LiveDot() {
  const v = useSharedValue(1)
  useEffect(() => { v.value = withRepeat(withTiming(0.5, { duration: 700 }), -1, true) }, [v])
  const style = useAnimatedStyle(() => ({ opacity: v.value, transform: [{ scale: 0.7 + 0.3 * v.value }] }))
  return <Animated.View style={[st.dot, style]} accessibilityLabel="Answering" />
}

// --- one chat --------------------------------------------------------------------------

function ThreadItem({ t, active, live, onOpen, shelf = 'active', now }: { t: ChatThread; active: boolean; live: boolean; onOpen: (id: string) => void; shelf?: Shelf; now: number }) {
  const retitling = useChat((s) => !!s.retitling[t.id])
  const autoDays = useChat((s) => s.prefs.autoSettleDays ?? 3)
  const title = threadTitle(t)
  const woke = shelf === 'active' && !!wokeAt(t, now) && !active
  const waiting = (t.needsReply && !live) || woke
  // Questions from the agent outrank everything else on the row, as in T3.
  const asking = !!pendingQuestions(t)
  const parked = shelf !== 'active' && !active
  const menu = threadMenu(t, shelf, live)
  const swipe = useRef<SwipeableMethods>(null)
  // Every swipe action is one of the menu's own ids, so both run the same code.
  const act = (id: string) => { swipe.current?.close(); tap(); menu.run(id) }
  const row = (
    <View style={[st.thread, active ? st.threadOn : st.threadOff]}>
      <Press
        style={st.threadMain}
        onPress={() => { tap(); onOpen(t.id) }}
        onLongPress={() => { impact(); showActionTree(menu.actions, (id) => { tap(); menu.run(id) }, title) }}
        accessibilityLabel={title}
        accessibilityHint="Swipe left or long-press for options"
      >
        <View style={parked ? { opacity: 0.45 } : undefined}><ThreadIcon t={t} size={16} busy={retitling} /></View>
        <T
          size={15}
          weight={waiting ? 600 : 400}
          numberOfLines={1}
          color={parked && shelf === 'settled' ? 'rgba(138, 145, 163, 0.72)' : active || waiting ? colors.text : textAlpha(86)}
          style={{ flex: 1, opacity: retitling ? 0.55 : 1 }}
        >
          {title}
        </T>
        {asking ? <View style={st.woke} accessibilityLabel="Totem asked you questions"><T size={11} weight={600} color={colors.accent}>Awaiting input</T></View>
          : live ? <LiveDot />
          : woke ? <View style={st.woke}><T size={11} weight={600} color={colors.accent}>Woke</T></View>
            : t.needsReply ? <View style={st.dot} accessibilityLabel="Waiting on you" /> : null}
        {shelf === 'snoozed' ? <T size={11.5} color={colors.accent} style={st.meta}>{countdown(t.snoozedUntil!, now)}</T> : null}
        {shelf === 'settled' ? <T size={11.5} color={muted80} style={st.meta}>{ago(settledAt(t, now, autoDays), now)}</T> : null}
      </Press>
    </View>
  )
  return (
    // No long-press MenuView around the row: inside the drawer it swallowed the
    // tap, so chats could not be opened. Long-press shows the same menu as sheets.
    // The row blocks the drawer's pan, so a left swipe opens its actions rather
    // than closing the drawer.
    <ReanimatedSwipeable
      ref={swipe}
      friction={1.4}
      rightThreshold={40}
      overshootRight={false}
      blocksExternalGesture={drawerPan()}
      renderRightActions={() => (
        <View style={st.swipe}>
          {shelf === 'snoozed' ? (
            <SwipeBtn label="Wake" icon={IconAlarm} fill={colors.accent} ink={colors.white} onPress={() => act('wake')} />
          ) : (
            <MenuView
              title="Snooze until"
              actions={[
                ...snoozePresets(new Date()).map((p) => ({ id: `snooze:${p.until}`, title: p.label, subtitle: p.when })),
                { id: 'snooze-custom', title: 'Custom…' },
              ]}
              themeVariant="dark"
              onOpenMenu={tap}
              onPressAction={({ nativeEvent }) => act(nativeEvent.event)}
            >
              <SwipeBtn label="Snooze" icon={IconClock} fill={colors.amber} ink="#1d1606" />
            </MenuView>
          )}
          {shelf === 'settled' ? (
            <SwipeBtn label="Un-settle" icon={IconArrowBackUp} fill={colors.bg3} ink={colors.text} onPress={() => act('unsettle')} />
          ) : (
            <SwipeBtn label="Settle" icon={IconCheck} fill={colors.toastSuccess} ink={colors.white} disabled={live} onPress={() => act('settle')} />
          )}
          <MenuView actions={menu.actions} themeVariant="dark" onOpenMenu={tap} onPressAction={({ nativeEvent }) => act(nativeEvent.event)}>
            <SwipeBtn label="More" icon={IconDots} fill={colors.drawerOn} ink={colors.text} />
          </MenuView>
        </View>
      )}
    >
      {row}
    </ReanimatedSwipeable>
  )
}

/** One action behind a swiped chat row. Without onPress it is the face of a MenuView. */
function SwipeBtn({ label, icon, fill, ink, disabled, onPress }: {
  label: string; icon: typeof IconDots; fill: string; ink: string; disabled?: boolean; onPress?: () => void
}) {
  const face = (
    <>
      <TI icon={icon} size={18} color={ink} />
      <T size={11} weight={600} color={ink}>{label}</T>
    </>
  )
  if (!onPress) return <View style={[st.swipeBtn, { backgroundColor: fill }]} accessible accessibilityRole="button" accessibilityLabel={label}>{face}</View>
  return (
    <Press style={[st.swipeBtn, { backgroundColor: fill }, disabled && { opacity: 0.4 }]} disabled={disabled} onPress={onPress} accessibilityLabel={disabled ? `${label} once the reply finishes` : label}>
      {face}
    </Press>
  )
}

/** Snoozed or Settled: a folding heading over its chats, folded until opened (remembered per list). */
function ShelfSection({ kind, scope, threads, activeId, runs, onOpen, now }: {
  kind: 'snoozed' | 'settled'
  scope: string
  threads: ChatThread[]
  activeId: string | null
  runs: Record<string, unknown>
  onOpen: (id: string) => void
  now: number
}) {
  const key = `${scope}:${kind}`
  const [open, setOpen] = useState(() => readSet(SHELVES_KEY).has(key))
  const [shown, setShown] = useState(SETTLED_FIRST)
  useEffect(() => { setShown(SETTLED_FIRST) }, [scope])
  const toggle = () => {
    tap()
    const next = readSet(SHELVES_KEY)
    if (open) next.delete(key)
    else next.add(key)
    localStorage.setItem(SHELVES_KEY, JSON.stringify([...next]))
    setOpen(!open)
  }
  const label = kind === 'snoozed' ? 'Snoozed' : 'Settled'
  const tint = kind === 'snoozed' ? colors.accent : 'rgba(138, 145, 163, 0.85)'
  // Folded, the open chat still shows, so it never vanishes from under him.
  const rows = open ? (kind === 'settled' ? threads.slice(0, shown) : threads) : threads.filter((t) => t.id === activeId)
  const hidden = open && kind === 'settled' ? threads.length - rows.length : 0
  return (
    <View style={{ marginTop: 10 }}>
      <Press style={st.shelfHead} onPress={toggle} accessibilityState={{ expanded: open }}>
        <T size={12.5} weight={600} color={tint}>{open ? label : `${label} (${threads.length})`}</T>
        <View style={[st.rule, kind === 'snoozed' && { backgroundColor: 'rgba(91, 140, 255, 0.3)' }]} />
        <TI icon={open ? IconChevronUp : IconChevronDown} size={13} color={tint} />
      </Press>
      {rows.map((t) => <ThreadItem key={t.id} t={t} shelf={kind} now={now} active={t.id === activeId} live={!!runs[t.id]} onOpen={onOpen} />)}
      {hidden > 0 ? (
        <Press style={st.shelfMore} onPress={() => { tap(); setShown((n) => n + SETTLED_PAGE) }}>
          <TI icon={IconPlus} size={14} color={colors.muted} /><T size={13} color={colors.muted}>Show {Math.min(hidden, SETTLED_PAGE)} more</T>
        </Press>
      ) : null}
    </View>
  )
}

// The drawer's main list docks its Snoozed and Settled shelves at the bottom of
// the drawer, pinned above Settings, the way T3 Code's sidebar does: they stay in
// reach however long Recents gets. The list publishes them here; ChatShelfDock
// (mounted by the drawer outside its scroll) draws them.
type Dock = { scope: string; snoozed: ChatThread[]; settled: ChatThread[]; activeId: string | null; onOpen: (id: string) => void; now: number } | null
let dock: Dock = null
const dockSubs = new Set<() => void>()
function setDock(next: Dock) { dock = next; dockSubs.forEach((fn) => fn()) }
const subscribeDock = (fn: () => void) => { dockSubs.add(fn); return () => { dockSubs.delete(fn) } }

/** One list's chats on their three shelves: active (drawn by the caller), then Snoozed and Settled (inline, or docked). */
function ShelvedChats({ threads, scope, activeId, onOpen, docked = false, children }: {
  threads: ChatThread[]
  scope: string
  activeId: string | null
  onOpen: (id: string) => void
  docked?: boolean
  children: (active: ChatThread[], now: number) => React.ReactNode
}) {
  const runs = useChat((s) => s.runs)
  const autoDays = useChat((s) => s.prefs.autoSettleDays ?? 3)
  const now = useNow(threads)
  const { active, snoozed, settled } = useMemo(() => shelve(threads, now, autoDays, (id) => !!runs[id]), [threads, now, autoDays, runs])
  useEffect(() => {
    if (!docked) return
    setDock({ scope, snoozed, settled, activeId, onOpen, now })
  }, [docked, scope, snoozed, settled, activeId, onOpen, now])
  useEffect(() => (docked ? () => setDock(null) : undefined), [docked])
  return (
    <>
      {children(active, now)}
      {!docked && (snoozed.length || settled.length) ? <View style={{ height: 8 }} /> : null}
      {!docked && snoozed.length > 0 ? <ShelfSection kind="snoozed" scope={scope} threads={snoozed} activeId={activeId} runs={runs} onOpen={onOpen} now={now} /> : null}
      {!docked && settled.length > 0 ? <ShelfSection kind="settled" scope={scope} threads={settled} activeId={activeId} runs={runs} onOpen={onOpen} now={now} /> : null}
    </>
  )
}

/** The docked shelves, for the bottom of the drawer. Opened, they scroll on their own within a cap. */
export function ChatShelfDock({ maxHeight }: { maxHeight: number }) {
  const d = useSyncExternalStore(subscribeDock, () => dock, () => dock)
  const runs = useChat((s) => s.runs)
  if (!d || (!d.snoozed.length && !d.settled.length)) return null
  return (
    <ScrollView style={{ maxHeight, flexGrow: 0 }} contentContainerStyle={{ paddingBottom: 4 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      {d.snoozed.length > 0 ? <ShelfSection kind="snoozed" scope={d.scope} threads={d.snoozed} activeId={d.activeId} runs={runs} onOpen={d.onOpen} now={d.now} /> : null}
      {d.settled.length > 0 ? <ShelfSection kind="settled" scope={d.scope} threads={d.settled} activeId={d.activeId} runs={runs} onOpen={d.onOpen} now={d.now} /> : null}
    </ScrollView>
  )
}

// --- the list (Recents, or a project's Chats) -----------------------------------------------

function ThreadList({ activeId, onOpen, heading = 'Recents', searchSignal = 0, projectId = null, before }: {
  activeId: string | null
  onOpen: (id: string) => void
  heading?: string
  searchSignal?: number
  projectId?: string | null
  before?: React.ReactNode
}) {
  const allThreads = useChat((s) => s.threads) as ChatThread[]
  const projects = useChat((s) => s.projects)
  const runs = useChat((s) => s.runs)
  const loaded = useChat((s) => s.loaded)
  const autoDays = useChat((s) => s.prefs.autoSettleDays ?? 3)
  const threads = useMemo(() => {
    const known = new Set(projects.map((p) => p.id))
    // A totem's chat lives on its totem, not in Recents.
    return allThreads.filter((t) => !t.totemId && (projectId ? t.projectId === projectId : !(t.projectId && known.has(t.projectId))))
  }, [allThreads, projects, projectId])
  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)
  const searchRef = useRef<TextInput>(null)
  // The drawer's magnifier: open the search box and focus it.
  useEffect(() => {
    if (!searchSignal) return
    setSearching(true)
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [searchSignal])

  const filtered = useMemo(() => {
    // An empty chat (opened, never sent) is not history.
    const shown = threads.filter((t) => t.messages.length > 0 || t.id === activeId || runs[t.id])
    const term = q.trim().toLowerCase()
    if (!term) return shown
    return shown.filter((t) => threadTitle(t).toLowerCase().includes(term) || t.messages.some((m) => m.content.toLowerCase().includes(term)))
  }, [threads, q, activeId, runs])

  const renderGroups = (groups: { label: string; threads: ChatThread[] }[], now: number) => groups.map((g) => (
    <View key={g.label} style={{ marginTop: 8 }}>
      <T size={13} color={muted80} style={st.groupLabel}>{g.label}</T>
      {g.threads.map((t) => <ThreadItem key={t.id} t={t} now={now} shelf={q ? shelfOf(t, now, autoDays, !!runs[t.id]) : 'active'} active={t.id === activeId} live={!!runs[t.id]} onOpen={onOpen} />)}
    </View>
  ))

  return (
    <View>
      {before}
      <View style={st.head}>
        <T size={13.5} color={colors.muted}>{heading}</T>
        <Press style={st.smBtn} onPress={() => { tap(); setSearching((s) => !s); setQ('') }} accessibilityLabel="Search chats">
          <TI icon={searching ? IconX : IconSearch} size={17} color={colors.muted} />
        </Press>
      </View>
      {searching ? (
        <Animated.View entering={FadeIn.duration(120)}>
          <TextInput
            ref={searchRef}
            autoFocus
            value={q}
            onChangeText={setQ}
            placeholder="Search chats"
            placeholderTextColor={colors.muted}
            keyboardAppearance="dark"
            selectionColor={colors.accent}
            clearButtonMode="while-editing"
            returnKeyType="search"
            style={st.search}
          />
        </Animated.View>
      ) : null}
      {loaded && !threads.length ? <T size={13.5} color={colors.muted} style={st.emptyNote}>{projectId ? 'Chats in this project will show up here.' : 'Your chats will show up here.'}</T> : null}
      {q && !filtered.length ? <T size={13.5} color={colors.muted} style={st.emptyNote}>No chats match “{q}”.</T> : null}
      {q ? renderGroups(groupThreads(filtered), Date.now()) : (
        <ShelvedChats threads={filtered} scope={projectId || 'home'} activeId={activeId} onOpen={onOpen} docked>
          {(active, now) => renderGroups(groupThreads(active), now)}
        </ShelvedChats>
      )}
    </View>
  )
}

// --- projects --------------------------------------------------------------------------------

function ProjectRow({ p, onOpen }: { p: Project; onOpen: () => void }) {
  const projects = useChat((s) => s.projects)
  const waiting = useWaiting([p.id, ...foldersOf(projects, p.id).map((f) => f.id)])
  return (
    <Press style={st.thread} onPress={() => { tap(); openProject(p.id); onOpen() }} accessibilityLabel={p.name}>
      <View style={st.threadMain}>
        <ProjectIcon p={p} size={16} />
        <T size={15} numberOfLines={1} color={textAlpha(86)} style={{ flex: 1 }}>{p.name}</T>
        {waiting ? <View style={st.dot} accessibilityLabel="A chat is waiting on you" /> : null}
        {p.chatCount > 0 ? <T size={12} color={textAlpha(40)} style={{ paddingHorizontal: 6, fontVariant: ['tabular-nums'] }}>{p.chatCount}</T> : null}
      </View>
    </Press>
  )
}

/** Home's list of projects, folding, with "New project". */
function ProjectsSection({ onOpen }: { onOpen: () => void }) {
  const all = useChat((s) => s.projects)
  const projects = useMemo(() => all.filter((p) => !p.parentId), [all])
  const [folded, setFolded] = useState(() => localStorage.getItem(FOLDED_KEY) === '1')
  const fold = (v: boolean) => { tap(); setFolded(v); localStorage.setItem(FOLDED_KEY, v ? '1' : '0') }
  const create = () => nameAndCreate('New project', async (name) => { await createProject({ name }); onOpen() })
  return (
    <View style={{ paddingBottom: 4 }}>
      <View style={st.head}>
        <Press style={st.fold} onPress={() => fold(!folded)} accessibilityState={{ expanded: !folded }}>
          <T size={13.5} color={colors.muted}>Projects</T>
          <TI icon={folded ? IconChevronRight : IconChevronDown} size={13} color={colors.muted} />
        </Press>
        <Press style={st.smBtn} onPress={() => { fold(false); create() }} accessibilityLabel="New project">
          <TI icon={IconFolderPlus} size={17} color={colors.muted} />
        </Press>
      </View>
      {!folded ? (
        <>
          {projects.map((p) => <ProjectRow key={p.id} p={p} onOpen={onOpen} />)}
          {!projects.length ? (
            <Press style={st.thread} onPress={create}>
              <View style={st.threadMain}><TI icon={IconFolderPlus} size={16} color={colors.muted} /><T size={15} color={colors.muted}>New project</T></View>
            </Press>
          ) : null}
        </>
      ) : null}
    </View>
  )
}

// --- totems (web ProjectNav.tsx TotemsSection) ---------------------------------------------

/** One totem: opens its chat. On the right, what it is doing and when it last ran. */
function TotemNavItem({ row, active, onOpen, now }: { row: TotemNavRow; active: boolean; onOpen: () => void; now: number }) {
  const { job, state, lastRanAt } = row
  return (
    <Press style={[st.thread, active && st.threadOn]} onPress={() => { tap(); onOpen() }} accessibilityLabel={`${job.name}${state === 'idle' ? '' : `, ${state}`}`}>
      <View style={[st.threadMain, state === 'paused' && { opacity: 0.55 }]}>
        <TotemIcon name={job.iconName} small />
        <T size={15} numberOfLines={1} weight={state === 'unread' ? 600 : 400} color={active || state === 'unread' ? colors.text : textAlpha(86)} style={{ flex: 1 }}>{job.name}</T>
        {state === 'running' ? <Spark size={12} />
          : state === 'unread' ? <View style={st.dot} accessibilityLabel="A report is waiting" />
            : state === 'failed' ? <View style={[st.dot, { backgroundColor: '#f0879e' }]} accessibilityLabel="Last run failed" /> : null}
        <T size={12} color={textAlpha(40)} style={{ paddingHorizontal: 6, fontVariant: ['tabular-nums'] }}>{lastRanAt ? ago(lastRanAt, now) : ''}</T>
      </View>
    </Press>
  )
}

/** The drawer's other face: group chats, then every totem with the one that ran last on top. */
function TotemsPanel({ onOpenChat }: { onOpenChat: (id: string) => void }) {
  const jobs = useJobs()
  const threads = useChat((s) => s.threads)
  const runs = useChat((s) => s.runs)
  const activeId = useChat((s) => s.activeId)
  const now = useNow(threads as ChatThread[])
  // Runs happen on the bridge's clock, so keep the order and states fresh.
  useEffect(() => {
    void loadJobs()
    const t = setInterval(() => { void loadJobs() }, 30_000)
    return () => clearInterval(t)
  }, [])
  const rows = useMemo(() => totemNavRows(jobs || [], threads as ChatThread[], runs), [jobs, threads, runs])
  const groups = useMemo(() => (threads as ChatThread[]).filter((t) => t.members?.length).sort((a, b) => b.updatedAt - a.updatedAt), [threads])
  return (
    <View>
      <View style={st.head}>
        <T size={13.5} color={colors.muted}>Group chats</T>
        <Press style={st.smBtn} onPress={() => { tap(); router.push('/totem/group') }} accessibilityLabel="New group chat">
          <TI icon={IconPlus} size={17} color={colors.muted} />
        </Press>
      </View>
      {groups.map((t) => <ThreadItem key={t.id} t={t} active={t.id === activeId} live={!!runs[t.id]} onOpen={onOpenChat} now={now} />)}
      {!groups.length ? (
        <Press style={st.thread} onPress={() => { tap(); router.push('/totem/group') }}>
          <View style={st.threadMain}><TI icon={IconUsersGroup} size={16} color={colors.muted} /><T size={15} color={colors.muted}>Start a group chat</T></View>
        </Press>
      ) : null}
      <View style={st.head}>
        <T size={13.5} color={colors.muted}>Totems</T>
        <Press style={st.smBtn} onPress={() => { tap(); navigateTo('totems') }} accessibilityLabel="The Totems page">
          <TI icon={IconLayoutList} size={17} color={colors.muted} />
        </Press>
      </View>
      {rows.map((r) => (
        <TotemNavItem
          key={r.job.id}
          row={r}
          now={now}
          active={!!r.thread && r.thread.id === activeId}
          onOpen={async () => { const id = r.thread?.id || await ensureTotemChat(r.job); if (id) onOpenChat(id) }}
        />
      ))}
      {jobs && !rows.length ? <T size={13} color={colors.muted} style={st.emptyNote}>No totems yet. Make one on the Totems page.</T> : null}
    </View>
  )
}

/** Which face the drawer shows: your chats, or your totems (web ProjectNav.tsx usePanelMode). */
const PANEL_MODE_KEY = 'totem.panel.mode'
function usePanelMode(): ['chats' | 'totems', (m: 'chats' | 'totems') => void] {
  const [mode, setMode] = useState<'chats' | 'totems'>(() => (localStorage.getItem(PANEL_MODE_KEY) === 'totems' ? 'totems' : 'chats'))
  return [mode, (m) => { tap(); setMode(m); localStorage.setItem(PANEL_MODE_KEY, m) }]
}

function PanelTabs({ mode, onMode }: { mode: 'chats' | 'totems'; onMode: (m: 'chats' | 'totems') => void }) {
  // A report waiting in a totem's chat shows on the Totems tab from the Chats side.
  const waiting = useChat((s) => s.threads.some((t) => t.totemId && t.needsReply))
  return (
    <View style={st.tabs} accessibilityRole="tablist">
      {(['chats', 'totems'] as const).map((m) => (
        <Press key={m} style={[st.tab, mode === m && st.tabOn]} onPress={() => onMode(m)} accessibilityRole="tab" accessibilityState={{ selected: mode === m }}>
          <T size={13.5} weight={mode === m ? 600 : 400} color={mode === m ? colors.text : colors.muted}>{m === 'chats' ? 'Chats' : 'Totems'}</T>
          {m === 'totems' && waiting && mode !== 'totems' ? <View style={st.dot} accessibilityLabel="A totem has a report waiting" /> : null}
        </Press>
      ))}
    </View>
  )
}

/** A folder in a project: opens its page, unfolds its chats (each list keeps its own shelves). */
function FolderRow({ f, open, onToggle, onOpenChat }: { f: Project; open: boolean; onToggle: () => void; onOpenChat: (id: string) => void }) {
  const activeId = useChat((s) => s.activeId)
  const scoped = useChat((s) => s.projectId === f.id && !s.activeId)
  const allThreads = useChat((s) => s.threads) as ChatThread[]
  const runs = useChat((s) => s.runs)
  const autoDays = useChat((s) => s.prefs.autoSettleDays ?? 3)
  const chats = useMemo(() => allThreads.filter((t) => t.projectId === f.id && (t.messages.length > 0 || t.id === activeId || runs[t.id])), [allThreads, f.id, activeId, runs])
  const waiting = useWaiting([f.id])
  // The count is what's still in play, not what's parked on the folder's shelves.
  const inPlay = chats.filter((t) => !isSnoozed(t, Date.now()) && !settledAt(t, Date.now(), autoDays, !!runs[t.id])).length
  return (
    <View>
      <View style={[st.thread, scoped && st.threadOn]}>
        <Press style={st.foldBtn} onPress={() => { tap(); onToggle() }} accessibilityLabel={open ? `Fold ${f.name}` : `Unfold ${f.name}`}>
          <TI icon={open ? IconChevronDown : IconChevronRight} size={13} color={colors.muted} />
        </Press>
        <Press style={[st.threadMain, { paddingLeft: 2 }]} onPress={() => { tap(); openProject(f.id) }} accessibilityLabel={`${f.name}: files, instructions and memory`}>
          <ProjectIcon p={f} size={16} />
          <T size={15} numberOfLines={1} color={textAlpha(86)} style={{ flex: 1 }}>{f.name}</T>
          {waiting && !open ? <View style={st.dot} /> : null}
          {inPlay > 0 ? <T size={12} color={textAlpha(40)} style={{ paddingHorizontal: 6 }}>{inPlay}</T> : null}
        </Press>
      </View>
      {open ? (
        <View style={{ paddingLeft: 14 }}>
          <ShelvedChats threads={chats} scope={f.id} activeId={activeId} onOpen={onOpenChat}>
            {(active, now) => active.map((t) => <ThreadItem key={t.id} t={t} now={now} active={t.id === activeId} live={!!runs[t.id]} onOpen={onOpenChat} />)}
          </ShelvedChats>
          {!chats.length ? <T size={13} color={colors.muted} style={st.emptyNote}>Move a chat here from its menu, or open the folder to start one.</T> : null}
        </View>
      ) : null}
    </View>
  )
}

function FoldersSection({ root, onOpenChat }: { root: Project; onOpenChat: (id: string) => void }) {
  const all = useChat((s) => s.projects)
  const folders = useMemo(() => foldersOf(all, root.id), [all, root.id])
  const activeFolder = useChat((s) => {
    const t = s.activeId ? s.threads.find((x) => x.id === s.activeId) : null
    return t?.projectId && t.projectId !== root.id ? t.projectId : s.projectId !== root.id ? s.projectId : null
  })
  const [openSet, setOpenSet] = useState(() => readSet(OPEN_FOLDERS_KEY))
  const toggle = (id: string) => setOpenSet((cur) => {
    const next = new Set(cur)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...next]))
    return next
  })
  if (!folders.length) return null
  return (
    <View style={{ paddingBottom: 4 }}>
      <View style={st.head}><T size={13.5} color={colors.muted}>Folders</T></View>
      {folders.map((f) => <FolderRow key={f.id} f={f} open={openSet.has(f.id) || activeFolder === f.id} onToggle={() => toggle(f.id)} onOpenChat={onOpenChat} />)}
    </View>
  )
}

/**
 * The drawer's chats. `onOpenChat(id)` opens a chat (and closes the drawer);
 * bumping `searchSignal` opens the search box.
 */
export default function ChatsNav({ onOpenChat, searchSignal = 0 }: { onOpenChat: (id: string) => void; searchSignal?: number }) {
  const activeId = useChat((s) => s.activeId)
  const scoped = useChat((s) => s.projects.find((p) => p.id === s.projectId))
  // A folder shows inside its project's panel.
  const project = useChat((s) => (scoped?.parentId ? s.projects.find((p) => p.id === scoped.parentId) : undefined)) || scoped
  // A project's page shows in the chat screen with no chat open: the drawer's
  // openChat(null) navigates there and keeps the project the store is scoped to.
  const openPage = () => onOpenChat(null as unknown as string)
  const [mode, setMode] = usePanelMode()
  const tabs = <PanelTabs mode={mode} onMode={setMode} />

  if (mode === 'totems') return <View style={{ paddingTop: 6 }}>{tabs}<TotemsPanel onOpenChat={onOpenChat} /></View>
  if (project) {
    return (
      <View style={{ paddingTop: 6 }}>
        {tabs}
        <View style={st.projHead}>
          <Press style={st.smBtn} onPress={() => { tap(); openProject(null) }} accessibilityLabel="Back to all chats">
            <TI icon={IconArrowLeft} size={18} color={colors.muted} />
          </Press>
          <Press
            style={[st.projTitle, !activeId && scoped?.id === project.id && st.threadOn]}
            onPress={() => { tap(); openProject(project.id); openPage() }}
            accessibilityLabel={`${project.name}: files, instructions and memory`}
          >
            <ProjectIcon p={project} size={17} />
            <T size={15} weight={600} numberOfLines={1} style={{ flexShrink: 1 }}>{project.name}</T>
          </Press>
          <Press
            style={st.smBtn}
            onPress={() => { tap(); nameAndCreate('New folder', (name) => createProject({ name, parentId: project.id })) }}
            accessibilityLabel="New folder: a side topic with its own memory and files"
          >
            <TI icon={IconFolderPlus} size={17} color={colors.muted} />
          </Press>
        </View>
        <ThreadList
          activeId={activeId}
          onOpen={onOpenChat}
          searchSignal={searchSignal}
          projectId={project.id}
          heading="Chats"
          before={<FoldersSection root={project} onOpenChat={onOpenChat} />}
        />
      </View>
    )
  }
  return (
    <View style={{ paddingTop: 6 }}>
      {tabs}
      <ThreadList
        activeId={activeId}
        onOpen={onOpenChat}
        searchSignal={searchSignal}
        projectId={null}
        before={<ProjectsSection onOpen={openPage} />}
      />
    </View>
  )
}

const st = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 12, paddingBottom: 2, paddingLeft: 12, paddingRight: 4 },
  fold: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 32 },
  smBtn: { width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  search: {
    marginHorizontal: 6, marginTop: 6, marginBottom: 4, height: 40, paddingHorizontal: 12, borderRadius: 10,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line, color: colors.text, fontSize: 16, fontFamily: fonts[400],
  },
  emptyNote: { paddingVertical: 10, paddingHorizontal: 12 },
  groupLabel: { paddingTop: 6, paddingBottom: 4, paddingHorizontal: 12 },
  thread: { flexDirection: 'row', alignItems: 'center', borderRadius: 10 },
  threadOn: { backgroundColor: colors.drawerOn },
  // Opaque, so the actions stay hidden until the row slides off them.
  threadOff: { backgroundColor: colors.bg2 },
  threadMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 9, height: 44, paddingLeft: 12, paddingRight: 4 },
  swipe: { flexDirection: 'row', gap: 4, paddingLeft: 6 },
  swipeBtn: { width: 62, height: 44, alignItems: 'center', justifyContent: 'center', gap: 2, borderRadius: 10 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  woke: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, backgroundColor: 'rgba(91, 140, 255, 0.15)' },
  meta: { paddingLeft: 4, fontVariant: ['tabular-nums'] },
  shelfHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 6, paddingBottom: 6, paddingLeft: 12, paddingRight: 12 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  shelfMore: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 38, paddingHorizontal: 12 },
  projHead: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingTop: 8, paddingBottom: 2, paddingHorizontal: 4 },
  projTitle: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8, height: 38, paddingHorizontal: 8, borderRadius: 9 },
  foldBtn: { width: 28, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: 2 },
  tabs: { flexDirection: 'row', gap: 2, marginHorizontal: 8, marginTop: 2, marginBottom: 2, padding: 3, borderRadius: 10, backgroundColor: colors.bg3 },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 32, borderRadius: 8 },
  tabOn: { backgroundColor: colors.bg },
})
