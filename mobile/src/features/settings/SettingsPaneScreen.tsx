// One Settings pane, pushed from the grouped list with the system back button.
// `row` (a search hit, a /settings/<pane>#<row> link) scrolls to that setting.
import React from 'react'
import { View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { paneById } from './panes'
import { PaneScroll } from './ui'

export default function SettingsPaneScreen() {
  const { pane: id, row } = useLocalSearchParams<{ pane: string; row?: string }>()
  const pane = paneById(id)
  const Body = pane?.component
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* The header itself is declared on the route in app/_layout.tsx; only the title is per pane. */}
      <Stack.Screen options={{ title: pane?.label || 'Settings' }} />
      {Body && pane?.bare ? <Body /> : (
        <PaneScroll target={row || undefined}>
          {Body ? <Body target={row || undefined} /> : <T muted>No such settings pane.</T>}
        </PaneScroll>
      )}
    </View>
  )
}
