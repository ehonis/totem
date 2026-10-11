// Productivity → Goals, ported from web/src/components/GoalsView.tsx: the period
// strip (Overview, This week, Next week, This month, This year), the ‹ window › line,
// refresh (Strava first) and "+ Goal", then the open goals and the Achieved list.
// State lives in features/goals/store so the composer and editors — sheets here —
// act on the same list.
import React, { useEffect, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { colors, alpha } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press } from '../../ui/kit'
import { FAB_CLEARANCE } from '../../shell/Screen'
import { Hi, ArrowPathIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon, Squares2X2Icon, TrophyIcon } from '../../lib/icons'
import {
  addGoalStep, deleteGoal, linkGoal, logGoalMetric, postponeGoal, setGoalComplete, unlinkGoal, updateGoal,
} from '../../lib/api'
import { PERIOD_LABELS } from '../../lib/goals/types'
import type { Goal, GoalPeriodShortcut } from '../../lib/goals/types'
import GoalCard, { PERIOD_COLOR, type GoalCardActions } from '../goals/GoalCard'
import GoalsOverview from '../goals/GoalsOverview'
import { apply, load, periodOf, pick, refresh, resetAnchor, step, typeOf, useGoals } from '../goals/store'

// No quarter: a tab that is always empty is a tab you learn to skip.
const PERIODS: GoalPeriodShortcut[] = ['this_week', 'next_week', 'this_month', 'this_year']

function actionsFor(goal: Goal, bushido: { url: string } | null): GoalCardActions {
  return {
    onToggle: () => void apply(() => setGoalComplete(goal.id, !goal.complete)),
    onToggleStep: (id, complete) => void apply(() => setGoalComplete(id, complete)),
    onLog: (metricId, patch) => void apply(() => logGoalMetric(metricId, patch)),
    onPostpone: () => void apply(async () => { await postponeGoal(goal.id); return {} }),
    onDelete: () => void apply(async () => { await deleteGoal(goal.id); return {} }),
    onAbandon: (abandoned) => void apply(() => updateGoal(goal.id, { abandoned })),
    onAbandonStep: (id, abandoned) => void apply(() => updateGoal(id, { abandoned })),
    onRenameStep: (id, title) => void apply(() => updateGoal(id, { title })),
    onAddStep: (title) => void apply(() => addGoalStep(goal.id, { title })),
    onToggleBushido: bushido
      ? (current) => void apply(() => (current ? unlinkGoal(current.id) : linkGoal(goal.id, { kind: 'url', url: bushido.url, label: 'Bushido' })))
      : undefined,
  }
}

export default function GoalsView({ active }: { active: boolean }) {
  const state = useGoals()
  const { tab, anchor, window, goals, loading, busy, syncing, error, bushido, overviewKey } = state
  const [pulling, setPulling] = useState(false)
  const period = periodOf(state)
  const showing = tab !== 'overview'
  const unit = typeOf(period)

  useEffect(() => { if (active) void load() }, [active])

  // Stopped goals stay where they are, crossed off; only finished ones move down.
  const { open, done, stopped } = useMemo(() => ({
    open: goals.filter((g) => !g.complete),
    done: goals.filter((g) => g.complete),
    stopped: goals.filter((g) => g.abandoned && !g.complete),
  }), [goals])

  const tabBtn = (value: 'overview' | GoalPeriodShortcut, label: string) => {
    const on = tab === value
    const tint = value === 'overview' ? colors.accent : PERIOD_COLOR[typeOf(value)]
    return (
      <Press
        key={value}
        haptic
        accessibilityRole="tab"
        accessibilityState={{ selected: on }}
        onPress={() => pick(value)}
        style={[s.tab, on && { borderColor: alpha(tint, 0.55), backgroundColor: alpha(tint, 0.16) }]}
      >
        {value === 'overview' && <Hi icon={Squares2X2Icon} size={13} color={on ? tint : colors.text} />}
        <T size={12} color={on ? tint : colors.text}>{label}</T>
      </Press>
    )
  }

  const hosts = bushido?.hosts ?? []
  const card = (goal: Goal) => (
    <GoalCard key={goal.id} goal={goal} busy={busy} bushidoHosts={hosts} actions={actionsFor(goal, bushido)} />
  )

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: FAB_CLEARANCE, gap: 14 }}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      refreshControl={
        <RefreshControl refreshing={pulling} tintColor={colors.muted} onRefresh={async () => { setPulling(true); await refresh(); setPulling(false) }} />
      }
    >
      <View style={s.head}>
        <View style={s.periods} accessibilityRole="tablist" accessibilityLabel="Goal period">
          {tabBtn('overview', 'Overview')}
          {PERIODS.map((p) => tabBtn(p, PERIOD_LABELS[p]))}
        </View>
        <View style={s.headActions}>
          <Btn compact onPress={() => void refresh()} disabled={syncing} style={{ minHeight: 32, paddingHorizontal: 10 }}>
            <Hi icon={ArrowPathIcon} size={14} color={colors.text} />
          </Btn>
          <Btn compact kind="primary" icon={PlusIcon} title="Goal" onPress={() => router.push({ pathname: '/goal/new', params: { period } })} />
        </View>
      </View>

      {window && showing && (
        <View style={s.window}>
          {/* The arrows walk to any period of this type, so a finished week stays readable. */}
          <Press haptic onPress={() => step(-1)} hitSlop={10} accessibilityLabel={`Previous ${unit}`} style={{ opacity: 0.65 }}>
            <Hi icon={ChevronLeftIcon} size={13} color={colors.muted} />
          </Press>
          <T size={12} weight={anchor ? 600 : 400} muted>{window.label}</T>
          <Press haptic onPress={() => step(1)} hitSlop={10} accessibilityLabel={`Next ${unit}`} style={{ opacity: 0.65 }}>
            <Hi icon={ChevronRightIcon} size={13} color={colors.muted} />
          </Press>
          {anchor && (
            <Press onPress={resetAnchor}>
              <T size={12} muted style={{ textDecorationLine: 'underline' }}>Back to {PERIOD_LABELS[period].toLowerCase()}</T>
            </Press>
          )}
          {goals.length > 0 && <T size={12} muted>· {done.length} of {goals.length} done</T>}
          {stopped.length > 0 && <T size={12} muted>· {stopped.length} not doing</T>}
        </View>
      )}

      {error ? <T size={13} color={colors.red}>{error}</T> : null}

      {!showing ? (
        <GoalsOverview onOpenPeriod={pick} reloadKey={overviewKey} />
      ) : loading && !goals.length ? (
        <T muted align="center" style={{ paddingVertical: 40 }}>Loading…</T>
      ) : goals.length === 0 ? (
        <View style={s.empty}>
          <Hi icon={TrophyIcon} size={26} color={alpha(colors.muted, 0.5)} />
          <T size={15} muted align="center">Nothing set for {anchor && window ? window.label : PERIOD_LABELS[period].toLowerCase()}.</T>
        </View>
      ) : (
        <>
          <View style={{ gap: 12 }}>{open.map(card)}</View>
          {done.length > 0 && (
            <View style={{ marginTop: 10 }}>
              {/* "Achieved", not "Done": named after what it is worth. */}
              <View style={s.achievedHead}>
                <Hi icon={TrophyIcon} size={13} color="#91cf9b" />
                <T size={12} weight={600} color="#91cf9b">Achieved</T>
              </View>
              <View style={{ gap: 12 }}>{done.map(card)}</View>
            </View>
          )}
        </>
      )}
    </ScrollView>
  )
}

const s = StyleSheet.create({
  head: { gap: 10 },
  periods: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tab: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32,
    paddingVertical: 6, paddingHorizontal: 9, borderRadius: 8,
    backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line,
  },
  headActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 6 },
  window: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: -6 },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 40 },
  achievedHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
})
