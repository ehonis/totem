// Productivity → Calendar, ported from web/src/components/CalendarView.tsx.
//
// The same six views and the same range requests. What the phone does its own
// way: one toolbar row (the period, ‹ ›, Today, and the view as a native menu
// rather than a six-way strip), the agenda as the view it opens on until another
// is picked (remembered on this phone), swipe left/right to change period
// (SwipePeriods), pull to refresh, and the event opens as a native sheet
// (src/app/calendar/event.tsx). Ranges already fetched are kept, so swiping back
// is instant.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, AppState, StyleSheet, View } from 'react-native'
import { MenuView } from '@react-native-menu/menu'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, IconBtn } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, Hi, WarnIcon } from '../../lib/icons'
import { AuthError, getAway, getCalendarRange } from '../../lib/api'
import type { AwaySpan } from '../../lib/away'
import { clearSecretStored } from '../../lib/connection'
import { pushError } from '../../lib/toast'
import {
  VIEWS, fetchRange, gridDaysFor, parseDate, rangeTitle, stepAnchor, type CalEvent, type CalViewId,
} from '../calendar/dates'
import { compactTitle, parseView } from '../calendar/time'
import TimeGrid, { defaultScrollY } from '../calendar/TimeGrid'
import MonthGrid from '../calendar/MonthGrid'
import YearGrid from '../calendar/YearGrid'
import Agenda from '../calendar/Agenda'
import SwipePeriods from '../calendar/SwipePeriods'
import { onEventSaved, openEvent } from '../calendar/eventStore'

interface RangeData { events: CalEvent[]; errors: string[] }

const byStart = (a: CalEvent, b: CalEvent) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)

// The view last picked on this phone. Storage may be missing (a private web
// preview); the calendar then just opens on the agenda.
const VIEW_KEY = 'totem.calendar.view'
function storedView(): CalViewId {
  try { return parseView(localStorage.getItem(VIEW_KEY)) } catch { return parseView(null) }
}
function rememberView(view: CalViewId) {
  try { localStorage.setItem(VIEW_KEY, view) } catch { /* not kept; nothing else depends on it */ }
}

export default function CalendarView({ active }: { active: boolean }) {
  const [view, setView] = useState<CalViewId>(storedView)
  const [anchor, setAnchor] = useState(() => new Date())
  const [dir, setDir] = useState(0)
  const [data, setData] = useState<RangeData>({ events: [], errors: [] })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  // Trips and days off, past ones included (the views page back in time). Small, so
  // fetched whole alongside each load rather than per range.
  const [away, setAway] = useState<AwaySpan[]>([])
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
    getAway({ all: true }).then((r) => setAway(r.spans || [])).catch((e) => { if (e instanceof AuthError) void clearSecretStored() })
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
    if (nextView !== view) rememberView(nextView)
    setView(nextView)
    setAnchor(nextAnchor)
  }
  const pickDay = (d: Date) => jump('day', d)
  const pickMonth = (d: Date) => jump('month', d)

  const gridDays = useMemo(() => gridDaysFor(view, anchor), [view, anchor])
  const isGrid = view === 'day' || view === 'week' || view === 'workweek'
  const refresh = () => { void load(true) }
  const agendaRange = useMemo<[Date, Date]>(() => [rStart, rEnd], [rStart, rEnd])
  const viewLabel = VIEWS.find((v) => v.id === view)?.label ?? 'Agenda'

  return (
    <View style={st.view}>
      <View style={st.nav}>
        <T
          size={20}
          weight={700}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.7}
          style={{ flex: 1 }}
          accessibilityRole="header"
          accessibilityLabel={rangeTitle(view, anchor)}
        >
          {compactTitle(view, anchor)}
        </T>
        {loading && !refreshing ? <ActivityIndicator size="small" color={colors.muted} /> : null}
        <IconBtn icon={ChevronLeftIcon} size={18} box={40} label="Previous" onPress={() => step(-1)} />
        <IconBtn icon={ChevronRightIcon} size={18} box={40} label="Next" onPress={() => step(1)} />
        <Btn title="Today" onPress={() => jump(view, new Date())} style={st.today} />
        <MenuView
          title="View"
          themeVariant="dark"
          actions={VIEWS.map((v) => ({ id: v.id, title: v.label, state: v.id === view ? ('on' as const) : ('off' as const) }))}
          onPressAction={({ nativeEvent }) => { tap(); jump(nativeEvent.event as CalViewId, anchor) }}
        >
          <View style={st.viewBtn} accessibilityRole="button" accessibilityLabel={`View: ${viewLabel}`}>
            <T size={14} weight={500} numberOfLines={1}>{viewLabel}</T>
            <Hi icon={ChevronDownIcon} size={13} color={colors.muted} />
          </View>
        </MenuView>
      </View>

      {data.errors.map((e) => (
        <View key={e} style={st.warn}><WarnIcon /><T size={13} muted style={{ flex: 1 }}>{e}</T></View>
      ))}

      <SwipePeriods periodKey={`${view}|${rangeKey}`} dir={dir} onStep={step}>
        {isGrid && (
          <TimeGrid
            days={gridDays}
            away={away}
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
          <MonthGrid anchor={anchor} away={away} events={data.events} onPickDay={pickDay} onSelectEvent={openEvent} refreshing={refreshing} onRefresh={refresh} />
        )}
        {view === 'year' && (
          <YearGrid anchor={anchor} events={data.events} onPickDay={pickDay} onPickMonth={pickMonth} refreshing={refreshing} onRefresh={refresh} />
        )}
        {view === 'agenda' && (
          <Agenda
            range={agendaRange}
            away={away}
            events={[...data.events].sort((a, b) => +parseDate(a.start) - +parseDate(b.start))}
            onSelectEvent={openEvent}
            refreshing={refreshing}
            onRefresh={refresh}
            onMore={() => step(1)}
          />
        )}
      </SwipePeriods>
    </View>
  )
}

const st = StyleSheet.create({
  view: { flex: 1, paddingHorizontal: 16, paddingTop: 8 },
  nav: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: 12, minHeight: 44 },
  today: { minHeight: 44, paddingVertical: 6, paddingHorizontal: 12, marginLeft: 4 },
  viewBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44, paddingHorizontal: 11, marginLeft: 6,
    borderRadius: 9, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg2,
  },
  warn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
})
