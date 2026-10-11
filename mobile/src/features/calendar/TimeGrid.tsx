// Day / Work Week / Week: the time grid (.tg). One vertical ScrollView; the hour
// lines are drawn once across the whole width rather than as a slot per day per
// hour, and every event block is absolutely positioned from its minutes, so a
// week is a few dozen views however busy it is.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { FAB_CLEARANCE } from '../../shell/Screen'
import EventChip from './EventChip'
import {
  HOUR_PX, acctColor, acctFill, fmtTime, isToday, minsOfDay, packDay, parseDate, sameDay, type CalEvent,
} from './dates'

const GUTTER = 56
const GRID_H = 24 * HOUR_PX
const HOURS = Array.from({ length: 24 }, (_, h) => h)
const HOUR_LABELS = HOURS.map((h) => (h === 0 ? '' : new Date(0, 0, 0, h).toLocaleTimeString([], { hour: 'numeric' })))

/** Where to open: just above now when today is on screen, else ~7am (as the web). */
export function defaultScrollY(days: Date[]) {
  if (!days.some(isToday)) return 7 * HOUR_PX
  return Math.max(0, (minsOfDay(new Date()) / 60 - 1.5) * HOUR_PX)
}

/** Re-render once a minute so the now line moves. */
function useMinute() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}

interface TimeGridProps {
  days: Date[]
  events: CalEvent[]
  /** Vertical offset to open at; kept across swipes so the hours don't jump. */
  initialY: number
  onScrollY: (y: number) => void
  onPickDay?: (d: Date) => void
  onSelectEvent: (ev: CalEvent) => void
  refreshing: boolean
  onRefresh: () => void
}

export default function TimeGrid({ days, events, initialY, onScrollY, onPickDay, onSelectEvent, refreshing, onRefresh }: TimeGridProps) {
  const scroller = useRef<ScrollView>(null)
  const now = useMinute()
  // Width of the day columns together: the screen less the view's padding, border and gutter.
  const gridW = useWindowDimensions().width - 32 - 2 - GUTTER

  // contentOffset covers iOS; the scrollTo covers the platforms that ignore it.
  useEffect(() => {
    const t = setTimeout(() => scroller.current?.scrollTo({ y: initialY, animated: false }), 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const allDayByDay = useMemo(
    () => days.map((d) => events.filter((e) => e.allDay && sameDay(parseDate(e.start), d))),
    [days, events],
  )
  const hasAllDay = allDayByDay.some((l) => l.length)
  const packed = useMemo(
    () => days.map((d) => packDay(events.filter((e) => !e.allDay && sameDay(parseDate(e.start), d)))),
    [days, events],
  )

  return (
    <View style={st.tg}>
      <View style={st.head}>
        <View style={{ width: GUTTER }} />
        {days.map((d) => {
          const today = isToday(d)
          return (
            <Press key={d.getTime()} style={st.dayH} onPress={() => onPickDay?.(d)} accessibilityLabel={d.toDateString()}>
              <T size={11} color={today ? colors.accent : colors.muted} style={st.dow}>
                {d.toLocaleDateString([], { weekday: 'short' }).toUpperCase()}
              </T>
              {today ? (
                <View style={st.todayNum}><T size={15} weight={600} color={colors.white} lineHeight={28}>{d.getDate()}</T></View>
              ) : (
                <T size={18} weight={600} lineHeight={28}>{d.getDate()}</T>
              )}
            </Press>
          )
        })}
      </View>

      {hasAllDay && (
        <ScrollView style={st.allday} nestedScrollEnabled showsVerticalScrollIndicator={false}>
          <View style={{ flexDirection: 'row' }}>
            <View style={[st.alldayGutter]}><T size={11} muted align="right">all day</T></View>
            {days.map((d, i) => (
              <View key={d.getTime()} style={st.alldayCol}>
                {allDayByDay[i].map((ev) => <EventChip key={ev.id} ev={ev} onPress={() => onSelectEvent(ev)} />)}
              </View>
            ))}
          </View>
        </ScrollView>
      )}

      <ScrollView
        ref={scroller}
        style={{ flex: 1 }}
        contentOffset={{ x: 0, y: initialY }}
        contentContainerStyle={{ paddingBottom: FAB_CLEARANCE }}
        scrollEventThrottle={64}
        onScroll={(e) => onScrollY(e.nativeEvent.contentOffset.y)}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.muted} />}
      >
        <View style={{ height: GRID_H, flexDirection: 'row' }}>
          {/* .tg-hour / .tg-slot bottom borders, as one line per hour across every column. */}
          {HOURS.map((h) => <View key={h} style={[st.hourLine, { top: (h + 1) * HOUR_PX - 1 }]} />)}

          <View style={{ width: GUTTER }}>
            {HOURS.map((h) => (h === 0 ? null : (
              <View key={h} style={[st.hourLabel, { top: h * HOUR_PX - 7 }]}>
                <T size={10} muted lineHeight={13}>{HOUR_LABELS[h]}</T>
              </View>
            )))}
          </View>

          {days.map((d, i) => (
            <View key={d.getTime()} style={st.dayCol}>
              {isToday(d) && (
                <View style={[st.now, { top: (minsOfDay(now) / 60) * HOUR_PX }]}>
                  <View style={st.nowDot} />
                </View>
              )}
              {packed[i].map(({ ev, s, e, col, cols }) => (
                <Press
                  key={ev.id}
                  onPress={() => onSelectEvent(ev)}
                  accessibilityRole="button"
                  accessibilityLabel={`${ev.title}, ${fmtTime(parseDate(ev.start))}`}
                  style={{
                    position: 'absolute',
                    top: (s / 60) * HOUR_PX,
                    height: Math.max(((e - s) / 60) * HOUR_PX - 2, 16),
                    left: `${(col / cols) * 100}%`,
                    width: `${100 / cols}%`,
                    paddingHorizontal: 2,
                    zIndex: 2,
                  }}
                >
                  <View style={[st.event, { backgroundColor: acctFill(ev), borderLeftColor: acctColor(ev) }]}>
                    <T size={11} weight={500} numberOfLines={1} lineHeight={14}>{ev.title}</T>
                    {/* In a narrow column the time goes word by word, each clipped, so it reads
                        "8:" like the web's overflow:hidden rather than breaking per character. */}
                    {(gridW / days.length / cols) - 14 >= 40
                      ? <T size={10} muted lineHeight={13}>{fmtTime(parseDate(ev.start))}</T>
                      : fmtTime(parseDate(ev.start)).split(/\s+/).map((w, k) => (
                        <T key={k} size={10} muted lineHeight={13} numberOfLines={1} ellipsizeMode="clip">{w}</T>
                      ))}
                  </View>
                </Press>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  )
}

const st = StyleSheet.create({
  tg: { flex: 1, borderWidth: 1, borderColor: colors.line, borderRadius: 12, overflow: 'hidden', backgroundColor: colors.bg2 },
  head: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.line },
  dayH: { flex: 1, alignItems: 'center', paddingVertical: 8, paddingHorizontal: 4, gap: 2, borderLeftWidth: 1, borderLeftColor: colors.line },
  dow: { letterSpacing: 0.5 },
  todayNum: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  allday: { maxHeight: 92, flexGrow: 0, borderBottomWidth: 1, borderBottomColor: colors.line },
  alldayGutter: { width: GUTTER, paddingVertical: 4, paddingHorizontal: 6 },
  alldayCol: { flex: 1, minWidth: 0, borderLeftWidth: 1, borderLeftColor: colors.line, padding: 3, gap: 2 },
  hourLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: colors.line },
  hourLabel: { position: 'absolute', right: 6, backgroundColor: colors.bg2, paddingHorizontal: 2 },
  dayCol: { flex: 1, minWidth: 0, borderLeftWidth: 1, borderLeftColor: colors.line },
  now: { position: 'absolute', left: 0, right: 0, height: 2, backgroundColor: colors.red, zIndex: 3 },
  nowDot: { position: 'absolute', left: -4, top: -3, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red },
  event: {
    flex: 1, borderRadius: 4, borderLeftWidth: 3, paddingVertical: 2, paddingHorizontal: 5, overflow: 'hidden',
  },
})
