// .cal-chip: an event in a month cell or the all-day row. Account-tinted fill with
// a 3px bar of the account colour on the left.
//
// `compact` (the month grid) drops the start time: a phone's month cell is about
// 48pt wide, and the web's "8:00 AM Work" there reads "8:0…" on every chip. The
// title is what tells days apart, as in iOS Calendar's month view.
import React from 'react'
import { StyleSheet } from 'react-native'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { acctColor, acctFill, fmtTime, parseDate, type CalEvent } from './dates'

export default function EventChip({ ev, onPress, compact }: { ev: CalEvent; onPress: () => void; compact?: boolean }) {
  const time = ev.allDay ? '' : fmtTime(parseDate(ev.start))
  return (
    <Press
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={time ? `${ev.title}, ${time}` : ev.title}
      style={[st.chip, compact && st.compact, { backgroundColor: acctFill(ev), borderLeftColor: acctColor(ev) }]}
    >
      <T size={compact ? 11 : 12} weight={ev.allDay ? 500 : 400} numberOfLines={1} ellipsizeMode={compact ? 'clip' : 'tail'} lineHeight={compact ? 14 : 16}>
        {time && !compact ? <T size={11} color={colors.muted} style={{ fontVariant: ['tabular-nums'] }}>{`${time} `}</T> : null}
        {ev.title}
      </T>
    </Press>
  )
}

const st = StyleSheet.create({
  chip: { borderRadius: 4, borderLeftWidth: 3, paddingVertical: 1, paddingHorizontal: 5, overflow: 'hidden' },
  compact: { paddingHorizontal: 3 },
})
