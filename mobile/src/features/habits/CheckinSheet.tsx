// The morning check-in, as WHOOP's daily journal does it: yesterday's habits (the
// night ones done late among them) and this morning's, each a Yes or a No. Opens
// on its own on the first open of the day (shell/morningCheckin.ts) or from the
// Habits app's "Check in". Answered rows stay put, shown answered, rather than
// vanishing under a thumb; the logic is lib/habitCheckin.ts, shared with the web.
import React, { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { colors, alpha } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Empty, Press, Spinner } from '../../ui/kit'
import { success, tap } from '../../ui/haptics'
import { Hi, CheckIcon, XMarkIcon } from '../../lib/icons'
import { logHabit } from '../../lib/api'
import { pushToast } from '../../lib/toast'
import { answered, checkinItems, type CheckinItem } from '../../lib/habitCheckin'
import { Sheet, closeSheet } from './form'
import { Stepper } from './CheckRow'
import { toDate, type Entry, type HabitsPayload } from './logic'
import { getHabitsData, loadHabits, mutate, useHabits } from './store'

const allAnswered = (payload: HabitsPayload | null) => {
  const { items } = checkinItems(payload, true)
  return items.length > 0 && items.every((i) => answered(payload?.entries, i.date, i.habit.id))
}

export default function CheckinSheet() {
  const { data, loading } = useHabits()
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const busyRef = useRef(busy)
  busyRef.current = busy

  // Opened from the Habits app the payload is fresh; opened cold, fetch it.
  useEffect(() => { if (!getHabitsData()) void loadHabits() }, [])

  const { yesterday, items } = checkinItems(data, true)
  const yesterdayItems = items.filter((i) => i.part === 'yesterday')
  const todayItems = items.filter((i) => i.part === 'today')

  const answer = async (item: CheckinItem, fields: { count?: number; delta?: number; skipped?: true }) => {
    const key = `${item.habit.id}:${item.date}`
    if (busyRef.current[key]) return
    tap()
    const wasDone = allAnswered(getHabitsData())
    setBusy((b) => ({ ...b, [key]: true }))
    try {
      await mutate(() => logHabit({ id: item.habit.id, date: item.date, ...fields }))
      if (!wasDone && allAnswered(getHabitsData())) success()
    } catch (e: any) {
      pushToast(e.message)
    } finally {
      setBusy((b) => ({ ...b, [key]: false }))
    }
  }

  const section = (title: string, list: CheckinItem[]) => list.length > 0 && (
    <View>
      <T size={12} weight={600} muted style={s.sectionHead}>{title}</T>
      <View style={s.card}>
        {list.map((item, i) => (
          <CheckinRow
            key={`${item.habit.id}:${item.date}`}
            item={item}
            entry={data?.entries[item.date]?.[item.habit.id]}
            busy={Boolean(busy[`${item.habit.id}:${item.date}`])}
            first={i === 0}
            onAnswer={(fields) => { void answer(item, fields) }}
          />
        ))}
      </View>
    </View>
  )

  const weekday = (iso: string) => toDate(iso).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
  return (
    <Sheet
      kicker="Habits"
      title="Morning check-in"
      footer={<Btn kind="primary" title="Done" onPress={closeSheet} />}
    >
      {loading && !data ? (
        <Spinner label="Loading…" />
      ) : !items.length ? (
        <Empty title="Nothing to check in." />
      ) : (
        <>
          {section(`Yesterday · ${weekday(yesterday)}`, yesterdayItems)}
          {section('This morning', todayItems)}
        </>
      )}
    </Sheet>
  )
}

function CheckinRow({ item, entry, busy, first, onAnswer }: {
  item: CheckinItem
  entry: Entry | undefined
  busy: boolean
  first: boolean
  onAnswer: (fields: { count?: number; delta?: number; skipped?: true }) => void
}) {
  const { habit } = item
  const count = entry?.count || 0
  const yes = count > 0
  const no = !yes && entry?.skipped === true
  const multi = habit.cadence === 'daily' && habit.target > 1
  return (
    <View style={[s.row, !first && s.rule]}>
      <View style={[s.dot, { backgroundColor: habit.color }]} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T size={15} weight={500} numberOfLines={1} color={yes || no ? colors.muted : colors.text}>{habit.name}</T>
        {item.part === 'yesterday' && habit.when === 'night' ? <T size={11.5} muted style={{ marginTop: 1 }}>last night</T> : null}
      </View>
      {multi ? (
        // Eight glasses of water is a count, not a yes: step it, and No still means none.
        <Stepper
          size={32} count={count} target={habit.target} color={habit.color} busy={busy}
          onStep={(delta) => onAnswer({ delta })}
          labelLess={`One less ${habit.name}`} labelMore={`One more ${habit.name}`}
        />
      ) : (
        <Answer label="Yes" icon={CheckIcon} on={yes} color={habit.color} busy={busy} a11y={`${habit.name}: yes`}
          onPress={() => { if (!yes) onAnswer({ count: Math.max(1, count) }) }} />
      )}
      <Answer label="No" icon={XMarkIcon} on={no} color={colors.muted} busy={busy} a11y={`${habit.name}: no`}
        onPress={() => { if (!no) onAnswer({ skipped: true }) }} />
    </View>
  )
}

function Answer({ label, icon, on, color, busy, a11y, onPress }: {
  label: string; icon: any; on: boolean; color: string; busy: boolean; a11y: string; onPress: () => void
}) {
  return (
    <Press
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={a11y}
      style={[s.answer, on && { backgroundColor: alpha(color, 0.22), borderColor: color }]}
    >
      {on ? <Hi icon={icon} size={14} color={label === 'Yes' ? color : colors.text} strokeWidth={2} /> : null}
      <T size={13} weight={on ? 600 : 500} color={on ? colors.text : colors.muted}>{label}</T>
    </Press>
  )
}

const s = StyleSheet.create({
  sectionHead: { textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, marginLeft: 2 },
  card: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line, borderRadius: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingLeft: 14, paddingRight: 10 },
  rule: { borderTopWidth: 1, borderTopColor: colors.line },
  dot: { width: 10, height: 10, borderRadius: 3 },
  answer: {
    flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 58, justifyContent: 'center',
    paddingVertical: 8, paddingHorizontal: 10, borderRadius: 9,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg3,
  },
})
