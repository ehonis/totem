// Every horizon at once (web/src/goals/GoalsOverview.tsx): this week, this month and
// this year stacked, each coloured by its period. Read-only on purpose — logging and
// completing stay on the full card; each column's Open goes to that period.
import React, { useCallback, useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn } from '../../ui/kit'
import { Hi, ArrowRightIcon, TrophyIcon } from '../../lib/icons'
import { AuthError, clearSecret, getGoals } from '../../lib/api'
import { GOAL_DONE_ICON, goalIconFor } from '../../lib/goals/goalIcon'
import type { Goal, GoalPeriodShortcut } from '../../lib/goals/types'
import { PERIOD_COLOR } from './GoalCard'

const COLUMNS: { shortcut: GoalPeriodShortcut; type: 'week' | 'month' | 'year'; title: string }[] = [
  { shortcut: 'this_week', type: 'week', title: 'This week' },
  { shortcut: 'this_month', type: 'month', title: 'This month' },
  { shortcut: 'this_year', type: 'year', title: 'This year' },
]

interface Column { goals: Goal[]; error: string }

function GoalLine({ goal, color }: { goal: Goal; color: string }) {
  const Glyph = goal.complete ? GOAL_DONE_ICON : goalIconFor(goal)
  const percent = goal.progress.percent
  const tint = goal.complete ? colors.green : color
  const notDoing = goal.abandoned && !goal.complete
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Hi icon={Glyph} size={15} color={tint} />
        <T size={13} numberOfLines={1} style={[{ flex: 1 }, notDoing && { color: colors.muted, textDecorationLine: 'line-through' }]}>{goal.title}</T>
        <T size={12} color={goal.complete ? colors.green : colors.muted} style={{ fontVariant: ['tabular-nums'] }}>{percent === null ? '—' : `${percent}%`}</T>
      </View>
      <View style={[s.thin, { marginLeft: 23 }]}><View style={{ width: `${percent ?? 0}%`, height: '100%', backgroundColor: tint }} /></View>
    </View>
  )
}

export default function GoalsOverview({ onOpenPeriod, reloadKey = 0 }: { onOpenPeriod: (p: GoalPeriodShortcut) => void; reloadKey?: number }) {
  // Columns appear as they first load and then update in place: a reload never
  // blanks them, and a column whose reload fails keeps the goals it showed.
  const [columns, setColumns] = useState<Record<string, Column>>({})

  const load = useCallback(async () => {
    // One request per window, settled independently: one failing costs only its column.
    const results = await Promise.all(COLUMNS.map(async (column) => {
      try {
        return [column.shortcut, { goals: (await getGoals(column.shortcut)).goals, error: '' }] as const
      } catch (cause) {
        if (cause instanceof AuthError) throw cause
        return [column.shortcut, { goals: [], error: cause instanceof Error ? cause.message : 'Could not load.' }] as const
      }
    })).catch((cause) => {
      if (cause instanceof AuthError) clearSecret()
      return [] as (readonly [string, Column])[]
    })
    setColumns((prev) => {
      const next: Record<string, Column> = { ...prev }
      for (const [key, column] of results) next[key] = column.error && prev[key]?.goals.length ? prev[key] : { goals: [...column.goals], error: column.error }
      return next
    })
  }, [])

  useEffect(() => { void load() }, [load, reloadKey])

  return (
    <View style={{ gap: 12 }}>
      {COLUMNS.map((column) => {
        const color = PERIOD_COLOR[column.type]
        const data = columns[column.shortcut]
        const goals = data?.goals ?? []
        const done = goals.filter((g) => g.complete).length
        const window = goals[0]?.period
        const daysLeft = goals[0]?.daysLeft
        return (
          <View key={column.shortcut} style={[s.col, { borderTopColor: color }]} accessibilityLabel={column.title}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
              <T size={14} weight={600}>{column.title}</T>
              <View style={{ flex: 1 }} />
              <Btn compact onPress={() => onOpenPeriod(column.shortcut)}>
                <T size={12} muted>Open</T>
                <Hi icon={ArrowRightIcon} size={12} color={colors.muted} />
              </Btn>
            </View>
            <T size={11} muted>
              {!data ? 'Loading…' : data.error ? data.error : window
                ? `${window.label} · ${done} of ${goals.length} done${typeof daysLeft === 'number' && daysLeft >= 0 ? ` · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : ''}`
                : ' '}
            </T>
            <View style={s.thin}><View style={{ width: `${goals.length ? (done / goals.length) * 100 : 0}%`, height: '100%', backgroundColor: color }} /></View>
            {data && goals.length === 0 ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginVertical: 4 }}>
                <Hi icon={TrophyIcon} size={18} color={colors.muted} />
                <T size={12} muted>Nothing set</T>
              </View>
            ) : (
              <View style={{ gap: 9 }}>{goals.map((goal) => <GoalLine key={goal.id} goal={goal} color={color} />)}</View>
            )}
          </View>
        )
      })}
    </View>
  )
}

const s = StyleSheet.create({
  col: {
    backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, borderTopWidth: 2,
    borderRadius: 12, padding: 12, gap: 8,
  },
  thin: { height: 4, borderRadius: 999, backgroundColor: colors.bg3, overflow: 'hidden' },
})

