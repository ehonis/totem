// The platform's own date/time picker (SwiftUI DatePicker through @expo/ui), where
// the web had <input type="date|datetime-local|time">. `compact` is the inline
// field that pops a calendar; `graphical` is the full month grid for a sheet.
import React from 'react'
import { Host, DatePicker } from '@expo/ui/swift-ui'
import { datePickerStyle, labelsHidden, tint } from '@expo/ui/swift-ui/modifiers'
import { colors } from '../../theme'
import type { WhenPickerProps } from './WhenPicker'

export type { WhenPickerProps }

export default function WhenPicker({ value, onChange, mode, variant = 'compact', minimum }: WhenPickerProps) {
  const components = mode === 'date' ? ['date' as const] : mode === 'time' ? ['hourAndMinute' as const] : ['date' as const, 'hourAndMinute' as const]
  // The compact field sizes to its own capsule. The month grid takes the width it is
  // given and only reports its height: matching both axes let it pick its own width.
  return (
    <Host
      matchContents={variant === 'graphical' ? { vertical: true } : true}
      colorScheme="dark"
      style={variant === 'graphical' ? { alignSelf: 'stretch' } : undefined}
    >
      <DatePicker
        selection={value}
        displayedComponents={components}
        range={minimum ? { start: minimum } : undefined}
        onDateChange={onChange}
        modifiers={[datePickerStyle(variant), labelsHidden(), tint(colors.accent)]}
      />
    </Host>
  )
}
