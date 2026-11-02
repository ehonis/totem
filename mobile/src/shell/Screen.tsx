// Every screen but the chat: ChatGPT's top bar (☰, the screen's name, new chat),
// the content, and in the bottom-right corner the voice + new-chat pair
// (shell.css .sh-mbar / .sh-fab). Mirrors Shell.tsx's MobileBar and NewChatFab.
import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useIsFocused, useNavigation } from 'expo-router'
import { colors, textAlpha } from '../theme'
import { T } from '../ui/Text'
import { IconBtn, Press } from '../ui/kit'
import { Hi } from '../lib/icons'
import { IconEdit, IconMenu, IconWaveSine } from '../lib/chat/icons'
import { newChat, openDrawer, startVoice } from './nav'
import { PageGlow, type GlowPage } from '../ui/PageGlow'
import { impact } from '../ui/haptics'
import { setToastFloor } from '../ui/toastFloor'
import { getCacheStatus, subscribeCacheStatus } from '../lib/api'
import { ago } from '../lib/chat/settle'

export function MobileBar({ title, right }: { title: string; right?: React.ReactNode }) {
  const navigation = useNavigation()
  return (
    <View style={st.bar}>
      <IconBtn icon={IconMenu} size={22} label="Menu" onPress={() => openDrawer(navigation)} />
      <View style={{ flex: 1, alignItems: 'center' }}>
        <T size={17} weight={600} align="center" numberOfLines={1}>{title}</T>
        <OfflineHint />
      </View>
      {right ?? <IconBtn icon={IconEdit} size={21} label="New chat" onPress={newChat} />}
    </View>
  )
}

/**
 * Under the title while the bridge is out of reach: the screen is showing the
 * GET cache (lib/httpCache.ts), and this says how old it is. The web has no
 * such line; a browser tab has no data to show offline.
 */
function OfflineHint() {
  const { offline, updatedAt } = useSyncExternalStore(subscribeCacheStatus, getCacheStatus)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!offline) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [offline])
  if (!offline) return null
  const age = updatedAt ? ago(updatedAt, now) : null
  return (
    <T size={11} muted numberOfLines={1} accessibilityLiveRegion="polite">
      {age ? `Offline · updated ${age === 'now' ? 'just now' : `${age} ago`}` : 'Offline'}
    </T>
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
  // Toasts at the bottom keep left of the pair.
  const focused = useIsFocused()
  useEffect(() => {
    if (!focused) return
    setToastFloor({ fab: true })
    return () => setToastFloor({ fab: false })
  }, [focused])
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
