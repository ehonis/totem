// One habit in the Overview's inline check-in: the same controls as the Habits
// tab (HabitsView.tsx: HabitCheckButton, QuotaDots, HabitMetricInput) at the
// sizes overview.css gives them on a phone.
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

// The one big round toggle. Daily habits fill solid once logged; capped weekly or
// monthly ones fill as a pie, one slice per completion in the period. The check is
// about today and shows as soon as the day is logged.
function HabitCheckButton({ habit, count, periodCount, busy, onLog }: {
  habit: any; count: number; periodCount: number; busy: boolean; onLog: (h: any, d: number) => void
}) {
  const capped = habit.cadence !== 'daily'
  const target = Math.max(1, habit.target)
  const ratio = capped ? Math.min(1, periodCount / target) : count > 0 ? 1 : 0
  const full = ratio >= 1
  const done = count > 0
  const size = 34
  const r = (size - 1.5) / 2
  const c = size / 2
  const progress = capped ? `, ${periodCount} of ${target} ${periodLabel(habit.cadence)}` : ''
  const border = !capped ? (done ? habit.color : 'rgba(255, 255, 255, 0.16)') : full ? habit.color : mix(habit.color, colors.line, 0.4)
  // A wedge from 12 o'clock, clockwise.
  const angle = ratio * 2 * Math.PI
  const ex = c + r * Math.sin(angle), ey = c - r * Math.cos(angle)
  const wedge = `M${c},${c}L${c},${c - r}A${r},${r} 0 ${angle > Math.PI ? 1 : 0} 1 ${ex},${ey}Z`
  return (
    <Press
      onPress={() => onLog(habit, done ? -1 : +1)}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={done ? `${habit.name}: done — tap to undo${progress}` : `Mark ${habit.name} done${progress}`}
      hitSlop={6}
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    >
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle
          cx={c} cy={c} r={r}
          fill={!capped ? (done ? habit.color : 'transparent') : full ? habit.color : colors.bg}
          stroke={border} strokeWidth={1.5}
        />
        {capped && ratio > 0 && !full && <Path d={wedge} fill={habit.color} />}
      </Svg>
      {done && <Hi icon={CheckIcon} size={20} color="#fff" />}
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

export function HabitRow({ habit, entry, count, periodCount, busy, onLog, onValue, onNote, first }: {
  habit: any; entry: any; count: number; periodCount: number; busy: boolean; first?: boolean
  onLog: (habit: any, delta: number) => void
  onValue: (habit: any, value: number | null) => void
  onNote: (habit: any) => void
}) {
  const done = periodCount >= habit.target
  return (
    <View style={[st.row, !first && st.rule]}>
      <View style={[st.dot, { backgroundColor: habit.color }]} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T size={14.5} color={done ? ov.soft : colors.text} numberOfLines={1}>{habit.name}</T>
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
      {habit.linkedApp ? null : habit.cadence === 'daily' && habit.target > 1 ? (
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
        <HabitCheckButton habit={habit} count={count} periodCount={periodCount} busy={busy} onLog={onLog} />
      )}
    </View>
  )
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingVertical: 6 },
  rule: { borderTopWidth: 1, borderTopColor: ov.rowLine },
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
