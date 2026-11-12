// Productivity → Goals, a full page under its own top bar (#180). The period
// switch (Overview, This week, Next week, This month, This year) as one row, then
// for a period its summary (a ring of goals achieved, the ‹ window › arrows,
// refresh with Strava first, + Goal), the open goals and the Achieved list.
// State lives in features/goals/store so the composer and editors (sheets here)
// act on the same list.
import React, { useEffect, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import Animated, { FadeIn, LinearTransition, ZoomIn } from 'react-native-reanimated'
import { router } from 'expo-router'
import { colors, alpha } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, IconBtn, Press, Spinner } from '../../ui/kit'
import { success } from '../../ui/haptics'
import { FAB_CLEARANCE } from '../../shell/Screen'
import { Hi, ArrowPathIcon, ExclamationCircleIcon, PlusIcon, Squares2X2Icon, TrophyIcon, XMarkIcon } from '../../lib/icons'
import {
  addGoalStep, deleteGoal, linkGoal, logGoalMetric, postponeGoal, setGoalComplete, unlinkGoal, updateGoal,
} from '../../lib/api'
import { pushToast } from '../../lib/toast'
import { PERIOD_LABELS, formatAmount } from '../../lib/goals/types'
import type { Goal, GoalMetric, GoalPeriodShortcut } from '../../lib/goals/types'
import GoalCard, { PERIOD_COLOR, type GoalCardActions } from '../goals/GoalCard'
import GoalsOverview from '../goals/GoalsOverview'
import PeriodHero from '../goals/PeriodHero'
import { periodSummary } from '../goals/summary'
import { apply, load, periodOf, pick, refresh, resetAnchor, setError, step, typeOf, useGoals } from '../goals/store'
import { useCalm } from '../habits/motion'

// No quarter: a tab that is always empty is a tab you learn to skip. Short names so
// all five fit across a phone; VoiceOver and the summary card use the full ones.
const PERIODS: GoalPeriodShortcut[] = ['this_week', 'next_week', 'this_month', 'this_year']
const SHORT: Record<string, string> = { overview: 'All', this_week: 'Week', next_week: 'Next wk', this_month: 'Month', this_year: 'Year' }

// Goals just achieved here, so their card lands under Achieved with a spring
// rather than the plain fade every other card gets.
const celebrating = new Set<string>()

const metricOf = (goal: Goal, id: string): GoalMetric | undefined =>
  goal.metrics.find((m) => m.id === id) ?? goal.subGoals.flatMap((sub) => sub.metrics).find((m) => m.id === id)

function actionsFor(goal: Goal, bushido: { url: string } | null): GoalCardActions {
  return {
    onToggle: () => {
      const was = goal.complete
      if (!was) celebrating.add(goal.id)
      void apply(() => setGoalComplete(goal.id, !was)).then((ok) => {
        if (!ok || was) { celebrating.delete(goal.id); return }
        setTimeout(() => celebrating.delete(goal.id), 1500)
        // The card moves to Achieved and mounts fresh there, so the buzz is given here.
        success()
        pushToast(`Achieved: ${goal.title}`, 'success', {
          duration: 4000,
          action: { label: 'Undo', onClick: () => { celebrating.delete(goal.id); void apply(() => setGoalComplete(goal.id, false)) } },
        })
      })
    },
    onToggleStep: (id, complete) => void apply(() => setGoalComplete(id, complete)),
    // A logged amount says what it added and can be taken back, since a typo in
    // the box is as easy as a good log. Undo reverses what the bridge actually
    // applied (it clamps at zero), not what was typed.
    onLog: (metricId, patch) => {
      const before = metricOf(goal, metricId)?.ownValue
      // Read the change off the goal this write answered with, not the list, which
      // may have moved to another period by the time it lands.
      let answered: Goal | undefined
      void apply(async () => {
        const result = await logGoalMetric(metricId, patch)
        answered = result.goal
        return result
      }).then((ok) => {
        if (!ok || !patch.delta) return
        const metric = answered ? metricOf(answered, metricId) : undefined
        // Only a decrease can be clamped (at zero). Comparing with the value on
        // screen would also count logs made elsewhere since it was drawn.
        const clamped = patch.delta < 0 && metric?.ownValue === 0 && before != null
        const applied = clamped ? Math.max(patch.delta, -before!) : patch.delta
        if (!applied) return
        success()
        pushToast(`${applied > 0 ? 'Logged' : 'Took off'} ${formatAmount(Math.abs(applied), metric?.unit ?? null)}${metric ? ` · ${metric.label}` : ''}`, 'success', {
          duration: 4000,
          action: { label: 'Undo', onClick: () => void apply(() => logGoalMetric(metricId, { delta: -applied })) },
        })
      })
    },
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
  const { open, done } = useMemo(() => ({
    open: goals.filter((g) => !g.complete),
    done: goals.filter((g) => g.complete),
  }), [goals])
  const summary = useMemo(() => periodSummary(goals), [goals])
  const calm = useCalm()

  const addGoal = () => router.push({ pathname: '/goal/new', params: { period } })

  const tabBtn = (value: 'overview' | GoalPeriodShortcut, label: string) => {
    const on = tab === value
    const tint = value === 'overview' ? colors.accent : PERIOD_COLOR[typeOf(value)]
    return (
      <Press
        key={value}
        haptic
        accessibilityRole="tab"
        accessibilityLabel={label}
        accessibilityState={{ selected: on }}
        onPress={() => pick(value)}
        style={[s.tab, on && { borderColor: alpha(tint, 0.6), backgroundColor: alpha(tint, 0.18) }]}
      >
        {value === 'overview'
          ? <Hi icon={Squares2X2Icon} size={14} color={on ? tint : colors.muted} />
          : <View style={[s.tabDot, { backgroundColor: tint }, !on && { opacity: 0.6 }]} />}
        <T size={13.5} weight={on ? 600 : 500} color={on ? colors.text : colors.muted} numberOfLines={1} maxFontSizeMultiplier={1.3} style={{ flexShrink: 1 }}>{SHORT[value]}</T>
      </Press>
    )
  }

  const hosts = bushido?.hosts ?? []
  const card = (goal: Goal) => (
    <Animated.View
      key={goal.id}
      layout={calm ? undefined : LinearTransition.duration(240)}
      entering={calm ? undefined : celebrating.has(goal.id) ? ZoomIn.springify().damping(13) : FadeIn.duration(180)}
    >
      <GoalCard goal={goal} busy={busy} bushidoHosts={hosts} actions={actionsFor(goal, bushido)} />
    </Animated.View>
  )

  const failedEmpty = Boolean(error) && !goals.length && !loading && showing

  let body: React.ReactNode
  if (!showing) {
    body = <GoalsOverview onOpenPeriod={pick} reloadKey={overviewKey} />
  } else if (loading && !goals.length) {
    body = <Spinner label="Loading goals…" />
  } else if (failedEmpty) {
    body = (
      <View style={s.state}>
        <Hi icon={ExclamationCircleIcon} size={30} color={colors.red} />
        <T size={16} weight={600} align="center">Goals didn’t load</T>
        <T size={13} muted align="center">{error}</T>
        <Btn icon={ArrowPathIcon} title="Try again" onPress={() => void load()} style={{ marginTop: 6 }} />
      </View>
    )
  } else if (goals.length === 0) {
    body = (
      <View style={s.state}>
        <Hi icon={TrophyIcon} size={30} color={alpha(PERIOD_COLOR[unit] ?? colors.muted, 0.8)} />
        <T size={16} weight={600} align="center">Nothing set for {anchor && window ? window.label : PERIOD_LABELS[period].toLowerCase()}</T>
        <T size={13} muted align="center">Name what you want to be true by the end of it. A number is optional.</T>
        <Btn kind="primary" icon={PlusIcon} title="Add a goal" onPress={addGoal} style={{ marginTop: 6, minHeight: 44 }} />
      </View>
    )
  } else {
    body = (
      <>
        <View style={{ gap: 12 }}>{open.map(card)}</View>
        {done.length > 0 && (
          <Animated.View layout={calm ? undefined : LinearTransition.duration(240)} style={{ marginTop: 10, gap: 12 }}>
            {/* "Achieved", not "Done": named after what it is worth. */}
            <View style={s.achievedHead}>
              <Hi icon={TrophyIcon} size={15} color="#91cf9b" />
              <T size={14} weight={600} color="#91cf9b">Achieved · {done.length}</T>
            </View>
            {done.map(card)}
          </Animated.View>
        )}
      </>
    )
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={s.tabsBand}>
        <View style={s.tabs} accessibilityRole="tablist" accessibilityLabel="Goal period">
          {tabBtn('overview', 'Overview')}
          {PERIODS.map((p) => tabBtn(p, PERIOD_LABELS[p]))}
        </View>
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingTop: 12, paddingBottom: FAB_CLEARANCE, gap: 14 }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        refreshControl={
          <RefreshControl refreshing={pulling} tintColor={colors.muted} onRefresh={async () => { setPulling(true); await refresh(); setPulling(false) }} />
        }
      >
        {/* Not while a period loads for the first time: "Nothing set yet" would be a guess. */}
        {showing && !failedEmpty && !(loading && !goals.length && !window) && (
          <PeriodHero
            title={PERIOD_LABELS[period]}
            unit={unit}
            window={window}
            anchored={Boolean(anchor)}
            summary={summary}
            daysLeft={goals[0]?.periodState === 'active' ? goals[0].daysLeft : null}
            color={PERIOD_COLOR[unit] ?? colors.accent}
            syncing={syncing}
            onStep={step}
            onReset={resetAnchor}
            onRefresh={() => void refresh()}
            onAdd={addGoal}
            empty={goals.length === 0}
          />
        )}
        {!showing && (
          <View style={s.overviewHead}>
            <T size={13} muted style={{ flex: 1 }}>Every horizon at once. Open one to log or tick.</T>
            <IconBtn icon={ArrowPathIcon} size={17} box={44} bordered label="Refresh, syncing Strava first" disabled={syncing} onPress={() => void refresh()} />
            <Btn kind="primary" icon={PlusIcon} title="Goal" onPress={addGoal} style={{ minHeight: 44, paddingHorizontal: 14 }} />
          </View>
        )}

        {error && !failedEmpty ? (
          <View style={s.banner} accessibilityLiveRegion="polite">
            <Hi icon={ExclamationCircleIcon} size={16} color={colors.red} />
            <T size={13} color={colors.red} style={{ flex: 1 }}>{error}</T>
            <IconBtn icon={XMarkIcon} size={16} box={36} color={colors.red} label="Dismiss" onPress={() => setError('')} />
          </View>
        ) : null}

        {body}
      </ScrollView>
    </View>
  )
}

const s = StyleSheet.create({
  tabsBand: { borderBottomWidth: 1, borderBottomColor: colors.line, paddingHorizontal: 12, paddingVertical: 8 },
  tabs: { flexDirection: 'row', gap: 4 },
  tab: {
    flexGrow: 1, flexShrink: 1, flexBasis: 'auto', minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, minHeight: 44,
    paddingHorizontal: 6, borderRadius: 999,
    backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line,
  },
  tabDot: { width: 8, height: 8, borderRadius: 4 },
  overviewHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  state: { alignItems: 'center', gap: 8, paddingVertical: 48, paddingHorizontal: 20 },
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 4, paddingVertical: 4,
    borderRadius: 10, borderWidth: 1, borderColor: alpha(colors.red, 0.35), backgroundColor: alpha(colors.red, 0.07),
  },
  achievedHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
})
