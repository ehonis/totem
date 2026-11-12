// Productivity → Habits, a full page under its own top bar (#180). The Today panel
// (the day being answered, a bar that fills per habit, check-in and new), then one
// row per habit: tick today under the thumb, open the row for its history. The
// web's dialogs (new/edit habit, one day, a whole week or month, the morning
// check-in) are formSheet routes under app/habit/*, sharing the payload through
// features/habits/store.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated'
import { router } from 'expo-router'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press, Spinner } from '../../ui/kit'
import { success, tap } from '../../ui/haptics'
import { showMenu } from '../../ui/menu'
import { FAB_CLEARANCE } from '../../shell/Screen'
import { Hi, ArchiveBoxIcon, ArrowPathIcon, ChevronDownIcon, ExclamationCircleIcon, FireIcon, PlusIcon, SunIcon } from '../../lib/icons'
import { logHabit, updateHabit } from '../../lib/api'
import { pushToast } from '../../lib/toast'
import {
  APP_NAME, addDays, dayProgress, doneOn, isSyncedSleep, periodTotal, streakOf, withPending, type Habit,
} from '../habits/logic'
import { addPending, loadHabits, mutate, useHabits } from '../habits/store'
import HabitRow from '../habits/HabitRow'
import TodayPanel from '../habits/TodayPanel'
import { useCalm } from '../habits/motion'
import { openLinkedApp } from '../habits/LinkedApp'
import { habitContext } from '../../lib/chat/about/context'
import { chatAbout } from '../../ui/chatAbout'

// The check-in steps back as far as the loaded history (a year).
const MAX_DAYS_BACK = 365
// Which rows are open, per phone; a convenience, so a lost value just closes them.
const OPEN_KEY = 'totem.habits.open'

function readOpen(): string[] {
  try { const v = JSON.parse(globalThis.localStorage?.getItem(OPEN_KEY) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
function writeOpen(ids: string[]) {
  try { globalThis.localStorage?.setItem(OPEN_KEY, JSON.stringify(ids)) } catch { /* per-device nicety only */ }
}

export default function HabitsView({ active: shown }: { active: boolean }) {
  const { data, loading, error, pending } = useHabits()
  // How many days back the check-in is looking: 0 is today. The arrows step it.
  const [daysBack, setDaysBack] = useState(0)
  // Writes for one habit-day go one after another, so answers land in order.
  const chains = useRef<Record<string, Promise<void>>>({})
  const [busyKeys, setBusyKeys] = useState<Record<string, boolean>>({})
  // Read through a ref: the number box's submit and blur can both fire before a re-render.
  const busyRef = useRef(busyKeys)
  busyRef.current = busyKeys
  const calm = useCalm()
  const [open, setOpen] = useState<string[]>(readOpen)
  const [showArchived, setShowArchived] = useState(false)
  const [pulling, setPulling] = useState(false)

  // Load whenever the page comes on screen, so a habit ticked off elsewhere (the
  // Overview, an agent) is current without a pull.
  useEffect(() => { if (shown) void loadHabits() }, [shown])

  const habits = data?.habits || []
  const active = habits.filter((h) => !h.archived && !isSyncedSleep(h))
  const archived = habits.filter((h) => h.archived)
  const sleepHidden = habits.some((h) => !h.archived && isSyncedSleep(h))
  const today = data?.today || ''
  const checkinDate = today ? addDays(today, -daysBack) : ''
  const entries = useMemo(() => withPending(data?.entries || {}, pending), [data?.entries, pending])
  const progress = useMemo(() => dayProgress(active, entries, checkinDate), [active, entries, checkinDate])

  // One-tap logging, drawn before the bridge answers. A refusal takes the tap
  // back out and says why. A habit an app fills in never gets here.
  const logAt = (habit: Habit, date: string, delta: number, { offerUndo = true } = {}) => {
    if (habit.linkedApp) return
    const key = `${habit.id}:${date}`
    const before = entries[date]?.[habit.id]?.count || 0
    if (delta < 0 && before <= 0) return
    // Success when this tap finishes the day; the stepper's own buttons already tick.
    const multi = habit.cadence === 'daily' && habit.target > 1
    const goal = multi ? habit.target : 1
    if (delta > 0 && before < goal && before + delta >= goal) success()
    else if (!multi) tap()
    addPending(key, delta)
    const prior = chains.current[key] || Promise.resolve()
    const run = prior.then(async () => {
      try {
        await mutate(() => logHabit({ id: habit.id, date, delta }), { key, delta })
        // Unticking is the step that loses something, so it is the one with an undo.
        if (delta < 0 && offerUndo && before + delta <= 0) {
          pushToast(`Unticked ${habit.name}.`, 'info', {
            duration: 4000,
            action: { label: 'Undo', onClick: () => logAt(habit, date, -delta, { offerUndo: false }) },
          })
        }
      } catch (e: any) {
        pushToast(e.message)
      }
    })
    chains.current[key] = run
    void run.finally(() => { if (chains.current[key] === run) delete chains.current[key] })
  }

  const withBusy = async (habit: Habit, run: () => Promise<void>) => {
    const key = `${habit.id}:${checkinDate}`
    if (busyRef.current[key]) return
    busyRef.current = { ...busyRef.current, [key]: true }
    setBusyKeys((b) => ({ ...b, [key]: true }))
    try { await run() } catch (e: any) { pushToast(e.message) } finally { setBusyKeys((b) => ({ ...b, [key]: false })) }
  }

  // A number is evidence the habit happened, so it ticks the day off too; clearing
  // it leaves the check alone.
  const logValue = (habit: Habit, value: number | null) => habit.linkedApp ? undefined : withBusy(habit, async () => {
    const finishes = value !== null && !doneOn(habit, entries, checkinDate)
    await mutate(() => logHabit({ id: habit.id, date: checkinDate, value, complete: value !== null }))
    if (finishes) success()
  })

  const openDay = (habit: Habit, date: string) => router.push({ pathname: '/habit/day', params: { id: habit.id, date } })
  const openEdit = (habit: Habit) => router.push({ pathname: '/habit/edit', params: { id: habit.id } })
  const openPeriod = (habit: Habit, p: { start: string; end: string; title: string }) => (habit.linkedApp
    ? openLinkedApp(habit)
    : router.push({ pathname: '/habit/period', params: { id: habit.id, ...p } }))
  const chat = (habit: Habit) => data && chatAbout(() => habitContext(habit, data.entries, today, {
    streak: streakOf(habit, data.entries, today), periodCount: periodTotal(habit, data.entries, today),
  }))

  const toggleOpen = (habit: Habit) => {
    tap()
    setOpen((ids) => {
      const next = ids.includes(habit.id) ? ids.filter((id) => id !== habit.id) : [...ids, habit.id]
      writeOpen(next)
      return next
    })
  }

  const setArchived = (habit: Habit, value: boolean) => mutate(() => updateHabit(habit.id, { archived: value }))
    .then(() => {
      if (value) pushToast(`Archived ${habit.name}.`, 'info', { duration: 4000, action: { label: 'Undo', onClick: () => void setArchived(habit, false) } })
    })
    .catch((e) => pushToast(e.message))

  // Long-press on a row: everything else the row can do, as a native sheet.
  const rowMenu = (habit: Habit) => showMenu([
    { label: 'Edit habit', onPress: () => openEdit(habit) },
    habit.linkedApp
      ? { label: `Open ${APP_NAME[habit.linkedApp]}`, onPress: () => openLinkedApp(habit) }
      : { label: entries[checkinDate]?.[habit.id]?.note ? 'Edit note' : 'Add a note', onPress: () => openDay(habit, checkinDate) },
    { label: 'Chat about this', onPress: () => chat(habit) },
    { label: 'Archive', onPress: () => void setArchived(habit, true) },
  ], { title: habit.name })

  const refresh = async () => { setPulling(true); await loadHabits(); setPulling(false) }

  let body: React.ReactNode
  if (!data && loading) {
    body = <Spinner label="Loading habits…" />
  } else if (!data && error) {
    body = (
      <View style={s.state}>
        <Hi icon={ExclamationCircleIcon} size={30} color={colors.red} />
        <T size={16} weight={600} align="center">Habits didn’t load</T>
        <T size={13} muted align="center">{error}</T>
        <Btn icon={ArrowPathIcon} title="Try again" onPress={() => void loadHabits()} style={{ marginTop: 6 }} />
      </View>
    )
  } else if (!active.length) {
    body = (
      <View style={s.state}>
        <Hi icon={FireIcon} size={30} color={colors.amber} />
        <T size={16} weight={600} align="center">No habits yet</T>
        <T size={13} muted align="center">
          Add one here, or just tell Totem: “track a reading habit for me”.
          {sleepHidden && ' Sleep syncs from WHOOP on its own and shows in Bushido.'}
        </T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
          <Btn kind="primary" icon={PlusIcon} title="New habit" onPress={() => router.push('/habit/new')} />
          {/* The check-in is open to archived-only installs too: it says when there's nothing. */}
          <Btn icon={SunIcon} title="Check in" onPress={() => router.push('/habit/checkin')} />
        </View>
      </View>
    )
  } else {
    body = (
      <>
        <TodayPanel
          date={checkinDate}
          daysBack={daysBack}
          maxBack={MAX_DAYS_BACK}
          progress={progress}
          onStep={(d) => setDaysBack((n) => Math.min(Math.max(n + d, 0), MAX_DAYS_BACK))}
          onToday={() => setDaysBack(0)}
          onCheckin={() => router.push('/habit/checkin')}
          onNew={() => router.push('/habit/new')}
        />
        <View style={{ gap: 10 }}>
          {active.map((h) => (
            <HabitRow
              key={h.id}
              habit={h}
              entries={entries}
              date={checkinDate}
              today={today}
              expanded={open.includes(h.id)}
              busy={Boolean(busyKeys[`${h.id}:${checkinDate}`])}
              onToggle={toggleOpen}
              onLog={(habit, delta) => logAt(habit, checkinDate, delta)}
              onValue={logValue}
              onNote={(habit) => openDay(habit, checkinDate)}
              onEdit={openEdit}
              onMore={rowMenu}
              onChat={chat}
              onPickDay={(habit, date) => (habit.linkedApp ? openLinkedApp(habit) : openDay(habit, date))}
              onPickPeriod={openPeriod}
            />
          ))}
        </View>
        {sleepHidden && (
          <T size={13} muted style={{ marginTop: 14 }}>Sleep syncs from WHOOP on its own and shows in Bushido.</T>
        )}
      </>
    )
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: FAB_CLEARANCE }}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      refreshControl={<RefreshControl refreshing={pulling} tintColor={colors.muted} onRefresh={refresh} />}
    >
      {body}

      {archived.length > 0 && (
        <Animated.View layout={calm ? undefined : LinearTransition.duration(220)} style={{ marginTop: 22 }}>
          <Press
            onPress={() => { tap(); setShowArchived((v) => !v) }}
            accessibilityRole="button"
            accessibilityState={{ expanded: showArchived }}
            style={s.archivedHead}
          >
            <Hi icon={ArchiveBoxIcon} size={15} color={colors.muted} />
            <T size={14} weight={500} muted style={{ flex: 1 }}>Archived · {archived.length}</T>
            <View style={showArchived && { transform: [{ rotate: '180deg' }] }}>
              <Hi icon={ChevronDownIcon} size={14} color={colors.muted} />
            </View>
          </Press>
          {showArchived && (
            <Animated.View entering={calm ? undefined : FadeIn.duration(180)} style={s.archived}>
              {archived.map((h, i) => (
                <View key={h.id} style={[s.archivedRow, i > 0 && s.rule]}>
                  {/* Tapping the name opens the editor, where an archived habit can be deleted. */}
                  <Press onPress={() => openEdit(h)} accessibilityRole="button" accessibilityLabel={`${h.name}, edit habit`} style={s.archivedName}>
                    <View style={[s.dot, { backgroundColor: h.color }]} />
                    <T size={15} weight={500} muted numberOfLines={1} style={{ flex: 1 }}>{h.name}</T>
                  </Press>
                  <Btn
                    compact icon={ArrowPathIcon} title="Restore" style={{ minHeight: 44 }}
                    onPress={() => mutate(() => updateHabit(h.id, { archived: false }))
                      .then(() => pushToast(`Restored ${h.name}.`, 'success', { duration: 2500 }))
                      .catch((e) => pushToast(e.message))}
                  />
                </View>
              ))}
            </Animated.View>
          )}
        </Animated.View>
      )}
    </ScrollView>
  )
}

const s = StyleSheet.create({
  state: { alignItems: 'center', gap: 8, paddingVertical: 48, paddingHorizontal: 20 },
  archivedHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 4 },
  archived: { backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, borderRadius: 14, marginTop: 4 },
  archivedRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingLeft: 14, paddingRight: 10 },
  archivedName: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  rule: { borderTopWidth: 1, borderTopColor: colors.line },
  dot: { width: 10, height: 10, borderRadius: 3 },
})
