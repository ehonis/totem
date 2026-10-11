// The running-chats pill (web chat/RunningChats.tsx). It counts the chats that
// are answering and the finished ones he hasn't read yet (`needsReply`), other
// than the one open in front of him (onScreen.ts). An unread chat stays until he
// replies, marks it read, settles or snoozes it. Folded to its pill by default,
// as on the web, so it never covers the conversation; tapped, it opens into a
// short list grouped by where each chat lives, with what the drawer offers:
// open, stop, snooze, settle, mark as read. A reply that finishes elsewhere
// also raises a toast with Open.
//
// The web mounts it on every screen; here it rides above the chat's composer.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native'
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated'
import { MenuView } from '@react-native-menu/menu'
import { useChat, getState, setActive, stop, settleThread, snoozeThread, markRead, threadTitle, type RunState } from '../../lib/chat/store'
import { useOnScreen, getOnScreen } from '../../lib/chat/onScreen'
import { isSnoozed, ago, snoozePresets } from '../../lib/chat/settle'
import type { ChatThread, Project } from '../../lib/chat/types'
import { pushToast } from '../../lib/toast'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { impact, tap } from '../../ui/haptics'
import { ThreadIcon, ProjectIcon } from './ThreadIcon'
import { TI, vc } from './ui'
import { IconPlayerStopFilled, IconClock, IconCheck, IconMailOpened, IconChevronDown, IconHome } from './icons'

/** Wait this long before a chat joins, so a run that ends at once doesn't flash in. */
const JOIN_DELAY_MS = 500
const FINISHED_TOAST_MS = 8000
const GREEN = '#6fcf8a'

/** Where a chat lives: Home, a project, or "Project › Folder". */
function placeOf(t: ChatThread, projects: Project[]): { key: string; label: string; project: Project | null } {
  const p = t.projectId ? projects.find((x) => x.id === t.projectId) : undefined
  if (!p) return { key: 'home', label: 'Home', project: null }
  const parent = p.parentId ? projects.find((x) => x.id === p.parentId) : undefined
  return { key: p.id, label: parent ? `${parent.name} › ${p.name}` : p.name, project: p }
}

/** Elapsed time, compactly: 8s, 1m 05s, 1h 12m. */
function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function useTick(ms: number) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

/** The last reply failed rather than finished. */
const failedReply = (t: ChatThread) => t.messages[t.messages.length - 1]?.status === 'error'

function LiveDot() {
  return <View style={st.dot} />
}

function Row({ t, run, now, onOpen }: { t: ChatThread; run?: RunState; now: number; onOpen: () => void }) {
  const title = threadTitle(t)
  const failed = !run && failedReply(t)
  const when = ago(t.updatedAt, now)
  const status = run ? `${elapsed(now - run.startedAt)} · ${run.activity?.split('\n')[0] || 'Working'}`
    : failed ? `Failed ${when !== 'now' ? `${when} ago` : 'just now'}`
      : when !== 'now' ? `Done ${when} ago` : 'Done just now'
  const presets = snoozePresets(new Date(now))
  return (
    <View style={st.row}>
      <Press style={st.rowMain} onPress={onOpen} accessibilityLabel={`Open “${title}”`}>
        <ThreadIcon t={t} size={17} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={14} numberOfLines={1}>{title}</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {run ? <LiveDot /> : null}
            <T size={12} numberOfLines={1} color={run ? vc.soft : failed ? '#ff7a8f' : GREEN} style={{ flexShrink: 1, fontVariant: ['tabular-nums'] }}>{status}</T>
          </View>
        </View>
      </Press>
      {run ? (
        <Press style={st.act} onPress={() => { impact(); stop(t.id) }} accessibilityLabel={`Stop ${title}`} hitSlop={2}>
          <TI icon={IconPlayerStopFilled} size={14} color={vc.soft} />
        </Press>
      ) : null}
      <MenuView
        title="Snooze until"
        actions={presets.map((p) => ({ id: String(p.until), title: p.label, subtitle: p.when }))}
        themeVariant="dark"
        onOpenMenu={tap}
        onPressAction={({ nativeEvent }) => { tap(); snoozeThread(t.id, Number(nativeEvent.event)) }}
      >
        <View style={st.act} accessible accessibilityRole="button" accessibilityLabel={`Snooze ${title}`}>
          <TI icon={IconClock} size={16} color={vc.soft} />
        </View>
      </MenuView>
      <Press style={[st.act, !!run && { opacity: 0.35 }]} disabled={!!run} onPress={() => { tap(); settleThread(t.id) }} accessibilityLabel={run ? 'Settle once the reply finishes' : `Settle ${title}`} hitSlop={2}>
        <TI icon={IconCheck} size={16} color={vc.soft} />
      </Press>
      {!run ? (
        <Press style={st.act} onPress={() => { tap(); markRead(t.id) }} accessibilityLabel={`Mark ${title} as read`} hitSlop={2}>
          <TI icon={IconMailOpened} size={16} color={vc.soft} />
        </Press>
      ) : null}
    </View>
  )
}

export default function RunningChats({ onOpenChat }: { onOpenChat?: (id: string) => void }) {
  // Folded it sits at the right, above the composer; open it spans the width.
  const threads = useChat((s) => s.threads)
  const runs = useChat((s) => s.runs)
  const projects = useChat((s) => s.projects)
  const onScreen = useOnScreen()
  const { height } = useWindowDimensions()
  const [collapsed, setCollapsed] = useState(true)
  const now = useTick(Object.keys(runs).length ? 1000 : 30_000)

  const open = useCallback((id: string) => {
    tap()
    setCollapsed(true)
    setActive(id)
    onOpenChat?.(id)
  }, [onOpenChat])

  // A run that ended. Stopped by hand, or dropped mid-stream (the store re-attaches
  // or re-syncs), is not news; a finished or failed reply is.
  const prevRuns = useRef(runs)
  useEffect(() => {
    const before = prevRuns.current
    prevRuns.current = runs
    for (const id of Object.keys(before)) {
      if (runs[id]) continue
      const t = getState().threads.find((x) => x.id === id)
      const last = t?.messages[t.messages.length - 1]
      if (!t || t.totemId || last?.role !== 'assistant' || (last.status !== 'done' && last.status !== 'error')) continue
      if (getOnScreen().open.has(id)) continue
      const failed = last.status === 'error'
      const place = placeOf(t, getState().projects)
      pushToast(
        `${failed ? 'Failed' : 'Finished'}: “${threadTitle(t)}”${place.project ? ` in ${place.label}` : ''}`,
        failed ? 'error' : 'success',
        { duration: FINISHED_TOAST_MS, action: { label: 'Open', icon: null, onClick: () => open(id) } },
      )
    }
  }, [runs, open])

  const candidates = useMemo(() => threads.filter((t) => (
    !t.totemId && (runs[t.id] || t.needsReply) && !onScreen.open.has(t.id)
    && !isSnoozed(t, now) && t.settledOverride !== 'settled'
  )), [threads, runs, onScreen, now])

  // Leaving is immediate; joining waits a moment.
  const [shown, setShown] = useState<string[]>([])
  const shownRef = useRef(shown)
  const commit = (ids: string[]) => { shownRef.current = ids; setShown(ids) }
  const key = candidates.map((t) => t.id).join(',')
  useEffect(() => {
    const ids = key ? key.split(',') : []
    const keep = shownRef.current.filter((id) => ids.includes(id))
    if (keep.length !== shownRef.current.length) commit(keep)
    if (ids.every((id) => keep.includes(id))) return
    const timer = setTimeout(() => commit(ids), JOIN_DELAY_MS)
    return () => clearTimeout(timer)
  }, [key])

  const visible = candidates.filter((t) => shown.includes(t.id))
  const groups = useMemo(() => {
    const out = new Map<string, { label: string; project: Project | null; threads: ChatThread[] }>()
    for (const t of visible) {
      const place = placeOf(t, projects)
      const g = out.get(place.key) || { label: place.label, project: place.project, threads: [] }
      g.threads.push(t)
      out.set(place.key, g)
    }
    return [...out.values()]
  }, [visible, projects])

  if (!visible.length) return null
  const running = visible.filter((t) => runs[t.id]).length
  const done = visible.length - running
  const summary = [running && `${running} running`, done && `${done} unread`].filter(Boolean).join(' · ')

  if (collapsed) {
    return (
      <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(120)} style={{ alignSelf: 'flex-end', marginBottom: 8 }}>
        <Press style={st.pill} onPress={() => { tap(); setCollapsed(false) }} accessibilityLabel={`Other chats: ${summary}. Show them`}>
          {running > 0 ? <LiveDot /> : <TI icon={IconCheck} size={14} color={GREEN} />}
          <T size={13} color={vc.text} style={{ fontVariant: ['tabular-nums'] }}>{summary}</T>
        </Press>
      </Animated.View>
    )
  }

  return (
    <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(120)} style={[st.panel, { marginBottom: 8 }]} accessibilityLabel="Running chats">
      <View style={st.head}>
        <T size={14} weight={600}>Chats</T>
        <T size={13} color={vc.soft} style={{ flex: 1, fontVariant: ['tabular-nums'] }} numberOfLines={1}>{summary}</T>
        <Press style={st.act} onPress={() => { tap(); setCollapsed(true) }} accessibilityLabel="Minimise" hitSlop={4}>
          <TI icon={IconChevronDown} size={17} color={vc.soft} />
        </Press>
      </View>
      <ScrollView style={{ maxHeight: Math.round(height * 0.4) }} contentContainerStyle={{ paddingHorizontal: 6, paddingBottom: 6 }}>
        {groups.map((g) => (
          <View key={g.label}>
            <View style={st.group}>
              {g.project ? <ProjectIcon p={g.project} size={13} /> : <TI icon={IconHome} size={13} color={vc.faint} />}
              <T size={11.5} color={vc.faint} numberOfLines={1}>{g.label}</T>
            </View>
            {g.threads.map((t) => <Row key={t.id} t={t} run={runs[t.id]} now={now} onOpen={() => open(t.id)} />)}
          </View>
        ))}
      </ScrollView>
    </Animated.View>
  )
}

const st = StyleSheet.create({
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 8, height: 34, paddingHorizontal: 13, borderRadius: 999,
    backgroundColor: vc.menu, borderWidth: 1, borderColor: vc.line,
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 6 },
  },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  panel: {
    backgroundColor: vc.menu, borderWidth: 1, borderColor: vc.line, borderRadius: 16, overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 12 },
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, paddingLeft: 14, paddingRight: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: vc.line },
  group: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 9, paddingBottom: 3, paddingHorizontal: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 1, borderRadius: 10 },
  rowMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 50, paddingVertical: 6, paddingHorizontal: 8 },
  act: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
})
