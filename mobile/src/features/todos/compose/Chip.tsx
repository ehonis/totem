// The composer's chips: a pill that names a field until it is set, then shows its
// value in the accent. Behind each, a native menu. The pill is
// drawn 34pt tall inside a 44pt touch area.
import React from 'react'
import { StyleSheet, View } from 'react-native'
import { MenuView, type MenuAction } from '@react-native-menu/menu'
import { colors } from '../../../theme'
import { T } from '../../../ui/Text'
import { tap } from '../../../ui/haptics'
import { Hi, type IconType } from '../../../lib/icons'

interface ChipLook {
  icon: IconType
  iconStroke?: number
  text: string
  /** Set by the owner or by a hint: drawn in the accent. */
  on?: boolean
  /** Set by a typed hint rather than the menu. */
  fromText?: boolean
  color?: string
  a11y: string
}

function Pill({ icon, iconStroke, text, on, fromText, color }: ChipLook) {
  const fg = color ?? (on ? colors.text : colors.muted)
  return (
    <View style={[st.pill, on && st.pillOn, fromText && st.pillHint]}>
      <Hi icon={icon} size={15} color={on ? color ?? colors.accent : colors.muted} strokeWidth={iconStroke} />
      <T size={14} weight={on ? 600 : 500} color={fg} numberOfLines={1}>{text}</T>
    </View>
  )
}

export function MenuChip({ actions, onAction, title, ...look }: ChipLook & { actions: MenuAction[]; onAction: (id: string) => void; title?: string }) {
  return (
    <MenuView title={title} actions={actions} themeVariant="dark" onPressAction={({ nativeEvent }) => { if (nativeEvent.event) { tap(); onAction(nativeEvent.event) } }}>
      <View style={st.hit} accessibilityRole="button" accessibilityLabel={look.a11y}>
        <Pill {...look} />
      </View>
    </MenuView>
  )
}

const st = StyleSheet.create({
  hit: { height: 44, justifyContent: 'center' },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 12, borderRadius: 17,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg3,
  },
  pillOn: { borderColor: '#5b8cff66', backgroundColor: '#5b8cff1f' },
  // A dashed edge says "I read this from what you typed".
  pillHint: { borderStyle: 'dashed' },
})
