// The pieces of the Tasks page between the cards: the status line (left today, done
// today, the snoozed chip), section headings, the "all clear" note, the task sheet's
// one quiet line, the archive link, the loading skeleton and the empty states.
import React, { useEffect, useRef } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, {
  useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withSequence, withSpring, withTiming,
} from 'react-native-reanimated'
import IconZzz from '@tabler/icons-react-native/dist/esm/icons/IconZzz.mjs'
import { colors, alpha } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press } from '../../ui/kit'
import { Hi, ArchiveBoxIcon, ArrowPathIcon, CheckCircleIcon, ChevronDownIcon, ChevronRightIcon, SunIcon } from '../../lib/icons'
import type { SectionTone } from './list'

const TONE_COLOR: Record<SectionTone, string> = {
  overdue: '#ff7f95', today: '#efc765', upcoming: colors.text, quiet: colors.text, completed: colors.muted,
}

/** "4 left today · 3 done today", the done count popping when it goes up, and the snoozed chip with its next wake. */
export function StatusLine({ ready, leftToday, doneToday, snoozed, nextWake, onSnoozed }: {
  /** The board has loaded: only a rise after that is the owner finishing something. */
  ready: boolean
  /** Open tasks and sheet rows due today or late. */
  leftToday: number
  doneToday: number
  snoozed: number
  nextWake: string | null
  onSnoozed: () => void
}) {
  const reduced = useReducedMotion()
  const pop = useSharedValue(1)
  const last = useRef<number | null>(null)
  useEffect(() => {
    if (!ready) return
    if (last.current !== null && doneToday > last.current && !reduced) {
      pop.value = withSequence(withTiming(1.35, { duration: 120 }), withSpring(1, { damping: 9, stiffness: 240 }))
    }
    last.current = doneToday
  }, [ready, doneToday, reduced, pop])
  const popStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }))
  if (!ready || (!leftToday && !doneToday && !snoozed)) return null
  const spoken = [leftToday ? `${leftToday} left today` : null, doneToday ? `${doneToday} done today` : null].filter(Boolean).join(', ')
  return (
    <View style={st.status}>
      {leftToday || doneToday ? (
        <View style={st.counts} accessible accessibilityLiveRegion="polite" accessibilityLabel={spoken}>
          {leftToday ? (
            <View style={st.done}>
              <T size={13} weight={600} color="#efc765" style={{ fontVariant: ['tabular-nums'] }}>{leftToday.toLocaleString()}</T>
              <T size={13} muted>left today</T>
            </View>
          ) : null}
          {leftToday && doneToday ? <T size={13} muted>·</T> : null}
          {doneToday ? (
            <View style={st.done}>
              <Animated.View style={popStyle}><Hi icon={CheckCircleIcon} size={17} color={colors.green} strokeWidth={2} /></Animated.View>
              <T size={13} weight={600} color={colors.green} style={{ fontVariant: ['tabular-nums'] }}>{doneToday.toLocaleString()}</T>
              <T size={13} muted>done today</T>
            </View>
          ) : null}
        </View>
      ) : <View />}
      {snoozed ? (
        <Press haptic onPress={onSnoozed} style={st.snoozed} hitSlop={6} accessibilityRole="button"
          accessibilityLabel={`${snoozed} snoozed${nextWake ? `, next back ${nextWake}` : ''}. Opens the snoozed tasks`}>
          <IconZzz size={14} color={colors.muted} strokeWidth={2} />
          <T size={12.5} muted numberOfLines={1}>
            {`${snoozed.toLocaleString()} snoozed`}
            {nextWake ? <T size={12.5} color="#b0b6c4">{` · ${nextWake}`}</T> : null}
          </T>
        </Press>
      ) : null}
    </View>
  )
}

export function SectionHeader({ title, count, tone, collapsible, open, onToggle }: {
  title: string
  count: number
  tone: SectionTone
  collapsible?: boolean
  open?: boolean
  onToggle?: () => void
}) {
  const color = TONE_COLOR[tone]
  const body = (
    <>
      <T size={14} weight={600} color={color}>{title}</T>
      <T size={13} muted style={{ fontVariant: ['tabular-nums'] }}>{count.toLocaleString()}</T>
      {/* Beside the count, not at the far edge: the floating buttons cover the right of the list's foot. */}
      {collapsible ? <Hi icon={open ? ChevronDownIcon : ChevronRightIcon} size={15} color={colors.muted} /> : null}
    </>
  )
  if (!collapsible) return <View style={st.header} accessibilityRole="header">{body}</View>
  return (
    <Press haptic onPress={onToggle} style={[st.header, st.collapsible]} accessibilityRole="button" accessibilityState={{ expanded: !!open }}
      accessibilityLabel={`${title}, ${count}`} accessibilityHint={open ? 'Folds the completed tasks' : 'Shows the completed tasks'}>
      {body}
    </Press>
  )
}

/**
 * Nothing open, or nothing due today: say so, and say what comes next. The "today"
 * one is a single line, since an owner whose tasks are mostly undated sees it daily.
 */
export function ClearNote({ scope, doneToday, next }: { scope: 'all' | 'today'; doneToday: number; next: string | null }) {
  if (scope === 'today') {
    return (
      <View style={st.clearSlim} accessibilityRole="summary">
        <Hi icon={SunIcon} size={16} color={colors.amber} />
        <T size={13} muted numberOfLines={2} style={{ flex: 1 }}>
          <T size={13} weight={600} color={colors.text}>Nothing due today.</T>
          {next ? ` ${next}` : ''}
        </T>
      </View>
    )
  }
  const title = 'All clear'
  const lines = [
    doneToday ? `You finished ${doneToday.toLocaleString()} today.` : null,
    next,
  ].filter(Boolean)
  return (
    <View style={st.clear} accessibilityRole="summary">
      <Hi icon={SunIcon} size={20} color={colors.amber} />
      <View style={{ flex: 1, gap: 2 }}>
        <T size={15} weight={600}>{title}</T>
        {lines.map((line) => <T key={line} size={13} muted lineHeight={18}>{line}</T>)}
      </View>
    </View>
  )
}

/**
 * The task sheet's state, said once at the foot of the list and only when the rows
 * cannot say it: it could not be read (tap to try again), or nothing in it is
 * assigned to the owner. A sheet that is not set up says nothing here.
 */
export function SheetLine({ tone, text, onRetry }: { tone: 'quiet' | 'problem'; text: string; onRetry: () => void }) {
  if (tone === 'quiet') {
    return <View style={st.sheetLine}><T size={12.5} muted lineHeight={17} style={{ flex: 1 }}>{text}</T></View>
  }
  return (
    <Press haptic onPress={onRetry} style={st.sheetLine} accessibilityRole="button" accessibilityLabel={text}>
      <Hi icon={ArrowPathIcon} size={14} color={colors.muted} />
      <T size={12.5} muted lineHeight={17} style={{ flex: 1 }}>{text}</T>
    </Press>
  )
}

export function ArchiveLink({ count, onPress }: { count: number; onPress: () => void }) {
  return (
    <Press haptic onPress={onPress} style={st.archive} accessibilityRole="button" accessibilityLabel={`Archive, ${count} tasks`}>
      <Hi icon={ArchiveBoxIcon} size={16} color={colors.muted} />
      <T size={13} muted style={{ flex: 1 }}>Archive</T>
      <T size={13} muted style={{ fontVariant: ['tabular-nums'] }}>{count.toLocaleString()}</T>
      <Hi icon={ChevronRightIcon} size={14} color={colors.muted} />
    </Press>
  )
}

export function ShowMore({ count, onPress }: { count: number; onPress: () => void }) {
  return (
    <Press haptic onPress={onPress} style={st.more} accessibilityRole="button">
      <T size={13} muted>{`Show ${count.toLocaleString()} more`}</T>
    </Press>
  )
}

/** Card-shaped placeholders while the first load runs; still under Reduce Motion. */
export function BoardSkeleton() {
  const reduced = useReducedMotion()
  const pulse = useSharedValue(0.55)
  useEffect(() => {
    if (!reduced) pulse.value = withRepeat(withTiming(1, { duration: 750 }), -1, true)
  }, [reduced, pulse])
  const style = useAnimatedStyle(() => ({ opacity: pulse.value }))
  return (
    <Animated.View style={[{ gap: 8, paddingTop: 6 }, style]} accessibilityLabel="Loading tasks" accessibilityRole="progressbar">
      <View style={[st.bar, { width: 70, height: 12, marginLeft: 4, marginBottom: 2 }]} />
      {[0.8, 0.55, 0.7, 0.45, 0.62].map((width, index) => (
        <View key={index} style={st.ghost}>
          <View style={st.ghostRing} />
          <View style={{ flex: 1, gap: 8 }}>
            <View style={[st.bar, { width: `${width * 100}%` }]} />
            <View style={[st.bar, { width: '30%', height: 9 }]} />
          </View>
        </View>
      ))}
    </Animated.View>
  )
}

export function EmptyBoard({ kind, snoozedNote, onClear, sheetOnly }: {
  kind: 'nothing' | 'filtered'
  snoozedNote: string | null
  onClear: () => void
  /** Showing the task sheet alone: what it says when empty depends on whether it is set up, or could not be read (list.ts sheetOnlyEmpty). */
  sheetOnly?: { title: string; body: string }
}) {
  const title = sheetOnly ? sheetOnly.title : kind === 'nothing' ? 'Nothing on your list' : 'No tasks match'
  const body = sheetOnly ? sheetOnly.body : kind === 'nothing' ? 'Tap + to add a task.' : 'Nothing open or finished fits this search and these filters.'
  return (
    <View style={st.empty}>
      <Hi icon={kind === 'nothing' ? SunIcon : CheckCircleIcon} size={28} color={kind === 'nothing' ? colors.amber : colors.muted} />
      <T size={16} weight={600} align="center">{title}</T>
      <T size={13} muted align="center" lineHeight={19}>
        {body}
        {snoozedNote ? `\n${snoozedNote}` : ''}
      </T>
      {kind === 'filtered' ? <Btn title="Clear search and filters" compact onPress={onClear} style={{ marginTop: 4, minHeight: 44 }} /> : null}
    </View>
  )
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={st.loadError} accessibilityRole="alert">
      <T weight={600} color="#ff9caf">Tasks could not load.</T>
      <T muted size={13}>{message}</T>
      <Btn title="Try again" compact onPress={onRetry} style={{ alignSelf: 'flex-start', minHeight: 44 }} />
    </View>
  )
}

const st = StyleSheet.create({
  // The counts never shrink; on a narrow phone the snoozed chip wraps under them rather than cutting them off.
  status: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 10, rowGap: 4, minHeight: 36, paddingHorizontal: 4, paddingVertical: 2 },
  counts: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
  done: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  sheetLine: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 6, marginTop: 4 },
  snoozed: {
    flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1, minHeight: 32, paddingHorizontal: 10,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: 999, backgroundColor: colors.bg2,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 36, paddingHorizontal: 4, paddingTop: 10 },
  collapsible: { minHeight: 48, paddingTop: 8, alignSelf: 'flex-start', paddingRight: 16 },
  clearSlim: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36, paddingHorizontal: 4 },
  clear: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14, marginTop: 4,
    borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: alpha(colors.amber, 0.3), backgroundColor: alpha(colors.amber, 0.06),
  },
  archive: {
    flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 46, paddingHorizontal: 12, marginTop: 4,
    borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line,
  },
  more: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderStyle: 'dashed', borderColor: colors.line, borderRadius: 12 },
  ghost: {
    flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 62, paddingHorizontal: 14,
    borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.bg2,
  },
  ghostRing: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: colors.bg3 },
  bar: { height: 12, borderRadius: 6, backgroundColor: colors.bg3 },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 48, paddingHorizontal: 24 },
  loadError: { gap: 8, padding: 12, marginTop: 8, borderWidth: 1, borderColor: '#f0506e55', borderRadius: 12, backgroundColor: '#f0506e0f' },
})
