// Productivity → Habits, ported from web/src/components/HabitsView.tsx (origin/main):
// the nightly check-in card, then one history card per habit. The web's dialogs
// (new/edit habit, one day, a whole week or month) are formSheet routes under
// app/habit/*, sharing the payload through features/habits/store.
import React, { useEffect, useRef, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Card, IconBtn, Press, Spinner, ViewHead } from '../../ui/kit'
import { success } from '../../ui/haptics'
import { showMenu } from '../../ui/menu'
import { FAB_CLEARANCE } from '../../shell/Screen'
import { Hi, ArchiveBoxIcon, ArrowPathIcon, FireIcon, PencilSquareIcon, PlusIcon } from '../../lib/icons'
import { logHabit, updateHabit } from '../../lib/api'
import { pushToast } from '../../lib/toast'
import {
  addDays, dayLabel, isSyncedSleep, periodTotal, streakOf, totalFor, type Habit,
} from '../habits/logic'
import { loadHabits, mutate, useHabits } from '../habits/store'
import { CheckRow, QuotaDots, st as rowSt } from '../habits/CheckRow'
import HabitGrid from '../habits/HabitGrid'
import { HabitMetricSection } from '../habits/MetricChart'
import { SegSwitch } from '../habits/form'

export default function HabitsView({ active: shown }: { active: boolean }) {
  const { data, loading } = useHabits()
  const [checkinDay, setCheckinDay] = useState<'today' | 'yesterday'>('today')
  const [busyKeys, setBusyKeys] = useState<Record<string, boolean>>({})
  const [showArchived, setShowArchived] = useState(false)
  const [pulling, setPulling] = useState(false)
  const busyRef = useRef(busyKeys)
  busyRef.current = busyKeys

  // Load whenever the tab comes on screen, so a habit ticked off elsewhere (the
  // Overview, an agent) is current without a pull.
  useEffect(() => { if (shown) void loadHabits() }, [shown])

  const habits = data?.habits || []
  const active = habits.filter((h) => !h.archived && !isSyncedSleep(h))
  const archived = habits.filter((h) => h.archived)
  const sleepHidden = habits.some((h) => !h.archived && isSyncedSleep(h))
  const today = data?.today || ''
  const checkinDate = checkinDay === 'today' ? today : addDays(today, -1)

  const withBusy = async (habit: Habit, run: () => Promise<void>) => {
    const key = `${habit.id}:${checkinDate}`
    if (busyRef.current[key]) return
    setBusyKeys((b) => ({ ...b, [key]: true }))
    try { await run() } catch (e: any) { pushToast(e.message) } finally { setBusyKeys((b) => ({ ...b, [key]: false })) }
  }

  // One-tap logging; the bridge answers with the refreshed payload.
  const logDelta = (habit: Habit, delta: number) => withBusy(habit, async () => {
    if (delta > 0) success()
    await mutate(() => logHabit({ id: habit.id, date: checkinDate, delta }))
    if (delta < 0) pushToast(`Undid ${habit.name}.`, 'info', { duration: 2500 })
  })

  // A number is evidence the habit happened, so it ticks the day off too; clearing
  // it leaves the check alone.
  const logValue = (habit: Habit, value: number | null) => withBusy(habit, async () => {
    await mutate(() => logHabit({ id: habit.id, date: checkinDate, value, complete: value !== null }))
  })

  const openDay = (habit: Habit, date: string) => router.push({ pathname: '/habit/day', params: { id: habit.id, date } })
  const openEdit = (habit: Habit) => router.push({ pathname: '/habit/edit', params: { id: habit.id } })

  // Long-press on a check-in row: what the web reaches through the pencil and the
  // note button, plus archive, without scrolling down to the habit's card.
  const rowMenu = (habit: Habit) => showMenu([
    { label: 'Edit habit', onPress: () => openEdit(habit) },
    { label: data?.entries[checkinDate]?.[habit.id]?.note ? 'Edit note' : 'Add a note', onPress: () => openDay(habit, checkinDate) },
    {
      label: 'Archive',
      onPress: () => mutate(() => updateHabit(habit.id, { archived: true }))
        .then(() => pushToast(`Archived ${habit.name}.`, 'info', { duration: 2500 }))
        .catch((e) => pushToast(e.message)),
    },
  ], { title: habit.name })

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: FAB_CLEARANCE }}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      refreshControl={
        <RefreshControl
          refreshing={pulling}
          tintColor={colors.muted}
          onRefresh={async () => { setPulling(true); await loadHabits(); setPulling(false) }}
        />
      }
    >
      <ViewHead
        title="Habits"
        count={active.length || null}
        right={
          <>
            <IconBtn icon={ArrowPathIcon} size={15} box={34} bordered color={colors.text} label="Refresh" onPress={() => void loadHabits()} />
            <Btn compact kind="primary" icon={PlusIcon} title="New" onPress={() => router.push('/habit/new')} style={{ minHeight: 34 }} />
          </>
        }
      />

      {loading && !data ? (
        <Spinner label="Loading…" />
      ) : !active.length ? (
        <T muted align="center" style={{ paddingVertical: 40, paddingHorizontal: 10 }}>
          No habits yet. Add one here, or just tell Totem — “track a reading habit for me”.
          {sleepHidden && ' Sleep syncs from WHOOP on its own and shows in Bushido.'}
        </T>
      ) : (
        <>
          {/* Nightly check-in: go through the day in retrospect and tap off what happened. */}
          <Card style={[s.card, { paddingTop: 4, paddingBottom: 6 }]}>
            <View style={s.checkinHead}>
              <View style={{ flexShrink: 1 }}>
                <T size={14} weight={600}>Check-in</T>
                <T size={12} muted style={{ marginTop: 1 }}>{dayLabel(checkinDate)}</T>
              </View>
              <SegSwitch
                value={checkinDay}
                onChange={setCheckinDay}
                options={[{ value: 'yesterday', label: 'Yesterday' }, { value: 'today', label: 'Today' }]}
              />
            </View>
            {active.map((h, i) => (
              <CheckRow
                key={h.id}
                first={i === 0}
                habit={h}
                entry={data?.entries[checkinDate]?.[h.id]}
                periodCount={data ? periodTotal(h, data.entries, checkinDate) : 0}
                busy={Boolean(busyKeys[`${h.id}:${checkinDate}`])}
                onLog={logDelta}
                onValue={logValue}
                onNote={(habit) => openDay(habit, checkinDate)}
                onEdit={openEdit}
                onMore={rowMenu}
              />
            ))}
          </Card>

          {/* One contribution grid per habit. */}
          {data && active.map((h) => {
            const streak = streakOf(h, data.entries, today)
            return (
              <Card key={h.id} style={[s.card, s.habitCard]}>
                <View style={s.cardHead}>
                  <Press onPress={() => openEdit(h)} accessibilityLabel={`${h.name}, edit habit`} style={s.cardName}>
                    <View style={[rowSt.dot, { backgroundColor: h.color }]} />
                    <T size={14} weight={600} numberOfLines={1} style={{ flexShrink: 1 }}>{h.name}</T>
                  </Press>
                  <View style={s.cardStats}>
                    {streak > 1 && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                        <Hi icon={FireIcon} size={13} color={colors.amber} />
                        <T size={12} weight={600} color={colors.amber}>
                          {streak}{h.cadence === 'weekly' ? ' wk' : h.cadence === 'monthly' ? ' mo' : ''}
                        </T>
                      </View>
                    )}
                    {h.cadence !== 'daily' && <QuotaDots habit={h} count={periodTotal(h, data.entries, today)} />}
                    <T size={12} muted numberOfLines={1} style={{ flexShrink: 1 }}>{totalFor(h, data.entries)} in the last year</T>
                  </View>
                  <IconBtn
                    icon={PencilSquareIcon} size={16} box={32} color={colors.muted}
                    label={`Edit ${h.name}`}
                    onPress={() => openEdit(h)}
                  />
                </View>
                <HabitGrid
                  habit={h}
                  entries={data.entries}
                  today={today}
                  onPick={(date) => openDay(h, date)}
                  onPickPeriod={({ start, end, title }) => router.push({ pathname: '/habit/period', params: { id: h.id, start, end, title } })}
                />
                {h.metric && <HabitMetricSection habit={h} entries={data.entries} today={today} />}
              </Card>
            )
          })}
        </>
      )}

      {sleepHidden && active.length > 0 && (
        <T size={13} muted style={{ marginBottom: 14 }}>Sleep syncs from WHOOP on its own and shows in Bushido.</T>
      )}

      {archived.length > 0 && (
        <View style={{ marginTop: 4 }}>
          <Press onPress={() => setShowArchived((v) => !v)} style={{ marginBottom: 8, alignSelf: 'flex-start' }}>
            <T muted style={{ textDecorationLine: 'underline' }}>{showArchived ? 'Hide' : 'Show'} archived ({archived.length})</T>
          </Press>
          {showArchived && (
            <Card>
              {archived.map((h, i) => (
                <View key={h.id} style={[rowSt.row, { paddingVertical: 8 }, i > 0 && rowSt.rowRule]}>
                  {/* Tapping the name opens the editor, where an archived habit can be deleted. */}
                  <Press onPress={() => openEdit(h)} accessibilityLabel={`${h.name}, edit habit`} style={rowSt.main}>
                    <View style={[rowSt.dot, { backgroundColor: h.color }]} />
                    <T size={15} weight={500} muted numberOfLines={1} style={{ flex: 1 }}>{h.name}</T>
                  </Press>
                  <Btn
                    compact icon={ArchiveBoxIcon} title="Restore"
                    onPress={() => mutate(() => updateHabit(h.id, { archived: false })).catch((e) => pushToast(e.message))}
                  />
                </View>
              ))}
            </Card>
          )}
        </View>
      )}
    </ScrollView>
  )
}

const s = StyleSheet.create({
  card: { marginBottom: 14 },
  checkinHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
    paddingTop: 12, paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.line,
  },
  habitCard: { paddingTop: 12, paddingHorizontal: 14, paddingBottom: 14 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 8 },
  cardName: { flexDirection: 'row', alignItems: 'center', gap: 9, flexShrink: 1, minWidth: 0, maxWidth: '55%' },
  cardStats: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10, overflow: 'hidden' },
})
