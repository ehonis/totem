// One day's slice of an away span (.away-band in the web's styles.css): a band that
// rounds off at the span's own ends and names it where it starts, or where the
// visible row picks it up.
import React from 'react'
import { StyleSheet, View } from 'react-native'
import { alpha, colors } from '../../theme'
import { T } from '../../ui/Text'
import { dayKey, type AwaySpan } from '../../lib/away'

// `bleed` reaches through the cell's own padding so a span reads as one band.
export default function AwaySegment({ span, day, labelled, bleed = 0 }: { span: AwaySpan; day: Date; labelled: boolean; bleed?: number }) {
  const key = dayKey(day)
  const first = key === span.start
  const last = key === span.end
  return (
    <View
      accessibilityLabel={`Away: ${span.label}`}
      style={[
        st.band,
        first ? { marginLeft: 3 - bleed, borderTopLeftRadius: 9, borderBottomLeftRadius: 9 } : { marginLeft: -bleed },
        last ? { marginRight: 3 - bleed, borderTopRightRadius: 9, borderBottomRightRadius: 9 } : { marginRight: -bleed },
      ]}
    >
      <T size={11} weight={600} lineHeight={18} numberOfLines={1}>{labelled || first ? span.label : ' '}</T>
    </View>
  )
}

const st = StyleSheet.create({
  band: { height: 18, paddingHorizontal: 6, overflow: 'hidden', backgroundColor: alpha(colors.away, 0.3) },
})
