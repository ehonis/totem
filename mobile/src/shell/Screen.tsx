// Every screen but the chat: ChatGPT's top bar (☰, the screen's name, the AI
// usage pill), the content, and in the bottom-right corner the new-chat button, in
// liquid glass where iOS has it (shell.css .sh-mbar / .sh-fab). Voice mode starts from
// the home-screen quick action and the chat's composer, not a second corner button.
// Mirrors Shell.tsx's MobileBar and NewChatFab, except the bar's right slot: the web
// has new chat there, the app the usage pill (new chat is the corner button), so that
// glance is on every page.
import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useIsFocused, useNavigation } from 'expo-router'
import { colors, textAlpha } from '../theme'
import { T } from '../ui/Text'
import { IconBtn, Press } from '../ui/kit'
import { Hi } from '../lib/icons'
import { IconEdit, IconMenu } from '../lib/chat/icons'
import UsageChips from '../features/chat/UsageChips'
import { newChat, openDrawer } from './nav'
import { PageGlow, type GlowPage } from '../ui/PageGlow'
import { impact } from '../ui/haptics'
import { FAB_TINT, GlassButton } from '../ui/glass'
import { setToastFloor } from '../ui/toastFloor'
import { getCacheStatus, subscribeCacheStatus } from '../lib/api'
import { ago } from '../lib/chat/settle'

export function MobileBar({ title }: { title: string }) {
  const navigation = useNavigation()
  return (
    <View style={st.bar}>
      <View style={[st.side, { alignItems: 'flex-start' }]}>
        <IconBtn icon={IconMenu} size={22} label="Menu" onPress={() => openDrawer(navigation)} />
      </View>
      <View style={{ flex: 1, alignItems: 'center' }}>
        <T size={17} weight={600} align="center" numberOfLines={1}>{title}</T>
        <OfflineHint />
      </View>
      <View style={[st.side, { alignItems: 'flex-end' }]}><UsageChips /></View>
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

/** The new-chat button in the bottom-right corner: tinted light glass, or the solid light circle without glass. */
export function NewChatFab({ bottomOffset = 0 }: { bottomOffset?: number }) {
  const insets = useSafeAreaInsets()
  // Toasts at the bottom keep left of it.
  const focused = useIsFocused()
  useEffect(() => {
    if (!focused) return
    setToastFloor({ fab: true })
    return () => setToastFloor({ fab: false })
  }, [focused])
  const base = Math.max(insets.bottom, 14) + 8 + bottomOffset
  return (
    <View style={[st.fabSpot, { bottom: base }]} pointerEvents="box-none">
      <GlassButton
        shape={st.fab}
        fallback={st.fabSolid}
        tint={FAB_TINT}
        accessibilityRole="button"
        accessibilityLabel="New chat"
        onPress={() => { impact(); newChat() }}
      >
        <Hi icon={IconEdit} size={22} strokeWidth={2} color="#0f1115" />
      </GlassButton>
    </View>
  )
}

/**
 * A drawer screen's frame. The content scrolls itself (a ScrollView or FlatList),
 * and should pad its foot by FAB_CLEARANCE so the last row clears the buttons.
 */
export function Screen({ title, children, fab = true, glow, style }: {
  title: string
  /** Draw the page over its colour glow (PageGlow). */
  glow?: GlowPage
  children: React.ReactNode
  fab?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[st.screen, { paddingTop: insets.top }, style]}>
      <MobileBar title={title} />
      <View style={{ flex: 1 }}>
        {glow ? <PageGlow page={glow} /> : null}
        {children}
      </View>
      {fab ? <NewChatFab /> : null}
    </View>
  )
}

/** Bottom padding a scrolling screen needs so its last item clears the corner button. */
export const FAB_CLEARANCE = 14 + 56 + 40

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  // Both sides at least one width, so the title stays centred whether or not the pill
  // shows; at a large text size the pill widens its side instead of covering the title.
  side: { minWidth: 76, justifyContent: 'center' },
  bar: { height: 52, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, backgroundColor: colors.bg, zIndex: 5 },
  fabSpot: { position: 'absolute', right: 16, zIndex: 44 },
  fab: { width: FAB_SIZE, height: FAB_SIZE, borderRadius: FAB_SIZE / 2 },
  // Glass draws its own depth; the solid circle keeps its fill and drop shadow.
  fabSolid: { backgroundColor: colors.text, shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 14, shadowOffset: { width: 0, height: 10 } },
})

export { textAlpha }
