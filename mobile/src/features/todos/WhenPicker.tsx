// Fallback for the date/time picker where SwiftUI is not available (the web
// preview, Android): a typed field in the web input's own format. iOS uses
// WhenPicker.ios.tsx.
import React, { useEffect, useState } from 'react'
import { TextInput } from 'react-native'
import { colors, fonts } from '../../theme'
import { dateKey } from './format'

export interface WhenPickerProps {
  value: Date
  onChange: (value: Date) => void
  mode: 'date' | 'datetime' | 'time'
  variant?: 'compact' | 'graphical'
  /** The earliest selectable moment. */
  minimum?: Date
}

const pad = (n: number) => String(n).padStart(2, '0')

function format(value: Date, mode: WhenPickerProps['mode']) {
  const time = `${pad(value.getHours())}:${pad(value.getMinutes())}`
  return mode === 'date' ? dateKey(value) : mode === 'time' ? time : `${dateKey(value)} ${time}`
}

function parse(text: string, mode: WhenPickerProps['mode'], base: Date): Date | null {
  const m = /^(?:(\d{4})-(\d{2})-(\d{2}))?\s*(?:(\d{1,2}):(\d{2}))?$/.exec(text.trim())
  if (!m) return null
  const next = new Date(base)
  if (mode !== 'time') {
    if (!m[1]) return null
    next.setFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  }
  if (mode !== 'date') {
    if (!m[4]) return null
    next.setHours(Number(m[4]), Number(m[5]), 0, 0)
  }
  return Number.isNaN(next.getTime()) ? null : next
}

export default function WhenPicker({ value, onChange, mode }: WhenPickerProps) {
  const [text, setText] = useState(() => format(value, mode))
  useEffect(() => { setText(format(value, mode)) }, [value, mode])
  return (
    <TextInput
      value={text}
      onChangeText={(next) => { setText(next); const parsed = parse(next, mode, value); if (parsed) onChange(parsed) }}
      placeholder={mode === 'date' ? 'YYYY-MM-DD' : mode === 'time' ? 'HH:MM' : 'YYYY-MM-DD HH:MM'}
      placeholderTextColor={colors.muted}
      style={{ minWidth: 130, color: colors.text, fontFamily: fonts[400], fontSize: 15, paddingVertical: 4 }}
    />
  )
}
