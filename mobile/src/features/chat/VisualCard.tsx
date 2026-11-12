// A chart or visual the agent rendered with `html_render` (web/src/chat/VisualFrame.tsx).
// The web draws the page inline; the app has no WebView yet, so it is a card that
// opens the page in the in-app browser. The bridge serves it sandboxed, so opening
// it top-level is safe.
import React from 'react'
import { StyleSheet, View } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import type { VisualPart } from '../../lib/chat/types'
import { bridgeUrl } from '../../lib/connection'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { colors } from '../../theme'
import { TI, vc } from './ui'
import { IconChartBar } from './icons'

export default function VisualCard({ part }: { part: VisualPart }) {
  const inner = (
    <>
      <View style={st.icon}><TI icon={IconChartBar} size={22} color="#8fb0ff" /></View>
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <T size={15} weight={500} numberOfLines={1}>{part.title || 'Chart'}</T>
        <T size={13} color={vc.faint}>{part.url ? 'Chart · tap to open' : 'Chart'}</T>
      </View>
    </>
  )
  // The signed address is added when the message leaves the bridge; without it there is nothing to open.
  const url = part.url
  if (!url) return <View style={st.card}>{inner}</View>
  const open = () => { tap(); WebBrowser.openBrowserAsync(bridgeUrl(url), { controlsColor: colors.accent }).catch(() => {}) }
  return <Press onPress={open} style={st.card}>{inner}</Press>
}

const st = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 72, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 16, backgroundColor: vc.surface, borderWidth: 1, borderColor: vc.line },
  icon: { width: 40, height: 40, borderRadius: 10, backgroundColor: '#5b8cff1f', alignItems: 'center', justifyContent: 'center' },
})
