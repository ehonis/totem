// Sheet detents: [0.75, 1] (formSheet, grabber, corner radius 22; registered in src/app/_layout.tsx).
//
// "Select text" from a message's long-press menu: the message as plain text in a
// read-only text view, where iOS's own selection works (press and drag, the
// handles, Copy, Look Up, Share), so part of a message can be copied, as
// ChatGPT's iOS app does. A message itself can't be selected: a press on it opens
// its menu, and RN's <Text selectable> on iOS offers only Copy for the whole block.
// A non-editable multiline TextInput is a UITextView that selects but never edits.
import React, { useEffect, useRef, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { success } from '../../ui/haptics'
import { colors, fonts } from '../../theme'
import { TI, vc } from './ui'
import { IconCheck, IconCopy } from './icons'
import { selectTextValue } from './selectText'

export default function SelectTextSheet() {
  const insets = useSafeAreaInsets()
  // Read once: a later open replaces the store, never this sheet's text.
  const [text] = useState(selectTextValue)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])
  const copyAll = () => {
    Clipboard.setStringAsync(text).catch(() => {})
    success()
    setCopied(true)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), 1200)
  }
  return (
    <View style={[st.root, { paddingBottom: insets.bottom + 12 }]}>
      <View style={st.head}>
        <T size={15} weight={600} style={{ flex: 1 }}>Select text</T>
        {text ? (
          <Press
            style={st.btn}
            hitSlop={4}
            onPress={copyAll}
            accessibilityLabel={copied ? 'Copied' : 'Copy all'}
          >
            <TI icon={copied ? IconCheck : IconCopy} size={18} color={colors.text} />
          </Press>
        ) : null}
      </View>
      {text ? (
        <TextInput
          value={text}
          editable={false}
          multiline
          selectionColor={colors.accent}
          accessibilityLabel="Message text"
          accessibilityHint="Press and drag to select part of it"
          style={st.text}
        />
      ) : (
        <T muted style={st.empty}>Nothing to select. Open this from a message's menu.</T>
      )}
    </View>
  )
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 18, paddingBottom: 8, paddingHorizontal: 16 },
  btn: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, borderColor: vc.line, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, paddingHorizontal: 18, paddingTop: 6, paddingBottom: 24, fontFamily: fonts[400], fontSize: 16, lineHeight: 25, color: colors.text, textAlignVertical: 'top' },
  empty: { padding: 20 },
})
