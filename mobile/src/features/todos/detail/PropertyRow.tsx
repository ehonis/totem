// The task page's compact rows (status, priority, due, repeat, snooze, area): an
// icon, a name, the value, and a native menu behind the whole row. Grouped in one
// card like a Settings list, so six fields read as one block instead of six forms.
import React from 'react'
import { StyleSheet, View } from 'react-native'
import { MenuView, type MenuAction } from '@react-native-menu/menu'
import { colors, radius } from '../../../theme'
import { T } from '../../../ui/Text'
import { Hi, ChevronDownIcon, type IconType } from '../../../lib/icons'

export function PropertyGroup({ children }: { children: React.ReactNode }) {
  const rows = React.Children.toArray(children).filter(Boolean)
  return (
    <View style={st.group}>
      {rows.map((row, index) => (
        <View key={index}>
          {row}
          {index > 0 ? <View style={st.rule} pointerEvents="none" /> : null}
        </View>
      ))}
    </View>
  )
}

export function PropertyRow({ icon, iconStroke, label, value, valueColor, swatch, actions, onAction, menuTitle, disabled, hint }: {
  icon: IconType
  /** Tabler glyphs draw heavier than Heroicons at the same size; pass 1.6 to match. */
  iconStroke?: number
  label: string
  value: string
  valueColor?: string
  /** A small colour dot before the value (a venture's colour). */
  swatch?: string | null
  actions: MenuAction[]
  /** Picks its own haptic: a tick for a change, the success buzz for a completion. */
  onAction: (id: string) => void
  menuTitle?: string
  disabled?: boolean
  hint?: string
}) {
  const body = (
    <View
      style={[st.row, disabled && { opacity: 0.5 }]}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      accessibilityHint={hint ?? (disabled ? undefined : `Changes the ${label.toLowerCase()}`)}
      accessibilityState={{ disabled }}
    >
      <Hi icon={icon} size={18} color={colors.muted} strokeWidth={iconStroke} />
      <T size={15} style={st.label}>{label}</T>
      <View style={st.value}>
        {swatch ? <View style={[st.swatch, { backgroundColor: swatch }]} /> : null}
        <T size={15} numberOfLines={1} color={valueColor ?? colors.muted} style={{ flexShrink: 1 }}>{value}</T>
        {disabled ? null : <Hi icon={ChevronDownIcon} size={13} color={colors.muted} />}
      </View>
    </View>
  )
  if (disabled) return body
  return (
    <MenuView
      title={menuTitle}
      actions={actions}
      themeVariant="dark"
      onPressAction={({ nativeEvent }) => { if (nativeEvent.event) onAction(nativeEvent.event) }}
    >
      {body}
    </MenuView>
  )
}

const st = StyleSheet.create({
  group: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line, borderRadius: radius.lg, overflow: 'hidden' },
  // Inset past the icon, as iOS rules a grouped list.
  rule: { position: 'absolute', top: 0, left: 44, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingHorizontal: 14 },
  label: { width: 78 },
  value: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6, minWidth: 0 },
  swatch: { width: 8, height: 8, borderRadius: 4 },
})
