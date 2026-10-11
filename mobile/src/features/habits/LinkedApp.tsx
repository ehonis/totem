// A habit a sibling app fills in (Krakatoa, Bushido) is never ticked or typed by
// hand here: in place of the check mark, stepper or number box it gets a link to
// that app (HabitsView.tsx LinkedAppButton). Its numbers and history still show.
import React from 'react'
import { StyleSheet, View } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { Hi, ArrowTopRightOnSquareIcon } from '../../lib/icons'
import { APP_NAME, type LinkedApp } from './logic'

type Linked = { linkedApp?: LinkedApp | null; appUrl?: string | null; name: string }

export const linkedAppName = (h: Linked): string => APP_NAME[h.linkedApp as LinkedApp] || 'its app'

export function openLinkedApp(h: Linked) {
  if (!h.appUrl) return
  tap()
  WebBrowser.openBrowserAsync(h.appUrl, { controlsColor: colors.accent, dismissButtonStyle: 'close' }).catch(() => {})
}

/** `compact` (a check-in row) shows just the app's name, as the web does. */
export function LinkedAppButton({ habit, compact }: { habit: Linked; compact?: boolean }) {
  const name = linkedAppName(habit)
  if (!habit.appUrl) {
    return (
      <T size={12} muted numberOfLines={1} style={st.off} accessibilityLabel={`${habit.name} is filled in by ${name}; set ${habit.linkedApp?.toUpperCase()}_URL to link to it`}>
        Set {habit.linkedApp?.toUpperCase()}_URL
      </T>
    )
  }
  return (
    <Press
      onPress={() => openLinkedApp(habit)}
      accessibilityRole="link"
      accessibilityLabel={`${habit.name} is filled in by ${name}. Open ${name}`}
      hitSlop={6}
      style={st.link}
    >
      <T size={13} weight={500} color={colors.accent} numberOfLines={1}>{compact ? name : `Open ${name}`}</T>
      <Hi icon={ArrowTopRightOnSquareIcon} size={13} color={colors.accent} />
    </Press>
  )
}

/** The metric box, read-only: the app's number and its unit. */
export function LinkedMetricValue({ habit, value }: { habit: Linked & { color: string; metric?: { unit?: string } | null }; value: number | null | undefined }) {
  return (
    <T size={14} weight={600} color={value != null ? habit.color : colors.muted} style={st.value} accessibilityLabel={`From ${linkedAppName(habit)}`}>
      {value != null ? value.toLocaleString() : '—'}
      {habit.metric?.unit ? <T size={11} color={colors.muted}> {habit.metric.unit}</T> : null}
    </T>
  )
}

/**
 * A linked habit's day, read-only, for the day sheets: what the app logged and
 * the way to it. Grid taps open the app directly, so this is only a fallback.
 */
export function LinkedDaySummary({ habit, entry }: {
  habit: Linked & { color: string; target: number; metric?: { label: string; unit?: string } | null }
  entry: { count?: number; value?: number | null; note?: string } | undefined
}) {
  const count = entry?.count || 0
  return (
    <View style={{ gap: 12 }}>
      <T size={13} muted>{linkedAppName(habit)} fills this habit in on its own, so it isn't logged here.</T>
      <View style={st.line}>
        <T size={13} muted style={{ flex: 1 }}>Completions</T>
        <T size={15} weight={600} color={count > 0 ? habit.color : colors.muted}>
          {count}{habit.target > 1 ? <T size={11} color={colors.muted}>/{habit.target}</T> : null}
        </T>
      </View>
      {habit.metric && (
        <View style={st.line}>
          <T size={13} muted style={{ flex: 1 }}>{habit.metric.label}</T>
          <LinkedMetricValue habit={habit} value={entry?.value} />
        </View>
      )}
      {entry?.note ? <T size={14}>{entry.note}</T> : null}
      <View style={{ alignSelf: 'flex-start' }}><LinkedAppButton habit={habit} /></View>
    </View>
  )
}

const st = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 4, flexShrink: 0 },
  off: { flexShrink: 1, maxWidth: 140 },
  value: { minWidth: 34, textAlign: 'right', fontVariant: ['tabular-nums'] },
})
