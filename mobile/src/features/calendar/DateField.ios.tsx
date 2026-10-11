// A start/end field on iOS: SwiftUI's compact DatePicker, the pill that opens the
// system calendar and time wheel. Replaces the web's <input type="date"> and
// <input type="datetime-local">.
import React from 'react'
import { Host, DatePicker } from '@expo/ui/swift-ui'
import { labelsHidden } from '@expo/ui/swift-ui/modifiers'
import { colors } from '../../theme'

export interface DateFieldProps {
  value: Date
  /** 'date' for all-day events, 'datetime' for timed ones. */
  mode: 'date' | 'datetime'
  onChange: (d: Date) => void
}

export default function DateField({ value, mode, onChange }: DateFieldProps) {
  return (
    <Host matchContents colorScheme="dark" seedColor={colors.accent} style={{ alignSelf: 'flex-start' }}>
      <DatePicker
        selection={value}
        displayedComponents={mode === 'date' ? ['date'] : ['date', 'hourAndMinute']}
        onDateChange={onChange}
        modifiers={[labelsHidden()]}
      />
    </Host>
  )
}
