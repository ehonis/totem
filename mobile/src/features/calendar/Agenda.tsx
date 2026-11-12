// Agenda (.cal-agenda): two weeks as a list, and the view the phone opens on.
// Each day is a heading (Today, Tomorrow, then weekdays) over one card of rows:
// the time on the left in the event's account colour, the title and place on the
// right. Today and tomorrow always show, even when empty; today's finished events
// dim and a red line marks now; a day away carries its span's name as it does on
// the web. The foot steps to the next two weeks.
import React, { useEffect, useMemo, useState } from 'react'
import { AppState, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { alpha, colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press } from '../../ui/kit'
import { ChevronRightIcon } from '../../lib/icons'
import { FAB_CLEARANCE } from '../../shell/Screen'
import type { AwaySpan } from '../../lib/away'
import { acctColor, fmtTime, parseDate, type CalEvent } from './dates'
import { agendaDays, type AgendaEvent } from './agenda'

interface AgendaProps {
  range: [Date, Date]
  away: AwaySpan[]
  events: CalEvent[]
  onSelectEvent: (ev: CalEvent) => void
  refreshing: boolean
  onRefresh: () => void
  /** The next two weeks. */
  onMore?: () => void
}

/**
 * The time, moved on at each minute and when the app comes back to the front
 * (timers sleep in the background), so "Now" and the dimming keep up.
 */
function useMinute() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>
    const tick = () => {
      setNow(new Date())
      t = setTimeout(tick, 60_000 - (Date.now() % 60_000))
    }
    t = setTimeout(tick, 60_000 - (Date.now() % 60_000))
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') setNow(new Date()) })
    return () => { clearTimeout(t); sub.remove() }
  }, [])
  return now
}

export default function Agenda({ range, away, events, onSelectEvent, refreshing, onRefresh, onMore }: AgendaProps) {
  const now = useMinute()
  const days = useMemo(() => agendaDays(events, away, range, now), [events, away, range, now])
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: FAB_CLEARANCE }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.muted} />}
    >
      {!days.length ? (
        <T size={15} muted align="center" style={{ paddingVertical: 40 }}>Nothing scheduled in these two weeks.</T>
      ) : days.map((day) => (
        <View key={day.key} style={{ marginBottom: 18 }}>
          <View style={st.dayH} accessibilityRole="header">
            <T size={16} weight={600} color={day.today ? colors.accent : colors.text}>{day.heading}</T>
            <T size={13} muted>{day.date.toLocaleDateString([], { month: 'short', day: 'numeric' })}</T>
            {day.away ? (
              <View style={st.away}>
                <T size={12} weight={600} color={colors.away} numberOfLines={1}>Away · {day.away.label}</T>
              </View>
            ) : null}
          </View>
          {day.events.length ? (
            <View style={st.card}>
              {day.events.map((item, i) => (
                <React.Fragment key={item.ev.id}>
                  {day.nowAt === i ? <NowLine now={now} /> : null}
                  <EventRow item={item} last={i === day.events.length - 1 && day.nowAt !== day.events.length} onPress={() => onSelectEvent(item.ev)} />
                </React.Fragment>
              ))}
              {day.nowAt === day.events.length ? <NowLine now={now} /> : null}
            </View>
          ) : !day.away ? (
            <T size={14} muted style={st.free}>Nothing scheduled</T>
          ) : null}
        </View>
      ))}
      {onMore ? (
        <Btn title="Next two weeks" icon={ChevronRightIcon} onPress={onMore} style={{ alignSelf: 'center', minHeight: 44, marginTop: 4 }} />
      ) : null}
    </ScrollView>
  )
}

function EventRow({ item, last, onPress }: { item: AgendaEvent; last: boolean; onPress: () => void }) {
  const { ev, past, ongoing } = item
  const start = ev.allDay ? null : parseDate(ev.start)
  const end = ev.allDay || !ev.end ? null : parseDate(ev.end)
  const time = start ? fmtTime(start) : 'All day'
  return (
    <Press
      onPress={onPress}
      style={[st.event, !last && st.rule, past && { opacity: 0.5 }]}
      accessibilityRole="button"
      accessibilityLabel={`${ev.title}, ${start ? `${time}${end ? ` to ${fmtTime(end)}` : ''}` : 'all day'}${ev.location ? `, ${ev.location}` : ''}${ongoing && !ev.allDay ? ', happening now' : ''}`}
    >
      <View style={st.time}>
        <T size={14} weight={600} style={{ fontVariant: ['tabular-nums'] }}>{time}</T>
        {end ? <T size={12} muted style={{ fontVariant: ['tabular-nums'] }}>{fmtTime(end)}</T> : null}
      </View>
      <View style={[st.bar, { backgroundColor: acctColor(ev) }]} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T size={15} weight={500} numberOfLines={2}>{ev.title}</T>
        {ev.location ? <T size={13} muted numberOfLines={1}>{ev.location}</T> : null}
      </View>
      {ongoing && !ev.allDay ? (
        <View style={st.nowTag}><T size={11} weight={700} color={colors.red}>Now</T></View>
      ) : null}
    </Press>
  )
}

function NowLine({ now }: { now: Date }) {
  return (
    <View style={st.nowLine} accessible accessibilityLabel={`Now, ${fmtTime(now)}`}>
      <View style={st.nowDot} />
      <View style={{ flex: 1, height: 2, backgroundColor: colors.red }} />
    </View>
  )
}

const st = StyleSheet.create({
  dayH: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 8 },
  away: { marginLeft: 'auto', flexShrink: 1, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: alpha(colors.away, 0.16) },
  card: { backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, borderRadius: 12, overflow: 'hidden' },
  event: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 10, paddingHorizontal: 14 },
  rule: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  time: { width: 70 },
  bar: { width: 3, alignSelf: 'stretch', borderRadius: 3 },
  nowTag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: alpha(colors.red, 0.14) },
  nowLine: { flexDirection: 'row', alignItems: 'center', marginVertical: -1, zIndex: 2 },
  nowDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red, marginLeft: -2 },
  free: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.line, borderStyle: 'dashed' },
})
