import React from 'react'
import { StyleSheet, View } from 'react-native'
import { useChat, answerHandoff } from '../../lib/chat/store'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { TI, vc } from './ui'
import { IconHandClick } from './icons'

// The web's HandoffBar: the chat's agent handed its browser to the owner
// (preview_handoff) and is waiting on him, so a chat that looks like it is still
// running says why. The app has no browser to drive, so it says where the page
// is; Done (he did it on the web) and Skip answer it from here.
const BLUE = '#7aa2ff'

export default function HandoffBar({ threadId }: { threadId: string | null }) {
  const handoff = useChat((s) => (threadId ? s.handoffs[threadId] || null : null))
  if (!threadId || !handoff) return null
  return (
    <View style={st.bar} accessibilityRole="summary" accessibilityLabel={`Your turn in the browser: ${handoff.reason}`}>
      <TI icon={IconHandClick} size={17} color={BLUE} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T size={13} weight={600} numberOfLines={1}>Your turn in the browser</T>
        <T size={12.5} color={vc.soft} numberOfLines={2}>{handoff.reason} · do it in this chat on the web</T>
      </View>
      <Press style={st.ghost} hitSlop={6} onPress={() => { tap(); void answerHandoff(threadId, 'skip') }} accessibilityRole="button" accessibilityLabel="Skip"><T size={13} weight={500} color={vc.soft}>Skip</T></Press>
      <Press style={st.done} hitSlop={6} onPress={() => { tap(); void answerHandoff(threadId, 'done') }} accessibilityRole="button" accessibilityLabel="Done"><T size={13} weight={600} color="#0b1020">Done</T></Press>
    </View>
  )
}

const st = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6, paddingVertical: 6, paddingLeft: 12, paddingRight: 6,
    borderRadius: 12, borderWidth: 1, borderColor: 'rgba(122,162,255,0.45)', backgroundColor: 'rgba(122,162,255,0.12)',
  },
  ghost: { height: 36, paddingHorizontal: 10, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  done: { height: 36, paddingHorizontal: 14, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: BLUE },
})
