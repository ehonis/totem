// Productivity → Calendar, ported from web/src/components/CalendarView.tsx.
//
// Same toolbar (Today ‹ › title), the same six views and the same range requests.
// What the phone adds: swipe left/right to change period (SwipePeriods), pull to
// refresh, and the event opens as a native sheet (src/app/calendar/event.tsx)
// rather than a dialog. Ranges already fetched are kept, so swiping back is instant.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, StyleSheet, View } from 'react-native'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { WarnIcon } from '../../lib/icons'
import { AuthError, getCalendarRange } from '../../lib/api'
import { clearSecretStored } from '../../lib/connection'
import { pushError } from '../../lib/toast'
import {
  VIEWS, fetchRange, gridDaysFor, parseDate, rangeTitle, stepAnchor, type CalEvent, type CalViewId,
} from '../calendar/dates'
import TimeGrid, { defaultScrollY } from '../calendar/TimeGrid'
import MonthGrid from '../calendar/MonthGrid'
import YearGrid from '../calendar/YearGrid'
import Agenda from '../calendar/Agenda'
import SwipePeriods from '../calendar/SwipePeriods'
import { onEventSaved, openEvent } from '../calendar/eventStore'

interface RangeData { events: CalEvent[]; errors: string[] }

const byStart = (a: CalEvent, b: CalEvent) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)

export default function CalendarView({ active }: { active: boolean }) {
  const [view, setView] = useState<CalViewId>('week')
  const [anchor, setAnchor] = useState(() => new Date())
  const [dir, setDir] = useState(0)
  const [data, setData] = useState<RangeData>({ events: [], errors: [] })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const cache = useRef(new Map<string, RangeData>())
  // The time grid's vertical offset, carried across swipes; null = open at "now".
  const scrollY = useRef<number | null>(null)

  const [rStart, rEnd] = useMemo(() => fetchRange(view, anchor), [view, anchor])
  const rangeKey = `${rStart.toISOString()}|${rEnd.toISOString()}`
  const currentKey = useRef(rangeKey)
  currentKey.current = rangeKey

  const load = useCallback(async (manual = false) => {
    const key = `${rStart.toISOString()}|${rEnd.toISOString()}`
    const cached = cache.current.get(key)
    if (cached && !manual) setData(cached)
    else if (!cached) setData({ events: [], errors: [] })
    setLoading(true)
    if (manual) setRefreshing(true)
    try {
      const { events, errors } = await getCalendarRange(rStart.toISOString(), rEnd.toISOString())
      const next = { events: events || [], errors: errors || [] }
      cache.current.set(key, next)
      if (currentKey.current === key) setData(next)
    } catch (e: any) {
      if (e instanceof AuthError) { void clearSecretStored(); return }
      if (currentKey.current === key) pushError(e?.message || 'The calendar could not load.')
    } finally {
      if (currentKey.current === key) { setLoading(false); setRefreshing(false) }
    }
  }, [rStart, rEnd])

  useEffect(() => { void load() }, [load])

  // Back on screen (paged to, or the app foregrounded): the calendar may have moved.
  const wasActive = useRef(active)
  useEffect(() => {
    if (active && !wasActive.current) void load()
    wasActive.current = active
  }, [active, load])
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active' && active) void load() })
    return () => sub.remove()
  }, [active, load])

  // A save in the event sheet comes back here.
  useEffect(() => onEventSaved((saved) => {
    const patch = (d: RangeData) => ({ ...d, events: d.events.map((ev) => (ev.id === saved.id ? saved : ev)).sort(byStart) })
    setData(patch)
    for (const [k, d] of cache.current) cache.current.set(k, patch(d))
  }), [])

  const step = (d: -1 | 1) => {
    tap()
    setDir(d)
    setAnchor((a) => stepAnchor(view, a, d))
  }
  const jump = (nextView: CalViewId, nextAnchor: Date) => {
    scrollY.current = null
    setDir(0)
    setView(nextView)
    setAnchor(nextAnchor)
  }
  const pickDay = (d: Date) => jump('day', d)
  const pickMonth = (d: Date) => jump('month', d)

  const gridDays = useMemo(() => gridDaysFor(view, anchor), [view, anchor])
  const isGrid = view === 'day' || view === 'week' || view === 'workweek'
  const refresh = () => { void load(true) }

  return (
    <View style={st.view}>
      <View style={st.nav}>
        <Btn title="Today" onPress={() => jump(view, new Date())} />
        <Btn compact onPress={() => step(-1)} style={st.arrow}><T size={16} lineHeight={18} accessibilityLabel="Previous">‹</T></Btn>
        <Btn compact onPress={() => step(1)} style={st.arrow}><T size={16} lineHeight={18} accessibilityLabel="Next">›</T></Btn>
        <T size={18} weight={700} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} style={{ flexShrink: 1 }}>
          {rangeTitle(view, anchor)}
        </T>
        {loading ? <T size={24} lineHeight={20} muted>·</T> : null}
      </View>

      <View style={st.switch}>
        {VIEWS.map((v) => {
          const on = view === v.id
          return (
            <Press key={v.id} haptic onPress={() => jump(v.id, anchor)} style={[st.seg, on && { backgroundColor: colors.bg3 }]}>
              <T size={13} numberOfLines={1} color={on ? colors.text : colors.muted}>{v.label}</T>
            </Press>
          )
        })}
      </View>

      {data.errors.map((e) => (
        <View key={e} style={st.warn}><WarnIcon /><T size={13} muted style={{ flex: 1 }}>{e}</T></View>
      ))}

      <SwipePeriods periodKey={`${view}|${rangeKey}`} dir={dir} onStep={step}>
        {isGrid && (
          <TimeGrid
            days={gridDays}
            events={data.events}
            initialY={scrollY.current ?? defaultScrollY(gridDays)}
            onScrollY={(y) => { scrollY.current = y }}
            onPickDay={pickDay}
            onSelectEvent={openEvent}
            refreshing={refreshing}
            onRefresh={refresh}
          />
        )}
        {view === 'month' && (
          <MonthGrid anchor={anchor} events={data.events} onPickDay={pickDay} onSelectEvent={openEvent} refreshing={refreshing} onRefresh={refresh} />
        )}
        {view === 'year' && (
          <YearGrid anchor={anchor} events={data.events} onPickDay={pickDay} onPickMonth={pickMonth} refreshing={refreshing} onRefresh={refresh} />
        )}
        {view === 'agenda' && (
          <Agenda
            events={[...data.events].sort((a, b) => +parseDate(a.start) - +parseDate(b.start))}
            onSelectEvent={openEvent}
            refreshing={refreshing}
            onRefresh={refresh}
          />
        )}
      </SwipePeriods>
    </View>
  )
}

const st = StyleSheet.create({
  view: { flex: 1, paddingHorizontal: 16, paddingTop: 16 },
  nav: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  arrow: { minWidth: 32, paddingHorizontal: 10 },
  switch: {
    flexDirection: 'row', backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line,
    borderRadius: 9, padding: 2, marginBottom: 18,
  },
  seg: { flexGrow: 1, alignItems: 'center', paddingVertical: 6, paddingHorizontal: 6, borderRadius: 7 },
  warn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6, marginTop: -10 },
})
