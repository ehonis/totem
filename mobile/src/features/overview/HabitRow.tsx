// One habit in the Overview's inline check-in: the same controls as the Habits
// tab (HabitsView.tsx: HabitCheckButton, QuotaDots, HabitMetricInput) at the
// sizes overview.css gives them on a phone. A group (lib/habits/groups.ts) is a
// GroupRow, its progress and one check that marks them all, with its sub-habits'
// rows under it, indented along a line.
import React, { useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import Svg, { Circle, Path } from 'react-native-svg'
import { colors, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { Hi, CheckIcon } from '../../lib/icons'
import { IconMessageCircle, IconMinus, IconPlus } from '../../lib/components/overview/icons'
import { ov, TI } from './parts'
import { LinkedAppButton, LinkedMetricValue } from '../habits/LinkedApp'

const periodLabel = (cadence: string) => (cadence === 'weekly' ? 'this week' : 'this month')

/** color-mix(in srgb, a p%, b): the pie's border is the habit colour 40% into the line. */
function mix(a: string, b: string, p: number): string {
  const rgb = (h: string) => { const n = parseInt(h.replace('#', '').slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
  const [x, y] = [rgb(a), rgb(b)]
  return `rgb(${x.map((v, i) => Math.round(v * p + y[i] * (1 - p))).join(',')})`
}

/** Weekly/monthly progress as a number (compact QuotaDots: the check draws the pie). */
function QuotaNum({ habit, count }: { habit: any; count: number }) {
  const met = count >= Math.max(1, habit.target)
  return (
    <T size={11} weight={met ? 600 : 400} color={met ? habit.color : colors.muted} accessibilityLabel={`${count} of ${habit.target} ${periodLabel(habit.cadence)}`}>
      {count}/{habit.target} {habit.cadence === 'weekly' ? 'wk' : 'mo'}
    </T>
  )
}

/** The round check's face: solid once done, or a pie for a quota (`capped`). */
function CheckCircle({ color, capped, ratio, done, size }: { color: string; capped: boolean; ratio: number; done: boolean; size: number }) {
  const full = ratio >= 1
  const r = (size - 1.5) / 2
  const c = size / 2
  const border = !capped ? (done ? color : 'rgba(255, 255, 255, 0.16)') : full ? color : mix(color, colors.line, 0.4)
  // A wedge from 12 o'clock, clockwise.
  const angle = ratio * 2 * Math.PI
  const ex = c + r * Math.sin(angle), ey = c - r * Math.cos(angle)
  const wedge = `M${c},${c}L${c},${c - r}A${r},${r} 0 ${angle > Math.PI ? 1 : 0} 1 ${ex},${ey}Z`
  return (
    <>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle
          cx={c} cy={c} r={r}
          fill={!capped ? (done ? color : 'transparent') : full ? color : colors.bg}
          stroke={border} strokeWidth={1.5}
        />
        {capped && ratio > 0 && !full && <Path d={wedge} fill={color} />}
      </Svg>
      {done && <Hi icon={CheckIcon} size={Math.round(size * 0.59)} color="#fff" />}
    </>
  )
}

// The one big round toggle. Daily habits fill solid once logged; capped weekly or
// monthly ones fill as a pie, one slice per completion in the period. The check is
// about today and shows as soon as the day is logged.
function HabitCheckButton({ habit, count, periodCount, busy, onLog, size = 34 }: {
  habit: any; count: number; periodCount: number; busy: boolean; onLog: (h: any, d: number) => void; size?: number
}) {
  const capped = habit.cadence !== 'daily'
  const target = Math.max(1, habit.target)
  const ratio = capped ? Math.min(1, periodCount / target) : count > 0 ? 1 : 0
  const done = count > 0
  const progress = capped ? `, ${periodCount} of ${target} ${periodLabel(habit.cadence)}` : ''
  const circle = <CheckCircle color={habit.color} capped={capped} ratio={ratio} done={done} size={size} />
  // An app fills this one in: the same circle, but not a button (the link sits beside it).
  if (habit.linkedApp) {
    return (
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={`${habit.name}: ${done ? 'done' : 'not yet'}${progress}, filled in by its app`}
        style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
      >
        {circle}
      </View>
    )
  }
  return (
    <Press
      onPress={() => onLog(habit, done ? -1 : +1)}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={done ? `${habit.name}: done — tap to undo${progress}` : `Mark ${habit.name} done${progress}`}
      hitSlop={6}
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    >
      {circle}
    </Press>
  )
}

// Typing stays local until blur so a refreshed payload can't clobber a half-typed
// number, and only a real change is sent.
function HabitMetricInput({ habit, entry, busy, onValue }: {
  habit: any; entry: any; busy: boolean; onValue: (h: any, v: number | null) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const saved = entry?.value != null ? String(entry.value) : ''
  const shown = draft ?? saved
  const commit = () => {
    if (draft === null) return
    const text = draft.trim()
    setDraft(null)
    if (text && !Number.isFinite(Number(text))) return
    const next = text ? Number(text) : null
    if (next === (entry?.value ?? null)) return
    onValue(habit, next)
  }
  return (
    <TextInput
      value={shown}
      onChangeText={setDraft}
      onBlur={commit}
      onSubmitEditing={commit}
      editable={!busy}
      placeholder="—"
      placeholderTextColor={colors.muted}
      keyboardType="decimal-pad"
      keyboardAppearance="dark"
      returnKeyType="done"
      selectionColor={colors.accent}
      accessibilityLabel={`${habit.metric.label} for ${habit.name}`}
      style={[st.metric, shown ? { color: habit.color } : null, busy && { opacity: 0.5 }]}
    />
  )
}

/** A group: its sub-habits done today and one check that marks them all, or clears them once all are. */
export function GroupRow({ habit, done, total, action, busy, first, onLog }: {
  habit: any; done: number; total: number
  /** What the check does, in words (groups.ts groupWords). */
  action: string
  busy: boolean; first?: boolean; onLog: () => void
}) {
  const all = total > 0 && done >= total
  return (
    <View style={[st.row, !first && st.rule]}>
      <View style={[st.dot, { backgroundColor: habit.color }]} />
      <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
        <T size={14.5} color={all ? ov.soft : colors.text} numberOfLines={1} style={{ flexShrink: 1 }}>{habit.name}</T>
        <T size={12} weight={600} color={ov.soft} style={{ fontVariant: ['tabular-nums'] }}>{done}/{total}</T>
      </View>
      <Press
        onPress={onLog}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={action}
        hitSlop={6}
        style={{ width: 34, height: 34, alignItems: 'center', justifyContent: 'center' }}
      >
        <CheckCircle color={habit.color} capped ratio={total ? Math.min(1, done / total) : 0} done={all} size={34} />
      </Press>
    </View>
  )
}

export function HabitRow({ habit, entry, count, periodCount, busy, onLog, onValue, onNote, first, nested }: {
  habit: any; entry: any; count: number; periodCount: number; busy: boolean; first?: boolean
  /** A sub-habit, drawn under its group; `first` is the one right under the group's row. */
  nested?: boolean
  onLog: (habit: any, delta: number) => void
  onValue: (habit: any, value: number | null) => void
  onNote: (habit: any) => void
}) {
  const done = periodCount >= habit.target
  return (
    <View style={[st.row, nested ? [st.nested, first && st.rule] : !first && st.rule]}>
      <View style={[st.dot, { backgroundColor: habit.color }]} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T size={nested ? 14 : 14.5} color={done ? ov.soft : colors.text} numberOfLines={1}>{habit.name}</T>
        {entry?.note ? <T size={12.5} color={ov.faint} numberOfLines={1}>{entry.note}</T> : null}
      </View>
      {habit.cadence !== 'daily' && <QuotaNum habit={habit} count={periodCount} />}
      {habit.metric && (habit.linkedApp
        ? <LinkedMetricValue habit={habit} value={entry?.value} />
        : <HabitMetricInput habit={habit} entry={entry} busy={busy} onValue={onValue} />)}
      {/* A habit an app fills in links to that app instead: nothing here is typed or ticked. */}
      {habit.linkedApp ? <LinkedAppButton habit={habit} compact /> : (
        <Press
          onPress={() => onNote(habit)}
          accessibilityLabel={entry?.note ? `Edit note for ${habit.name}` : `Add a note to ${habit.name}`}
          hitSlop={4}
          style={st.iconBtn}
        >
          <TI icon={IconMessageCircle} size={17} color={entry?.note ? ov.soft : ov.faint} />
        </Press>
      )}
      {habit.cadence === 'daily' && habit.target > 1 && !habit.linkedApp ? (
        <View style={st.stepper}>
          <Press onPress={() => onLog(habit, -1)} disabled={busy || count <= 0} accessibilityLabel={`Undo one ${habit.name}`} style={st.step}>
            <TI icon={IconMinus} size={15} color={ov.soft} />
          </Press>
          <T size={14} weight={600} align="center" color={count > 0 ? habit.color : colors.text} style={{ minWidth: 34 }}>
            {count}<T size={14} color={ov.faint}>/{habit.target}</T>
          </T>
          <Press onPress={() => onLog(habit, +1)} disabled={busy} accessibilityLabel={`Log one ${habit.name}`} style={st.step}>
            <TI icon={IconPlus} size={15} color={ov.soft} />
          </Press>
        </View>
      ) : (
        <HabitCheckButton habit={habit} count={count} periodCount={periodCount} busy={busy} onLog={onLog} size={nested ? 30 : 34} />
      )}
    </View>
  )
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingVertical: 6 },
  rule: { borderTopWidth: 1, borderTopColor: ov.rowLine },
  nested: { marginLeft: 3, paddingLeft: 16, borderLeftWidth: 2, borderLeftColor: ov.line, minHeight: 46 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  iconBtn: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  step: { width: 30, height: 30, borderRadius: 9, borderWidth: 1, borderColor: ov.line, alignItems: 'center', justifyContent: 'center' },
  metric: {
    width: 46, paddingVertical: 7, paddingHorizontal: 5, textAlign: 'right',
    fontSize: 14, fontFamily: fonts[600], color: colors.text,
    backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line, borderRadius: 8,
  },
})
