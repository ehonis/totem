// What a screen shows when it throws while rendering. In a release build an
// uncaught render error closes the whole app; with this, only that screen
// fails, says why, and can be retried or left (the drawer and back still work).
// The usual cause is the bridge's data changing shape before the app caught up.
import React from 'react'
import { ScrollView, View } from 'react-native'
import { router, type ErrorBoundaryProps } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import { colors } from '../theme'
import { T } from '../ui/Text'
import { Btn } from '../ui/kit'
import { Hi, WarnIcon, ClipboardIcon } from '../lib/icons'

export function ScreenError({ error, retry }: ErrorBoundaryProps) {
  const insets = useSafeAreaInsets()
  const head = `${error?.name || 'Error'}: ${error?.message || String(error)}`
  // Hermes and V8 stacks start with the message line already.
  const stack = (error?.stack || '').split('\n').filter((l, i) => !(i === 0 && l.trim() === head)).slice(0, 8)
  const detail = [head, ...stack].join('\n')
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 22, paddingTop: insets.top + 40, gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <WarnIcon size={18} />
        <T size={18} weight={600}>This screen hit an error</T>
      </View>
      <T muted lineHeight={20}>The rest of Totem still works. Try again, or go back. If it keeps happening, copy the details and send them over.</T>
      <View style={{ padding: 12, borderRadius: 10, backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line }}>
        <T mono size={12} color={colors.muted} selectable>{detail}</T>
      </View>
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Btn kind="primary" title="Try again" onPress={retry} />
        {router.canGoBack() ? <Btn title="Go back" onPress={() => router.back()} /> : <Btn title="Overview" onPress={() => router.replace('/')} />}
        <Btn title="Copy details" onPress={() => { Clipboard.setStringAsync(detail).catch(() => {}) }}>
          <Hi icon={ClipboardIcon} size={14} color={colors.text} />
        </Btn>
      </View>
    </ScrollView>
  )
}
