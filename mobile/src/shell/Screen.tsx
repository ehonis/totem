// Every screen but the chat: ChatGPT's top bar (☰, the screen's name, new chat),
// the content, and in the bottom-right corner the voice + new-chat pair
// (shell.css .sh-mbar / .sh-fab). Mirrors Shell.tsx's MobileBar and NewChatFab.
import React from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useNavigation } from 'expo-router'
import { colors, textAlpha } from '../theme'
import { T } from '../ui/Text'
import { IconBtn, Press } from '../ui/kit'
import { Hi } from '../lib/icons'
import { IconEdit, IconMenu, IconWaveSine } from '../lib/chat/icons'
import { newChat, openDrawer, startVoice } from './nav'
import { PageGlow, type GlowPage } from '../ui/PageGlow'
import { impact } from '../ui/haptics'

export function MobileBar({ title, right }: { title: string; right?: React.ReactNode }) {
  const navigation = useNavigation()
  return (
    <View style={st.bar}>
      <IconBtn icon={IconMenu} size={22} label="Menu" onPress={() => openDrawer(navigation)} />
      <T size={17} weight={600} align="center" numberOfLines={1} style={{ flex: 1 }}>{title}</T>
      {right ?? <IconBtn icon={IconEdit} size={21} label="New chat" onPress={newChat} />}
    </View>
  )
}

const FAB_SIZE = 54
const FAB_GAP = 14

/**
 * The voice + new-chat buttons, stacked in the bottom-right corner: one size, so
 * they read as a pair; the voice one keeps its darker fill.
 */
export function NewChatFab({ bottomOffset = 0 }: { bottomOffset?: number }) {
  const insets = useSafeAreaInsets()
  const base = Math.max(insets.bottom, 14) + 8 + bottomOffset
  return (
    <>
      <Press
        accessibilityLabel="Talk to Totem"
        onPress={() => { impact(); startVoice() }}
        style={[st.fab, st.fabVoice, { bottom: base + FAB_SIZE + FAB_GAP }]}
      >
        <Hi icon={IconWaveSine} size={22} strokeWidth={2} color={colors.text} />
      </Press>
      <Press
        accessibilityLabel="New chat"
        onPress={() => { impact(); newChat() }}
        style={[st.fab, { bottom: base }]}
      >
        <Hi icon={IconEdit} size={22} strokeWidth={2} color="#0f1115" />
      </Press>
    </>
  )
}

/**
 * A drawer screen's frame. The content scrolls itself (a ScrollView or FlatList),
 * and should pad its foot by FAB_CLEARANCE so the last row clears the buttons.
 */
export function Screen({ title, children, fab = true, barRight, glow, style }: {
  title: string
  /** Draw the page over its colour glow (PageGlow). */
  glow?: GlowPage
  children: React.ReactNode
  fab?: boolean
  barRight?: React.ReactNode
  style?: StyleProp<ViewStyle>
}) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[st.screen, { paddingTop: insets.top }, style]}>
      <MobileBar title={title} right={barRight} />
      <View style={{ flex: 1 }}>
        {glow ? <PageGlow page={glow} /> : null}
        {children}
      </View>
      {fab ? <NewChatFab /> : null}
    </View>
  )
}

/** Bottom padding a scrolling screen needs so its last item clears the FABs. */
export const FAB_CLEARANCE = 14 + 56 + 40

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  bar: { height: 52, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, backgroundColor: colors.bg, zIndex: 5 },
  fab: {
    position: 'absolute', right: 16, width: FAB_SIZE, height: FAB_SIZE, borderRadius: FAB_SIZE / 2,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.text,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 14, shadowOffset: { width: 0, height: 10 }, zIndex: 44,
  },
  fabVoice: { backgroundColor: colors.fabVoice, borderWidth: 1, borderColor: colors.fabVoiceBorder },
})

export { textAlpha }
