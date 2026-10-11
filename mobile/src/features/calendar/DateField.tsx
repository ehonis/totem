// A start/end field off iOS (the web preview, Android): a typed "YYYY-MM-DD" or
// "YYYY-MM-DD HH:mm", committed on blur. iOS uses DateField.ios.tsx.
import React, { useEffect, useState } from 'react'
import { TextInput } from 'react-native'
import { colors, fonts } from '../../theme'
import { fromInput, toDateInput, toDateTimeInput } from './dates'

export interface DateFieldProps {
  value: Date
  mode: 'date' | 'datetime'
  onChange: (d: Date) => void
}

const show = (d: Date, mode: DateFieldProps['mode']) => (mode === 'date' ? toDateInput(d) : toDateTimeInput(d).replace('T', ' '))

export default function DateField({ value, mode, onChange }: DateFieldProps) {
  const [text, setText] = useState(() => show(value, mode))
  useEffect(() => { setText(show(value, mode)) }, [value, mode])
  return (
    <TextInput
      value={text}
      onChangeText={setText}
      onBlur={() => {
        const d = fromInput(text.trim().replace(' ', 'T'))
        if (Number.isNaN(d.getTime())) setText(show(value, mode))
        else onChange(d)
      }}
      placeholder={mode === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:mm'}
      placeholderTextColor={colors.muted}
      keyboardAppearance="dark"
      style={{
        backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line, borderRadius: 8,
        color: colors.text, paddingVertical: 11, paddingHorizontal: 12, minHeight: 44, fontSize: 16, fontFamily: fonts[400],
      }}
    />
  )
}
