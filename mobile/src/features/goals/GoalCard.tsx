// One goal (web/src/goals/GoalCard.tsx): derived icon, title, state chips, the "…"
// menu and the trophy check; its numbers with their bars and log controls; its steps;
// its links. A finished goal is an achievement — a green ring, a wash and an
// "Achieved" chip, never a strikethrough. Only a goal you stopped is crossed off.
// Editing the title/note and the numbers open as sheets; postpone and delete confirm
// with the platform alert.
import React, { useEffect, useRef, useState } from 'react'
import { Animated, StyleSheet, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import IconActivityHeartbeat from '@tabler/icons-react-native/dist/esm/icons/IconActivityHeartbeat.mjs'
import { colors, alpha, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press } from '../../ui/kit'
import { confirm } from '../../ui/menu'
import { success, tap } from '../../ui/haptics'
import {
  Hi, BookmarkIcon, ChartBarIcon, CheckBadgeSolidIcon, CheckCircleIcon, ClockIcon, EllipsisHorizontalIcon,
  FlagIcon, NoSymbolIcon, PencilIcon, PlayIcon, TrophySolidIcon, XMarkIcon,
} from '../../lib/icons'
import { GOAL_DONE_ICON, goalIconFor } from '../../lib/goals/goalIcon'
import { formatAmount } from '../../lib/goals/types'
import type { Goal, GoalMetric, GoalPeriodType, SubGoal } from '../../lib/goals/types'
import { NativeMenu } from './NativeMenu'
import { openUrl } from '../../lib/siblingApps'

/** One hue per horizon (.period-week …), shared with the tabs and the overview. */
export const PERIOD_COLOR: Record<GoalPeriodType, string> = {
  week: '#5b8cff', month: '#7c5cff', quarter: '#2bb8a6', year: '#e3b341', custom: colors.muted,
}
const LIME = '#b8f23d'

/** Bushido is matched on host, so a renamed app's old links still count. */
export const bushidoLinkOf = (goal: Goal, hosts: string[] = []) =>
  hosts.length ? goal.links.find((l) => l.kind === 'url' && !!l.url && hosts.some((h) => l.url!.includes(h))) : undefined

function freshness(readAt: string | null): string | null {
  const at = readAt ? Date.parse(readAt) : NaN
  if (!Number.isFinite(at)) return null
  const minutes = Math.round((Date.now() - at) / 60000)
  if (minutes < 2) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function achievedOn(completedAt: string | null): string | null {
  const at = completedAt ? Date.parse(completedAt) : NaN
  if (!Number.isFinite(at)) return null
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

type ChipKind = 'plain' | 'achieved' | 'notDoing' | 'expired' | 'urgent' | 'warn' | 'source' | 'bushido' | 'link'
const CHIP: Record<ChipKind, { border: string; fg: string; bg?: string; weight?: 600 }> = {
  plain: { border: colors.line, fg: colors.muted },
  achieved: { border: alpha(colors.green, 0.55), fg: colors.green, bg: alpha(colors.green, 0.14), weight: 600 },
  notDoing: { border: alpha(colors.muted, 0.45), fg: colors.muted },
  expired: { border: alpha(colors.amber, 0.33), fg: colors.amber },
  urgent: { border: alpha(colors.accent, 0.33), fg: colors.accent },
  warn: { border: alpha(colors.red, 0.33), fg: colors.red },
  source: { border: alpha(colors.accent2, 0.33), fg: colors.accent2 },
  bushido: { border: alpha(LIME, 0.47), fg: LIME, bg: alpha(LIME, 0.08) },
  link: { border: colors.line, fg: colors.muted },
}

export function Chip({ kind = 'plain', icon, iconSize = 11, children, onPress, strike }: {
  kind?: ChipKind
  icon?: any
  iconSize?: number
  children: React.ReactNode
  onPress?: () => void
  strike?: boolean
}) {
  const c = CHIP[kind]
  const body = (
    <View style={[s.chip, { borderColor: c.border, backgroundColor: c.bg ?? colors.bg3 }, strike && { opacity: 0.7 }]}>
      {icon ? <Hi icon={icon} size={iconSize} color={c.fg} /> : null}
      <T size={11} weight={c.weight} color={c.fg} numberOfLines={1} style={strike ? { textDecorationLine: 'line-through' } : undefined}>{children}</T>
    </View>
  )
  return onPress ? <Press onPress={onPress}>{body}</Press> : body
}

/** .goal-bar: the accent→accent-2 gradient fill (green once the goal is done). */
export function GoalBar({ percent, done, unreadable }: { percent: number; done?: boolean; unreadable?: boolean }) {
  const [w, setW] = useState(0)
  const fill = Math.max(0, Math.min(100, percent))
  return (
    <View style={[s.bar, unreadable && { backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.bg3 }]} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {w > 0 && fill > 0 && (
        <Svg width={(w * fill) / 100} height={6}>
          <Defs>
            <LinearGradient id={done ? "goalbar-done" : "goalbar"} x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor={done ? colors.green : colors.accent} />
              <Stop offset="1" stopColor={done ? '#6ee787' : colors.accent2} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width={(w * fill) / 100} height={6} fill={done ? "url(#goalbar-done)" : "url(#goalbar)"} />
        </Svg>
      )}
    </View>
  )
}

function Percent({ value, done }: { value: number | null; done?: boolean }) {
  return (
    <T size={13} weight={600} align="right" color={done ? '#8fd99a' : colors.muted} style={{ minWidth: 38, fontVariant: ['tabular-nums'] }}>
      {value === null ? '—' : `${value}%`}
    </T>
  )
}

function MetricRow({ metric, onLog, busy, percentAtEnd, done }: {
  metric: GoalMetric
  onLog: (patch: { value?: number; delta?: number }) => void
  busy: boolean
  percentAtEnd?: number | null
  done?: boolean
}) {
  const [draft, setDraft] = useState('')
  const sourced = metric.sourceKind !== 'manual'
  const synced = metric.available ? freshness(metric.readAt) : null
  return (
    <View style={[{ gap: 5 }, !metric.available && { opacity: 0.75 }]}>
      {/* Wraps rather than squeezes: a long "can't read" reason drops to its own
          line instead of truncating the label to a few letters. */}
      <View style={s.metricHead}>
        <View style={s.metricName}>
          <T size={13} weight={500} style={{ flexShrink: 1 }}>{metric.label}</T>
          {sourced && <Chip kind="source">auto</Chip>}
        </View>
        {metric.available
          ? <T size={13} style={s.metricAmount}>{formatAmount(metric.value ?? 0, metric.unit)} <T size={13} muted>/ {formatAmount(metric.targetValue, metric.unit)}</T></T>
          : <T size={13} muted style={s.metricAmount}>can’t read — {metric.unavailableReason}</T>}
      </View>
      <View style={s.barRow}>
        <View style={{ flex: 1 }}><GoalBar percent={metric.available ? metric.percent ?? 0 : 0} done={done} unreadable={!metric.available} /></View>
        {percentAtEnd !== undefined && <Percent value={percentAtEnd} done={done} />}
      </View>
      <View style={s.metricFoot}>
        {metric.feederCount > 0 && metric.available && (
          <T size={11} muted>
            incl. {formatAmount(metric.rolledUpValue ?? 0, metric.unit)} from {metric.feederCount} step{metric.feederCount === 1 ? '' : 's'}
            {metric.unreadableFeederCount > 0 && ` · ${metric.unreadableFeederCount} unreadable`}
          </T>
        )}
        {sourced ? (
          <T size={11} muted style={{ flexShrink: 1 }}>{metric.sourceLabel}{synced ? ` · synced ${synced}` : ''}</T>
        ) : (
          <View style={s.log}>
            <Btn compact title="+1" disabled={busy} onPress={() => onLog({ delta: 1 })} />
            <TextInput
              value={draft}
              placeholder="log"
              placeholderTextColor={colors.muted}
              keyboardType="numbers-and-punctuation"
              keyboardAppearance="dark"
              returnKeyType="done"
              editable={!busy}
              accessibilityLabel={`Log ${metric.label}`}
              onChangeText={setDraft}
              onSubmitEditing={() => {
                const n = Number(draft)
                if (!draft.trim() || !Number.isFinite(n)) return
                onLog({ delta: n })
                setDraft('')
              }}
              style={s.logInput}
            />
          </View>
        )}
      </View>
    </View>
  )
}

function SubGoalRow({ subGoal, busy, onToggle, onAbandon, onRename, onLog, onEditNumbers }: {
  subGoal: SubGoal
  busy: boolean
  onToggle: () => void
  onAbandon?: (abandoned: boolean) => void
  onRename?: (title: string) => void
  onLog: (metricId: string, patch: { value?: number; delta?: number }) => void
  onEditNumbers?: () => void
}) {
  const name = subGoal.title || 'this step'
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState(subGoal.title ?? '')
  // Blur saves as well as return: tapping away is how you finish typing on a phone.
  const saveRename = () => {
    setRenaming(false)
    const title = titleDraft.trim()
    if (title !== (subGoal.title ?? '').trim()) onRename?.(title)
  }
  const notDoing = subGoal.abandoned && !subGoal.complete
  const tool = (icon: any, label: string, onPress: () => void, disabled?: boolean) => (
    <Press haptic onPress={onPress} disabled={busy || disabled} accessibilityLabel={label} hitSlop={4} style={s.stepTool}>
      <Hi icon={icon} size={14} color={colors.muted} />
    </Press>
  )
  return (
    <View style={[s.step, subGoal.abandoned && { opacity: 0.72 }]}>
      <Press
        onPress={() => { if (!subGoal.complete) success(); else tap(); onToggle() }}
        disabled={busy}
        accessibilityLabel={subGoal.complete ? `Reopen ${name}` : `Mark ${name} done`}
        hitSlop={6}
        style={{ width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}
      >
        {subGoal.complete ? <Hi icon={CheckCircleIcon} size={20} color={colors.green} /> : <View style={s.ring} />}
      </Press>
      <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
        {renaming ? (
          <TextInput
            autoFocus value={titleDraft} onChangeText={setTitleDraft} onBlur={saveRename} onSubmitEditing={saveRename}
            keyboardAppearance="dark" returnKeyType="done" accessibilityLabel={`Rename ${name}`}
            style={s.rename}
          />
        ) : (
          <T
            size={13}
            color={subGoal.complete ? '#a8cfb0' : notDoing ? colors.muted : colors.text}
            style={notDoing ? { textDecorationLine: 'line-through' } : undefined}
          >
            {subGoal.title || <T size={13} muted style={{ fontStyle: 'italic' }}>unnamed step</T>}
            {subGoal.metrics.length > 0 && subGoal.progress.percent !== null && !subGoal.complete
              ? <T size={11} muted>{`  ${subGoal.progress.percent}%`}</T> : null}
          </T>
        )}
        {subGoal.metrics.map((metric) => (
          <MetricRow key={metric.id} metric={metric} busy={busy} onLog={(patch) => onLog(metric.id, patch)} />
        ))}
      </View>
      {onRename && tool(PencilIcon, `Rename ${name}`, () => { setTitleDraft(subGoal.title ?? ''); setRenaming(true) }, renaming)}
      {onEditNumbers && tool(ChartBarIcon, subGoal.metrics.length ? `Edit the numbers on ${name}` : `Track a number on ${name}`, onEditNumbers)}
      {onAbandon && tool(subGoal.abandoned ? PlayIcon : NoSymbolIcon, subGoal.abandoned ? `Start ${name} again` : `Not doing ${name}`, () => onAbandon(!subGoal.abandoned))}
    </View>
  )
}

export interface GoalCardActions {
  onToggle: () => void
  onToggleStep: (id: string, complete: boolean) => void
  onLog: (metricId: string, patch: { value?: number; delta?: number }) => void
  onPostpone: () => void
  onDelete: () => void
  onAbandon: (abandoned: boolean) => void
  onAbandonStep: (id: string, abandoned: boolean) => void
  onRenameStep: (id: string, title: string) => void
  onAddStep: (title: string) => void
  onToggleBushido?: (current: { id: string } | null) => void
}

export default function GoalCard({ goal, busy, bushidoHosts = [], actions }: {
  goal: Goal
  busy: boolean
  bushidoHosts?: string[]
  actions: GoalCardActions
}) {
  const bushidoLink = bushidoLinkOf(goal, bushidoHosts)
  const Glyph = goal.complete ? GOAL_DONE_ICON : goalIconFor(goal)
  const [adding, setAdding] = useState(false)
  const [stepDraft, setStepDraft] = useState('')
  const period = PERIOD_COLOR[goal.period.type] ?? colors.muted
  const done = goal.complete
  const notDoing = goal.abandoned && !done
  const singleMetric = goal.metrics.length === 1 && goal.subGoals.length === 0

  // The flourish hangs off the transition into done, never off loading a done goal.
  const pop = useRef(new Animated.Value(1)).current
  const wasComplete = useRef(goal.complete)
  useEffect(() => {
    const was = wasComplete.current
    wasComplete.current = goal.complete
    if (!goal.complete || was) return
    success()
    Animated.sequence([
      Animated.timing(pop, { toValue: 1.025, duration: 160, useNativeDriver: true }),
      Animated.spring(pop, { toValue: 1, friction: 4, useNativeDriver: true }),
    ]).start()
  }, [goal.complete, pop])

  const openNumbers = (step?: string) => router.push({ pathname: '/goal/numbers', params: step ? { id: goal.id, step } : { id: goal.id } })
  const openEdit = (mode: 'all' | 'note') => router.push({ pathname: '/goal/edit', params: { id: goal.id, mode } })

  const sections = [
    [
      { id: 'step', title: 'Add a step', image: 'plus', onPress: () => setAdding(true) },
      { id: 'numbers', title: goal.metrics.length > 0 ? 'Edit the numbers' : 'Track a number', image: 'chart.bar', onPress: () => openNumbers() },
      {
        id: 'postpone', title: `Move to the next ${goal.period.type}`, image: 'arrow.right',
        // Always confirmed: the count behind it is a record of a decision.
        onPress: async () => { if (await confirm(`Move to the next ${goal.period.type}?`, { confirmLabel: 'Move', destructive: false })) actions.onPostpone() },
      },
      ...(actions.onToggleBushido ? [{
        id: 'bushido', title: bushidoLink ? 'Remove from Bushido' : 'Show in Bushido', image: 'waveform.path.ecg',
        onPress: () => actions.onToggleBushido!(bushidoLink ?? null),
      }] : []),
    ],
    [
      { id: 'note', title: goal.notes ? 'Edit note' : 'Add a note', image: 'bubble.left', onPress: () => openEdit('note') },
      { id: 'edit', title: 'Edit goal', image: 'square.and.pencil', onPress: () => openEdit('all') },
      {
        id: 'abandon', title: goal.abandoned ? 'Start doing this again' : 'Not doing this', image: goal.abandoned ? 'play' : 'nosign',
        onPress: () => actions.onAbandon(!goal.abandoned),
      },
    ],
    [
      {
        id: 'delete', title: 'Delete goal', image: 'trash', destructive: true,
        onPress: async () => { if (await confirm('Delete this goal?', { message: goal.title })) actions.onDelete() },
      },
    ],
  ]

  const links = goal.links.filter((l) => l.id !== bushidoLink?.id)

  return (
    <Animated.View
      style={[
        s.card,
        { borderLeftColor: alpha(period, 0.45) },
        goal.periodState === 'expired' && { borderLeftColor: colors.amber },
        done && s.cardDone,
        notDoing && { opacity: 0.72 },
        { transform: [{ scale: pop }] },
      ]}
    >
      {done && (
        <View pointerEvents="none" style={s.washClip}>
        <Svg width="100%" height={110}>
          <Defs>
            <LinearGradient id="goalwash" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={colors.green} stopOpacity={0.1} />
              <Stop offset="1" stopColor={colors.green} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width="100%" height={110} fill="url(#goalwash)" />
        </Svg>
        </View>
      )}
      <View style={s.head}>
        <View style={[s.icon, done
          ? { backgroundColor: alpha(colors.green, 0.16), borderColor: alpha(colors.green, 0.45) }
          : { backgroundColor: alpha(period, 0.14), borderColor: alpha(period, 0.28) }]}>
          <Hi icon={Glyph} size={17} color={done ? colors.green : period} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={15} weight={600} color={notDoing ? colors.muted : colors.text} style={notDoing ? { textDecorationLine: 'line-through' } : undefined}>
            {goal.title}
          </T>
          <View style={s.chips}>
            {done && (
              <Chip kind="achieved" icon={CheckBadgeSolidIcon} iconSize={12}>
                {achievedOn(goal.completedAt) ? `Achieved ${achievedOn(goal.completedAt)}` : 'Achieved'}
              </Chip>
            )}
            {goal.abandoned && <Chip kind="notDoing">not doing</Chip>}
            {goal.periodState === 'expired' && !done && <Chip kind="expired">expired</Chip>}
            {goal.periodState === 'active' && !done && goal.daysLeft <= 2 && (
              <Chip kind="urgent" icon={ClockIcon}>{goal.daysLeft} day{goal.daysLeft === 1 ? '' : 's'} left</Chip>
            )}
            {goal.postponedCount > 0 && <Chip kind={goal.postponedCount >= 3 ? 'warn' : 'plain'} icon={FlagIcon}>moved {goal.postponedCount}×</Chip>}
            {goal.progress.subGoalsTotal > 0 && <Chip>{goal.progress.subGoalsDone}/{goal.progress.subGoalsTotal} steps</Chip>}
            {goal.progress.subGoalsAbandoned > 0 && (
              <Chip kind="notDoing">{goal.progress.subGoalsAbandoned} step{goal.progress.subGoalsAbandoned === 1 ? '' : 's'} not doing</Chip>
            )}
            {bushidoLink && <Chip kind="bushido" icon={IconActivityHeartbeat} iconSize={14}>Bushido</Chip>}
          </View>
        </View>
        <View style={s.tools}>
          <NativeMenu sections={sections} title={goal.title} label={`More actions for ${goal.title}`} disabled={busy}>
            <View style={s.menuBtn}><Hi icon={EllipsisHorizontalIcon} size={17} color={colors.muted} /></View>
          </NativeMenu>
          <Press
            onPress={() => { tap(); actions.onToggle() }}
            disabled={busy}
            hitSlop={6}
            accessibilityLabel={done ? `Reopen ${goal.title}` : `Mark ${goal.title} complete`}
            style={done ? s.won : s.checkBox}
          >
            {done ? <Hi icon={TrophySolidIcon} size={20} color={colors.amber} /> : <View style={s.bigRing} />}
          </Press>
        </View>
      </View>

      {goal.notes ? <T size={13} muted>{goal.notes}</T> : null}

      {goal.metrics.map((metric) => (
        <MetricRow
          key={metric.id} metric={metric} busy={busy} done={done}
          onLog={(patch) => actions.onLog(metric.id, patch)}
          percentAtEnd={singleMetric ? goal.progress.percent : undefined}
        />
      ))}

      {/* No single metric to hang it off, so the goal gets a bar of its own. */}
      {!singleMetric && (
        <View style={[s.barRow, { marginTop: 2 }]}>
          <View style={{ flex: 1 }}><GoalBar percent={goal.progress.percent ?? 0} done={done} /></View>
          <Percent value={goal.progress.percent} done={done} />
        </View>
      )}

      {goal.subGoals.length > 0 && (
        <View style={s.steps}>
          {goal.subGoals.map((sub) => (
            <SubGoalRow
              key={sub.id} subGoal={sub} busy={busy}
              onToggle={() => actions.onToggleStep(sub.id, !sub.complete)}
              onAbandon={(abandoned) => actions.onAbandonStep(sub.id, abandoned)}
              onRename={(title) => actions.onRenameStep(sub.id, title)}
              onEditNumbers={() => openNumbers(sub.id)}
              onLog={actions.onLog}
            />
          ))}
        </View>
      )}

      {links.length > 0 && (
        <View style={s.chips}>
          {links.map((link) => (
            <Chip
              key={link.id}
              kind="link"
              icon={BookmarkIcon}
              strike={link.todo?.status === 'done'}
              onPress={link.kind === 'url' && link.url ? () => { void openUrl(link.url!) } : undefined}
            >
              {link.kind === 'url' && link.url ? link.label : link.todo?.title ?? link.label}
            </Chip>
          ))}
        </View>
      )}

      {adding && (
        <View style={s.addStep}>
          <TextInput
            autoFocus value={stepDraft} placeholder="A step toward this…" placeholderTextColor={colors.muted}
            keyboardAppearance="dark" returnKeyType="done" accessibilityLabel="New step"
            onChangeText={setStepDraft}
            onSubmitEditing={() => {
              if (!stepDraft.trim()) return
              actions.onAddStep(stepDraft.trim())
              setStepDraft(''); setAdding(false)
            }}
            style={s.addInput}
          />
          <Btn compact icon={XMarkIcon} onPress={() => { setAdding(false); setStepDraft('') }} />
        </View>
      )}
    </Animated.View>
  )
}

const s = StyleSheet.create({
  card: {
    backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, borderLeftWidth: 3,
    borderRadius: 12, padding: 14, gap: 10,
  },
  washClip: { position: 'absolute', top: 0, left: 0, right: 0, height: 110, borderTopRightRadius: 11, overflow: 'hidden' },
  cardDone: {
    borderColor: '#244f33', borderLeftColor: colors.green,
    shadowColor: colors.green, shadowOpacity: 0.35, shadowRadius: 14, shadowOffset: { width: 0, height: 6 },
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  icon: { width: 30, height: 30, borderRadius: 9, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 5 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 2, paddingHorizontal: 7, borderRadius: 999, borderWidth: 1, maxWidth: 260,
  },
  tools: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  menuBtn: { width: 28, height: 28, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  checkBox: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  bigRing: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.muted },
  ring: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.muted },
  won: {
    width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    backgroundColor: alpha(colors.amber, 0.15), borderWidth: 1, borderColor: alpha(colors.amber, 0.45),
    shadowColor: colors.amber, shadowOpacity: 0.5, shadowRadius: 8, shadowOffset: { width: 0, height: 0 },
  },
  bar: { height: 6, borderRadius: 999, backgroundColor: colors.bg3, overflow: 'hidden' },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  metricHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 10, rowGap: 2 },
  metricName: { flexDirection: 'row', alignItems: 'center', gap: 7, flexShrink: 1, maxWidth: '100%' },
  metricAmount: { marginLeft: 'auto', textAlign: 'right', fontVariant: ['tabular-nums'], flexShrink: 1 },
  metricFoot: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 24, flexWrap: 'wrap' },
  log: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 5 },
  logInput: {
    width: 62, backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line, color: colors.text,
    borderRadius: 8, paddingVertical: 5, paddingHorizontal: 7, fontSize: 16, fontFamily: fonts[400],
  },
  steps: { gap: 8, borderLeftWidth: 2, borderLeftColor: colors.line, paddingLeft: 10, marginLeft: 4 },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  stepTool: { width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  rename: {
    paddingVertical: 3, paddingHorizontal: 8, borderWidth: 1, borderColor: colors.line, borderRadius: 7,
    backgroundColor: colors.bg, color: colors.text, fontSize: 16, fontFamily: fonts[400],
  },
  addStep: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  addInput: {
    flex: 1, backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line, color: colors.text,
    borderRadius: 8, paddingVertical: 6, paddingHorizontal: 9, fontSize: 16, fontFamily: fonts[400],
  },
})
