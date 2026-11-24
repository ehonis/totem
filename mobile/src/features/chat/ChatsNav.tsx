// The chats in the phone drawer (web chat/ChatsNav.tsx, T3 Code's sidebar): one list
// of every chat in every project and folder, nothing filed away out of sight. Unsent
// new-chat drafts first (ChatsNavDrafts.tsx, handed in), then Pinned, then everything
// still in play (latest first), then Working, the chats answering right now. Each is
// a card naming where it lives and what it is doing, with its linked task under the
// title (features/work/TaskBadge.tsx) as T3 shows a thread's pull request. The rules
// are lib/chat/sidebar.ts, the web's file byte for byte.
//
// Snoozed and Settled are not drawn in the drawer, except the open chat, under its
// shelf's name at the end: each shelf is a button with a count in the drawer's foot
// that opens ShelfSheet, so the drawer has one scroll. A row opens its chat on tap;
// swiped left it shows Snooze, Settle and "…" (the full menu), and long-press opens
// that menu too. A chat with unsent words wears an amber pencil.
//
// The scope button at the top narrows the list to Home or one project and its folders,
// the way T3's project filter does (chatsScope.ts); ↗ opens that project's page, and a
// dot says when a chat the scope hides is waiting on him. Totems' own chats are not
// here: Totems is a page of its own in the drawer's nav. Finding an older chat is the
// Search page's job; the list has no search box.
import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { StyleSheet, View } from 'react-native'
import { MenuView } from '@react-native-menu/menu'
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import { useDrawerStatus } from 'expo-router/drawer'
import { useChat, openProject, createProject, threadTitle } from '../../lib/chat/store'
import { attentionOf, attentionBadge, attentionTitle, type Attention } from '../../lib/chat/attention'
import {
  wokeAt, countdown, ago, activeAt, settledAt, snoozePresets, offersSettle, keptOpenId, type Shelf,
} from '../../lib/chat/settle'
import { sidebarLists, placeLabel, scopeLabel, inScope, type SidebarScope } from '../../lib/chat/sidebar'
import { folderOrder } from '../../lib/work/groups'
import type { ChatThread, Project } from '../../lib/chat/types'
import { pushError } from '../../lib/toast'
import { colors, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { impact, tap } from '../../ui/haptics'
import { prompt, showActionTree } from '../../ui/menu'
import { useNow } from './threadOps'
import { threadMenu } from './threadMenu'
import { ThreadIcon, ProjectIcon } from './ThreadIcon'
import { TI } from './ui'
import Spark from './Spark'
import {
  IconDots, IconChevronDown, IconLayoutList, IconClock, IconCheck, IconArrowBackUp, IconAlarm, IconAlarmOff,
  IconPencil, IconHome, IconPinned, IconCircleCheck, IconX, IconArrowUpRight,
} from './icons'
import { useHasDraft } from './appDrafts'
import { router } from 'expo-router'
import { drawerPan } from '../../shell/drawerGesture'
import TaskBadge from '../work/TaskBadge'
import { loadBoard, loadSheet } from '../todos/store'
import { setSidebarScope, useSidebarScope } from './chatsScope'

const muted80 = 'rgba(138, 145, 163, 0.8)'
// The web card's status colours (chat.css .sb-working, .sb-done, .sb-needs).
const WORKING = '#8ec5ff'
const DONE = '#6fdd8b'
const ASKING = '#a5b4fc'

export function LiveDot() {
  const v = useSharedValue(1)
  useEffect(() => { v.value = withRepeat(withTiming(0.5, { duration: 700 }), -1, true) }, [v])
  const style = useAnimatedStyle(() => ({ opacity: v.value, transform: [{ scale: 0.7 + 0.3 * v.value }] }))
  return <Animated.View style={[st.dot, style]} accessibilityLabel="Answering" />
}

// --- one chat --------------------------------------------------------------------------

/** A card's status, in words, T3's way: what it waits on him for, Working, Woke, Done (finished, unread), else how long since it moved. */
function CardStatus({ t, needs, live, woke, unread, settle, now }: { t: ChatThread; needs: Attention | null; live: boolean; woke: boolean; unread: boolean; settle: boolean; now: number }) {
  if (needs) {
    const color = needs.kind === 'questions' || needs.kind === 'browser' ? ASKING : colors.amber
    return <T size={11.5} weight={600} color={color} numberOfLines={1} style={st.status} accessibilityLabel={attentionTitle(needs)}>{attentionBadge(needs)}</T>
  }
  if (live) return <View style={st.statusRow} accessibilityLabel="Working"><Spark size={11} /><T size={11.5} weight={500} color={WORKING}>Working</T></View>
  if (woke) return <View style={st.statusRow}><TI icon={IconAlarmOff} size={12} color={colors.accent} /><T size={11.5} weight={500} color={colors.accent}>Woke</T></View>
  if (unread && !settle) return <View style={st.statusRow} accessibilityLabel="Done, waiting for you to read it"><TI icon={IconCircleCheck} size={12} color={DONE} /><T size={11.5} weight={500} color={DONE}>Done</T></View>
  return <T size={11.5} color={muted80} style={st.status}>{ago(activeAt(t, now), now)}</T>
}

export function ThreadItem({ t, active, live, onOpen, shelf = 'active', now, beforeDiscard, card = false, place }: {
  t: ChatThread
  active: boolean
  live: boolean
  onOpen: (id: string) => void
  shelf?: Shelf
  now: number
  /** A sheet over the drawer closes first, so the discard's Undo line in the drawer's foot is in sight. */
  beforeDiscard?: () => void
  /** T3 Code's card (the drawer's live list): where the chat lives and what it is doing over the title, its task under it. */
  card?: boolean
  /** The chat's project or folder for a card's first line; a null project is Home. */
  place?: { project: Project | null; label: string }
}) {
  const retitling = useChat((s) => !!s.retitling[t.id])
  const autoDays = useChat((s) => s.prefs.autoSettleDays ?? 3)
  const title = threadTitle(t)
  const woke = shelf === 'active' && !!wokeAt(t, now) && !active
  const unread = !!t.needsReply && !live
  const waiting = unread || woke
  // What the chat waits on him for outranks everything else on the row, as in T3 (attention.ts).
  const handoff = useChat((s) => s.handoffs[t.id])
  const needs = attentionOf(t, handoff)
  // Words or files left unsent in it; the chat on screen shows its own in the composer.
  const unsent = useHasDraft(t.id) && !active
  const menu = threadMenu(t, shelf, live, unsent)
  const run = (id: string) => { if (id === 'discard-draft') beforeDiscard?.(); menu.run(id) }
  const swipe = useRef<SwipeableMethods>(null)
  // Every swipe action is one of the menu's own ids, so both run the same code.
  const act = (id: string) => { swipe.current?.close(); tap(); run(id) }
  const settle = offersSettle(t, shelf, live)
  // A card already read, and asking nothing, steps back so the ones that want him stand out.
  const receded = card && !active && !waiting && !needs
  const pen = unsent ? <View accessible accessibilityLabel="Unsent draft"><TI icon={IconPencil} size={13} color={colors.amber} /></View> : null
  const titleText = (
    <T
      size={15}
      weight={receded ? 400 : waiting || active || needs ? 600 : 400}
      numberOfLines={1}
      color={receded ? textAlpha(74) : active || waiting || needs ? colors.text : textAlpha(86)}
      style={{ flex: 1, opacity: retitling ? 0.55 : 1 }}
    >
      {title}
    </T>
  )
  const settleChip = settle ? (
    <Press
      style={st.doneBtn}
      hitSlop={8}
      onPress={() => act('settle')}
      accessibilityRole="button"
      accessibilityLabel={`Settle ${title}`}
      accessibilityHint="Done; it also settles by itself once you've read it"
    >
      <TI icon={IconCheck} size={13} color={colors.green} stroke={2.2} />
      <T size={11.5} weight={600} color={colors.green}>Settle</T>
    </Press>
  ) : null
  const press = {
    onPress: () => { tap(); onOpen(t.id) },
    onLongPress: () => { impact(); showActionTree(menu.actions, (id) => { tap(); run(id) }, title) },
    accessibilityRole: 'button' as const,
    accessibilityLabel: `${title}${card || place?.label ? `, ${place?.label || 'Home'}` : ''}${unsent ? ', unsent draft' : ''}`,
    // VoiceOver cannot swipe: the draft's discard is an action on the row.
    accessibilityActions: unsent ? [{ name: 'discard-draft', label: 'Discard draft' }] : undefined,
    onAccessibilityAction: unsent ? (e: { nativeEvent: { actionName: string } }) => { if (e.nativeEvent.actionName === 'discard-draft') act('discard-draft') } : undefined,
    accessibilityState: { selected: active },
    accessibilityHint: 'Swipe left or long-press for options',
  }
  const row = card ? (
    <View style={[st.card, active ? st.threadOn : st.threadOff]}>
      {active ? <View style={st.activeBar} /> : null}
      <Press style={st.cardMain} {...press}>
        <View style={st.line}>
          {place?.project ? <ProjectIcon p={place.project} size={12} color={muted80} /> : <TI icon={IconHome} size={12} color={muted80} />}
          <T size={11.5} color={muted80} numberOfLines={1} style={{ flex: 1 }}>{place?.label || 'Home'}</T>
          {t.pinned ? <TI icon={IconPinned} size={11} color={muted80} /> : null}
          <CardStatus t={t} needs={needs} live={live} woke={woke} unread={unread} settle={settle} now={now} />
        </View>
        <View style={st.line}>
          <ThreadIcon t={t} size={15} busy={retitling} />
          {titleText}
          {pen}
        </View>
      </Press>
      {/* The chat's task, as T3 Code shows a thread's pull request: under the title, a tap to its page. */}
      {t.taskId || settleChip ? (
        // Only its badge and chip take touches; the rest of the strip it overlaps belongs to the chat.
        <View style={st.meta} pointerEvents="box-none">
          {t.taskId ? <TaskBadge taskRef={t.taskId} /> : <View style={{ flex: 1 }} />}
          {settleChip}
        </View>
      ) : null}
    </View>
  ) : (
    <View style={[st.thread, active ? st.threadOn : st.threadOff]}>
      {/* The open chat: a fill and an accent bar, so it is the first row the eye finds. */}
      {active ? <View style={st.activeBar} /> : null}
      <Press style={st.threadMain} {...press}>
        <ThreadIcon t={t} size={16} busy={retitling} />
        {place?.label ? (
          // On a shelf every project's chats are mixed: where this one lives, dim, under its title.
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={15} numberOfLines={1} color={active || waiting || needs ? colors.text : textAlpha(86)} weight={waiting || active || needs ? 600 : 400} style={{ opacity: retitling ? 0.55 : 1 }}>{title}</T>
            <T size={12} numberOfLines={1} color={textAlpha(45)}>{place.label}</T>
          </View>
        ) : titleText}
        {pen}
        {needs ? <View style={st.woke} accessibilityLabel={attentionTitle(needs)}><T size={11} weight={600} color={colors.accent}>{attentionBadge(needs)}</T></View>
          : live ? <LiveDot />
          : woke ? <View style={st.woke}><T size={11} weight={600} color={colors.accent}>Woke</T></View>
            : t.needsReply && !settle ? <View style={st.dot} accessibilityLabel="Waiting on you" /> : null}
        {shelf === 'snoozed' ? <T size={11.5} color={colors.accent} style={st.metaTime}>{countdown(t.snoozedUntil!, now)}</T> : null}
        {shelf === 'settled' ? <T size={11.5} color={muted80} style={st.metaTime}>{ago(settledAt(t, now, autoDays), now)}</T> : null}
      </Press>
      {/* Marked done, or its task finished: Settle without a swipe. */}
      {settleChip}
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
            <SwipeBtn label="Wake" icon={IconAlarm} fill={colors.accent} ink={colors.white} onPress={() => act('wake')} style={card && st.swipeTall} />
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
              style={card ? st.menuTall : undefined}
            >
              <SwipeBtn label="Snooze" icon={IconClock} fill={colors.amber} ink="#1d1606" style={card && st.swipeFill} />
            </MenuView>
          )}
          {shelf === 'settled' ? (
            <SwipeBtn label="Un-settle" icon={IconArrowBackUp} fill={colors.bg3} ink={colors.text} onPress={() => act('unsettle')} style={card && st.swipeTall} />
          ) : (
            <SwipeBtn label="Settle" icon={IconCheck} fill={colors.toastSuccess} ink={colors.white} disabled={live} onPress={() => act('settle')} style={card && st.swipeTall} />
          )}
          <MenuView actions={menu.actions} themeVariant="dark" onOpenMenu={tap} onPressAction={({ nativeEvent }) => act(nativeEvent.event)} style={card ? st.menuTall : undefined}>
            <SwipeBtn label="More" icon={IconDots} fill={colors.drawerOn} ink={colors.text} style={card && st.swipeFill} />
          </MenuView>
        </View>
      )}
    >
      {row}
    </ReanimatedSwipeable>
  )
}

/** One action behind a swiped row (a chat's, a draft's). Without onPress it is the face of a MenuView. */
export function SwipeBtn({ label, icon, fill, ink, disabled, onPress, style }: {
  label: string; icon: typeof IconDots; fill: string; ink: string; disabled?: boolean; onPress?: () => void; style?: object | false
}) {
  const face = (
    <>
      <TI icon={icon} size={18} color={ink} />
      <T size={11} weight={600} color={ink}>{label}</T>
    </>
  )
  if (!onPress) return <View style={[st.swipeBtn, { backgroundColor: fill }, style]} accessible accessibilityRole="button" accessibilityLabel={label}>{face}</View>
  return (
    <Press style={[st.swipeBtn, { backgroundColor: fill }, disabled && { opacity: 0.4 }, style]} disabled={disabled} onPress={onPress} accessibilityLabel={disabled ? `${label} once the reply finishes` : label}>
      {face}
    </Press>
  )
}

// --- Snoozed and Settled ------------------------------------------------------------------

type ShelfKind = 'snoozed' | 'settled'

/**
 * Open the list's parked chats in the shelf sheet (ShelfSheet.tsx), for the scope the list shows.
 * `showing`: the chat screen was on screen under the drawer, so the open chat keeps its place
 * there too (the sheet's own route can't tell).
 */
export function openShelf(kind: ShelfKind, scope: string, showing = true) {
  tap()
  router.push({ pathname: '/chat/shelf', params: { kind, scope, showing: showing ? '1' : '0' } })
}

/** One shelf as a button: what it holds and how many. */
function ShelfBtn({ kind, count, scope, showing }: { kind: ShelfKind; count: number; scope: string; showing: boolean }) {
  const label = kind === 'snoozed' ? 'Snoozed' : 'Settled'
  return (
    <Press
      style={st.shelfBtn}
      hitSlop={4}
      onPress={() => openShelf(kind, scope, showing)}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${count} ${count === 1 ? 'chat' : 'chats'}`}
      accessibilityHint="Opens the list"
    >
      <T size={13} weight={500} color={kind === 'snoozed' ? colors.accent : textAlpha(86)}>{label}</T>
      <T size={12.5} color={colors.muted} style={{ fontVariant: ['tabular-nums'] }}>{count}</T>
    </Press>
  )
}

type ShelfCounts = { scope: string; snoozed: number; settled: number; showing: boolean }

export function ShelfButtons({ scope, snoozed, settled, showing, style }: ShelfCounts & { style?: object }) {
  if (!snoozed && !settled) return null
  return (
    <View style={[st.shelfBtns, style]}>
      {snoozed ? <ShelfBtn kind="snoozed" count={snoozed} scope={scope} showing={showing} /> : null}
      {settled ? <ShelfBtn kind="settled" count={settled} scope={scope} showing={showing} /> : null}
    </View>
  )
}

// The drawer's list publishes its shelf counts here; DockedShelfButtons, mounted
// in the drawer's foot outside the scroll, draws them beside Settings.
let dock: ShelfCounts | null = null
const dockSubs = new Set<() => void>()
function setDock(next: ShelfCounts | null) {
  dock = next
  dockSubs.forEach((fn) => fn())
}
const subscribeDock = (fn: () => void) => { dockSubs.add(fn); return () => { dockSubs.delete(fn) } }

/** The list's Snoozed and Settled buttons, for the drawer's foot. */
export function DockedShelfButtons() {
  const d = useSyncExternalStore(subscribeDock, () => dock, () => dock)
  return d ? <ShelfButtons {...d} /> : null
}

// --- the scope ----------------------------------------------------------------------------

const ALL = 'scope:all'
const HOME = 'scope:home'

/** The scope button: All chats, Home, or one project or folder from a native menu, with "New project…". */
function ScopeBar({ value, projects, outside, onOpenPage }: { value: SidebarScope; projects: Project[]; outside: boolean; onOpenPage: () => void }) {
  const project = value !== 'all' && value !== 'home' ? projects.find((p) => p.id === value) : undefined
  const on = (key: string) => ((key === ALL && value === 'all') || (key === HOME && value === 'home') || key === `scope:${value}` ? 'on' as const : 'off' as const)
  const actions = useMemo(() => [
    { id: ALL, title: 'All chats', image: 'list.bullet', state: on(ALL) },
    { id: HOME, title: 'Home', image: 'house', state: on(HOME) },
    ...folderOrder(projects).map((p) => {
      const parent = p.parentId ? projects.find((x) => x.id === p.parentId) : undefined
      // One level only: a native menu drops anything nested deeper, so folders are indented rows.
      return { id: `scope:${p.id}`, title: parent ? `   ${p.name}` : p.name, image: parent ? 'folder' : undefined, state: on(`scope:${p.id}`) }
    }),
    { id: 'new-project', title: 'New project…', image: 'folder.badge.plus' },
  ], [projects, value]) // eslint-disable-line react-hooks/exhaustive-deps
  const pick = async (id: string) => {
    tap()
    if (id === 'new-project') {
      const name = await prompt('New project', { placeholder: 'Name' })
      if (!name) return
      try { const p = await createProject({ name }); setSidebarScope(p.id) } catch (e: any) { pushError(`Couldn't create it: ${e.message}`) }
      return
    }
    setSidebarScope(id === ALL ? 'all' : id === HOME ? 'home' : id.slice('scope:'.length))
  }
  const name = scopeLabel(value, projects)
  return (
    <View style={st.scope}>
      <MenuView title="Show chats in" actions={actions} themeVariant="dark" onOpenMenu={tap} onPressAction={({ nativeEvent }) => { void pick(nativeEvent.event) }} style={{ flexShrink: 1 }}>
        <View
          style={[st.scopeBtn, value !== 'all' && st.scopeOn]}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`Showing ${name}${outside ? '. A chat outside this view is waiting on you' : ''}`}
          accessibilityHint="Shows every chat, Home's, or one project's"
        >
          {project ? <ProjectIcon p={project} size={15} /> : <TI icon={value === 'home' ? IconHome : IconLayoutList} size={15} color={value === 'all' ? colors.muted : colors.text} />}
          <T size={14} weight={500} numberOfLines={1} color={value === 'all' ? textAlpha(72) : colors.text} style={{ flexShrink: 1 }}>{name}</T>
          {/* Something the scope hides is waiting on him: say so, so nothing hides behind the filter. */}
          {outside ? <View style={st.dot} /> : null}
          <TI icon={IconChevronDown} size={13} color={colors.muted} />
        </View>
      </MenuView>
      <View style={{ flex: 1 }} />
      {project ? (
        <Press style={st.smBtn} onPress={() => { tap(); openProject(project.id); onOpenPage() }} accessibilityRole="button" accessibilityLabel={`Open ${project.name}: files, instructions and memory`}>
          <TI icon={IconArrowUpRight} size={17} color={colors.muted} />
        </Press>
      ) : null}
      {value !== 'all' ? (
        <Press style={st.smBtn} onPress={() => { tap(); setSidebarScope('all') }} accessibilityRole="button" accessibilityLabel="Show all chats">
          <TI icon={IconX} size={16} color={colors.muted} />
        </Press>
      ) : null}
    </View>
  )
}

// --- the list ----------------------------------------------------------------------------------

/**
 * The drawer's chats. `onOpenChat(id)` opens a chat (and closes the drawer);
 * `drafts` draws the unsent drafts for Home's list (null) or a project's.
 */
export default function ChatsNav({ onOpenChat, drafts, chatShowing = true }: {
  /** Open a chat, or with null the page of the project the store is scoped to; closes the drawer. */
  onOpenChat: (id: string | null) => void
  /** `homeOnly`: the list is scoped to Home, so drafts headed for a project are left out. */
  drafts?: (projectId: string | null, homeOnly: boolean) => React.ReactNode
  /** The chat screen is showing, so the open chat is in sight and keeps its place (settle.ts keptOpenId). */
  chatShowing?: boolean
}) {
  const threads = useChat((s) => s.threads) as ChatThread[]
  const projects = useChat((s) => s.projects)
  const runs = useChat((s) => s.runs)
  const handoffs = useChat((s) => s.handoffs)
  const activeId = useChat((s) => s.activeId)
  const openedSettled = useChat((s) => s.openedSettled)
  const autoDays = useChat((s) => s.prefs.autoSettleDays ?? 3)
  const loaded = useChat((s) => s.loaded)
  const scope = useSidebarScope(projects)
  const now = useNow(threads)
  const lists = useMemo(() => sidebarLists(threads, {
    now, autoDays, live: (id) => !!runs[id], needsYou: (t) => !!attentionOf(t, handoffs[t.id]),
    openId: chatShowing ? keptOpenId(activeId, openedSettled) : null, activeId, scope, projects,
  }), [threads, now, autoDays, runs, handoffs, activeId, openedSettled, chatShowing, scope, projects])
  const { pinned, inbox, working, snoozed, settled } = lists
  // Waiting on him somewhere the scope hides (finished and unread, or asking).
  const outside = useMemo(() => scope !== 'all' && threads.some((t) => !t.totemId && !inScope(t, scope, projects) && ((t.needsReply && !runs[t.id]) || !!attentionOf(t, handoffs[t.id]))), [threads, scope, projects, runs, handoffs])

  // The foot's shelf buttons follow this list.
  useEffect(() => { setDock({ scope, snoozed: snoozed.length, settled: settled.length, showing: chatShowing }) }, [scope, snoozed.length, settled.length, chatShowing])
  useEffect(() => () => setDock(null), [])

  // The cards' tasks are read each time the drawer opens: it stays mounted, so a timer here would poll while it is closed.
  const status = useDrawerStatus()
  const namesTask = useMemo(() => [...pinned, ...inbox, ...working].some((t) => !!t.taskId), [pinned, inbox, working])
  useEffect(() => {
    if (status !== 'open' || !namesTask) return
    void loadBoard()
    void loadSheet()
  }, [status, namesTask])

  const card = (t: ChatThread) => {
    const project = t.projectId ? projects.find((p) => p.id === t.projectId) || null : null
    return <ThreadItem key={t.id} t={t} card now={now} active={t.id === activeId} live={!!runs[t.id]} onOpen={onOpenChat} place={{ project, label: placeLabel(t, projects) }} />
  }
  // The open chat on a shelf, under the shelf's name, so the drawer always shows where he is.
  const openSnoozed = snoozed.find((t) => t.id === activeId)
  const openParked = openSnoozed || settled.find((t) => t.id === activeId)
  const nothing = !pinned.length && !inbox.length && !working.length
  const draftsProject = scope !== 'all' && scope !== 'home' ? scope : null
  return (
    <View style={{ paddingTop: 6 }}>
      <ScopeBar value={scope} projects={projects} outside={outside} onOpenPage={() => onOpenChat(null)} />
      {drafts?.(draftsProject, scope === 'home')}
      {pinned.length ? <View accessibilityLabel="Pinned">{pinned.map(card)}</View> : null}
      {pinned.length && inbox.length ? <View style={st.divider} /> : null}
      {inbox.map(card)}
      {loaded && nothing ? (
        <T size={13.5} color={colors.muted} style={st.emptyNote}>
          {snoozed.length || settled.length ? 'All settled. Nothing is waiting on you.' : scope === 'all' ? 'Your chats will show up here.' : 'Chats here will show up in this list.'}
        </T>
      ) : null}
      {working.length ? (
        <View style={{ marginTop: 10 }}>
          <View style={st.shelfHead}>
            <Spark size={11} />
            <T size={13} weight={500} color={WORKING}>Working</T>
            <T size={12.5} color={colors.muted} style={{ fontVariant: ['tabular-nums'] }}>{working.length}</T>
          </View>
          {working.map(card)}
        </View>
      ) : null}
      {openParked ? (
        <View style={{ marginTop: 10 }}>
          <T size={13} color={muted80} style={st.groupLabel}>{openSnoozed ? 'Snoozed' : 'Settled'}</T>
          <ThreadItem t={openParked} shelf={openSnoozed ? 'snoozed' : 'settled'} now={now} active live={!!runs[openParked.id]} onOpen={onOpenChat} />
        </View>
      ) : null}
    </View>
  )
}

const st = StyleSheet.create({
  smBtn: { width: 40, height: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  emptyNote: { paddingVertical: 10, paddingHorizontal: 12 },
  groupLabel: { paddingTop: 6, paddingBottom: 4, paddingHorizontal: 12 },
  shelfHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 6, paddingBottom: 4, paddingHorizontal: 12 },
  thread: { flexDirection: 'row', alignItems: 'center', borderRadius: 10 },
  card: { borderRadius: 10, marginBottom: 2 },
  cardMain: { gap: 3, paddingTop: 8, paddingBottom: 7, paddingLeft: 12, paddingRight: 10 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 7, minWidth: 0 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, marginTop: -9, paddingTop: 6, paddingBottom: 6, paddingLeft: 12, paddingRight: 4 },
  status: { flexShrink: 0, fontVariant: ['tabular-nums'] },
  statusRow: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 4 },
  threadOn: { backgroundColor: colors.drawerOn },
  // Opaque, so the actions stay hidden until the row slides off them.
  threadOff: { backgroundColor: colors.bg2 },
  threadMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 44, paddingVertical: 6, paddingLeft: 12, paddingRight: 4 },
  activeBar: { position: 'absolute', left: 0, top: 11, bottom: 11, width: 3, borderRadius: 2, backgroundColor: colors.accent },
  swipe: { flexDirection: 'row', gap: 4, paddingLeft: 6, paddingBottom: 2 },
  swipeBtn: { width: 62, height: 44, alignItems: 'center', justifyContent: 'center', gap: 2, borderRadius: 10 },
  // A card is taller than a row: its actions fill its height (alignSelf, since flex would leave them no width).
  swipeTall: { height: undefined, alignSelf: 'stretch' },
  menuTall: { alignSelf: 'stretch' },
  swipeFill: { height: undefined, flex: 1 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  woke: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, backgroundColor: 'rgba(91, 140, 255, 0.15)' },
  metaTime: { paddingLeft: 4, fontVariant: ['tabular-nums'] },
  doneBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 26, marginLeft: 'auto', marginRight: 8, paddingLeft: 6, paddingRight: 8, borderRadius: 7, backgroundColor: 'rgba(63, 185, 80, 0.15)' },
  shelfBtns: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  shelfBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 36, paddingVertical: 6, paddingHorizontal: 11, borderRadius: 18, backgroundColor: colors.bg3 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: 6, marginHorizontal: 12 },
  scope: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingTop: 4, paddingBottom: 6, paddingHorizontal: 2 },
  scopeBtn: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 40, paddingHorizontal: 10, borderRadius: 10 },
  scopeOn: { backgroundColor: colors.bg3 },
})
