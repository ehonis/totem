// Month (.month): six weeks of seven cells, three events per cell and "+N more".
import React, { useMemo } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { FAB_CLEARANCE } from '../../shell/Screen'
import EventChip from './EventChip'
import { addDays, isToday, parseDate, sameDay, startOfMonth, startOfWeek, type CalEvent } from './dates'

interface MonthGridProps {
  anchor: Date
  events: CalEvent[]
  onPickDay: (d: Date) => void
  onSelectEvent: (ev: CalEvent) => void
  refreshing: boolean
  onRefresh: () => void
}

export default function MonthGrid({ anchor, events, onPickDay, onSelectEvent, refreshing, onRefresh }: MonthGridProps) {
  const gridStart = startOfWeek(startOfMonth(anchor))
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
  const dows = Array.from({ length: 7 }, (_, i) => addDays(gridStart, i).toLocaleDateString([], { weekday: 'short' }).toUpperCase())
  const byDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>()
    for (const e of events) {
      const k = parseDate(e.start).toDateString()
      map.set(k, [...(map.get(k) || []), e])
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.allDay === b.allDay ? (a.start < b.start ? -1 : 1) : a.allDay ? -1 : 1))
    }
    return map
  }, [events])

  return (
    <View style={st.month}>
      <View style={st.dowRow}>
        {dows.map((d, i) => <View key={i} style={st.dow}><T size={11} muted align="right" style={{ letterSpacing: 0.5 }}>{d}</T></View>)}
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: FAB_CLEARANCE }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.muted} />}
      >
        {Array.from({ length: 6 }, (_, row) => (
          <View key={row} style={st.row}>
            {cells.slice(row * 7, row * 7 + 7).map((d, col) => {
              const dayEvents = byDay.get(d.toDateString()) || []
              const off = d.getMonth() !== anchor.getMonth()
              const today = isToday(d)
              const shown = dayEvents.slice(0, 3)
              return (
                // The whole cell opens its day (the web's 22px day number is too small a
                // target on a phone); a chip inside still opens its event.
                <Press
                  key={d.getTime()}
                  onPress={() => onPickDay(d)}
                  accessibilityLabel={d.toDateString()}
                  style={[st.cell, col === 0 && { borderLeftWidth: 0 }, off && { backgroundColor: colors.bg }]}
                >
                  <View style={[st.daynum, today && { backgroundColor: colors.accent }]}>
                    <T size={12} lineHeight={16} color={today ? colors.white : off ? colors.muted : colors.text} style={off && !today ? { opacity: 0.6 } : null}>
                      {d.getDate()}
                    </T>
                  </View>
                  <View style={{ gap: 2 }}>
                    {shown.map((ev) => <EventChip key={ev.id} ev={ev} compact onPress={() => onSelectEvent(ev)} />)}
                    {dayEvents.length > shown.length && (
                      <T size={11} muted numberOfLines={1} style={{ paddingHorizontal: 3 }}>+{dayEvents.length - shown.length} more</T>
                    )}
                  </View>
                </Press>
              )
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  )
}

const st = StyleSheet.create({
  month: { flex: 1, borderWidth: 1, borderColor: colors.line, borderRadius: 12, overflow: 'hidden' },
  dowRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.line },
  dow: { flex: 1, padding: 6 },
  row: { flex: 1, flexDirection: 'row', minHeight: 84 },
  cell: {
    flex: 1, minWidth: 0, padding: 3, gap: 2, overflow: 'hidden',
    borderLeftWidth: 1, borderLeftColor: colors.line, borderBottomWidth: 1, borderBottomColor: colors.line,
  },
  daynum: { alignSelf: 'flex-end', width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
})
