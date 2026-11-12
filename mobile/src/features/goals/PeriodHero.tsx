// The head of a goal period (#180): a ring of goals achieved, the window with its
// ‹ › arrows (any week, month or year of this kind, so a finished one stays
// readable), how long is left, and refresh and + Goal. Replaces the old page's
// one muted "‹ Nov 2 – 8 › · 2 of 5 done" line.
import React from 'react'
import { StyleSheet, View } from 'react-native'
import { colors, alpha } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, IconBtn, Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { Hi, ArrowPathIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon, TrophySolidIcon } from '../../lib/icons'
import type { GoalPeriod } from '../../lib/goals/types'
import Ring from './Ring'
import type { PeriodSummary } from './summary'

export default function PeriodHero({ title, unit, window, anchored, summary, daysLeft, color, syncing, onStep, onReset, onRefresh, onAdd, empty }: {
  /** "This week", "Next month", … */
  title: string
  unit: string
  window: GoalPeriod | null
  /** Walked away from the tab's own window with the arrows. */
  anchored: boolean
  summary: PeriodSummary
  daysLeft: number | null
  color: string
  syncing: boolean
  onStep: (direction: -1 | 1) => void
  onReset: () => void
  onRefresh: () => void
  onAdd: () => void
  /** Nothing set: the body says so and offers "Add a goal", so this is just the window and its arrows. */
  empty?: boolean
}) {
  const { achieved, counted, notDoing, ratio, meanPercent } = summary
  const all = counted > 0 && achieved === counted
  const tint = all ? colors.green : color
  const facts = [
    daysLeft !== null && daysLeft >= 0 && !anchored ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : null,
    meanPercent !== null && counted > 0 && !all ? `${meanPercent}% of the way overall` : null,
    notDoing > 0 ? `${notDoing} not doing` : null,
  ].filter(Boolean)
  return (
    <View style={[st.card, { borderColor: alpha(tint, 0.3) }]}>
      {empty ? (
        <T size={12.5} weight={600} color={tint} numberOfLines={1}>
          {anchored ? window?.label ?? title : `${title}${window ? ` · ${window.label}` : ''}`}
        </T>
      ) : (
      <View style={st.top}>
        <Ring percent={counted ? ratio * 100 : 0} color={tint} track={alpha(tint, 0.16)} size={76} stroke={7}>
          {all
            ? <Hi icon={TrophySolidIcon} size={28} color={colors.amber} />
            : (
              <T size={20} weight={700} style={{ fontVariant: ['tabular-nums'] }}>
                {achieved}<T size={13} muted>/{counted}</T>
              </T>
            )}
        </Ring>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T size={12.5} weight={600} color={tint} numberOfLines={1}>
            {anchored ? window?.label ?? title : `${title}${window ? ` · ${window.label}` : ''}`}
          </T>
          <T size={18} weight={700} accessibilityLiveRegion="polite">
            {counted === 0 ? 'Nothing set yet' : all ? 'All achieved' : `${achieved} of ${counted} achieved`}
          </T>
          {facts.length > 0 && <T size={12.5} muted>{facts.join(' · ')}</T>}
        </View>
      </View>
      )}
      <View style={st.foot}>
        <IconBtn icon={ChevronLeftIcon} size={18} box={44} bordered label={`Previous ${unit}`} onPress={() => { tap(); onStep(-1) }} />
        <IconBtn icon={ChevronRightIcon} size={18} box={44} bordered label={`Next ${unit}`} onPress={() => { tap(); onStep(1) }} />
        <View style={{ flex: 1, minWidth: 0 }}>
          {anchored && (
            <Press onPress={() => { tap(); onReset() }} style={st.reset} accessibilityRole="button">
              <T size={13} weight={600} color={colors.accent} numberOfLines={1}>Back to {title.toLowerCase()}</T>
            </Press>
          )}
        </View>
        <IconBtn icon={ArrowPathIcon} size={17} box={44} bordered label="Refresh, syncing Strava first" disabled={syncing} onPress={onRefresh} />
        {!empty && <Btn kind="primary" icon={PlusIcon} title="Goal" onPress={onAdd} style={st.add} />}
      </View>
    </View>
  )
}

const st = StyleSheet.create({
  card: { backgroundColor: colors.bg2, borderWidth: 1, borderRadius: 16, padding: 14, gap: 14 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reset: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  add: { minHeight: 44, paddingHorizontal: 14 },
})
