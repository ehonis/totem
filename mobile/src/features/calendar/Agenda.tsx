// Agenda (.cal-agenda): two weeks as a list, grouped by day under Today / Tomorrow /
// weekday headings, each day one card of rows.
import React from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Card, Press } from '../../ui/kit'
import { FAB_CLEARANCE } from '../../shell/Screen'
import { acctColor, addDays, eventTimeLabel, parseDate, sameDay, type CalEvent } from './dates'

function dayHeading(d: Date) {
  const today = new Date()
  if (sameDay(d, today)) return 'Today'
  if (sameDay(d, addDays(today, 1))) return 'Tomorrow'
  return d.toLocaleDateString([], { weekday: 'long' })
}

interface AgendaProps {
  events: CalEvent[]
  onSelectEvent: (ev: CalEvent) => void
  refreshing: boolean
  onRefresh: () => void
}

export default function Agenda({ events, onSelectEvent, refreshing, onRefresh }: AgendaProps) {
  const days: Record<string, CalEvent[]> = {}
  for (const ev of events) (days[parseDate(ev.start).toDateString()] ||= []).push(ev)
  const keys = Object.keys(days).sort((a, b) => +new Date(a) - +new Date(b))
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: FAB_CLEARANCE }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.muted} />}
    >
      {!keys.length ? (
        <T muted align="center" style={{ paddingVertical: 40 }}>No events in this range.</T>
      ) : keys.map((k) => (
        <View key={k} style={{ marginBottom: 18 }}>
          <View style={st.dayH}>
            <T weight={600}>{dayHeading(new Date(k))}</T>
            <T size={12} muted>{new Date(k).toLocaleDateString([], { month: 'short', day: 'numeric' })}</T>
          </View>
          <Card>
            {days[k].map((ev, i) => (
              <Press
                key={ev.id}
                onPress={() => onSelectEvent(ev)}
                style={[st.event, i === days[k].length - 1 && { borderBottomWidth: 0 }]}
              >
                <View style={[st.bar, { backgroundColor: acctColor(ev) }]} />
                <T size={13} muted style={st.time}>{eventTimeLabel(ev)}</T>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T>{ev.title}</T>
                  {ev.location ? <T size={12} muted>{ev.location}</T> : null}
                </View>
              </Press>
            ))}
          </Card>
        </View>
      ))}
    </ScrollView>
  )
}

const st = StyleSheet.create({
  dayH: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 8 },
  event: { flexDirection: 'row', gap: 12, paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: colors.line },
  bar: { width: 3, borderRadius: 3 },
  time: { width: 88, fontVariant: ['tabular-nums'] },
})
