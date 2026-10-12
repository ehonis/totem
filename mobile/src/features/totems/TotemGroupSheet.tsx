// Sheet detents: [0.85, 1] (registered in src/app/_layout.tsx).
//
// Picking totems for a group chat (web TotemsView.tsx GroupPicker). Without a
// chat it starts a new group chat; with ?chat=<id> it edits who is in that chat.
import React, { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { setMembers, useChat } from '../../lib/chat/store'
import { IconCheck } from '../../lib/chat/icons'
import { colors, fonts, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { TI } from '../chat/ui'
import { TotemIcon, askable, loadJobs, startGroupChat, useJobs } from './shared'

export default function TotemGroupSheet() {
  const { chat } = useLocalSearchParams<{ chat?: string }>()
  const insets = useSafeAreaInsets()
  const jobs = useJobs()
  const thread = useChat((s) => (chat ? s.threads.find((t) => t.id === chat) : undefined))
  const editing = !!thread
  const [picked, setPicked] = useState<string[]>(thread?.members || [])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!jobs) void loadJobs() }, [jobs])
  const list = (jobs || []).filter(askable)
  const toggle = (id: string) => { tap(); setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])) }

  async function done() {
    if (editing) { setMembers(thread!.id, picked); router.back(); return }
    setBusy(true)
    router.back()
    await startGroupChat(picked, name.trim())
    setBusy(false)
  }

  return (
    <ScrollView style={{ backgroundColor: colors.bg2 }} contentContainerStyle={{ padding: 18, paddingTop: 24, paddingBottom: insets.bottom + 18, gap: 14 }} keyboardShouldPersistTaps="handled">
      <View style={{ gap: 4 }}>
        <T size={17} weight={600}>{thread?.members?.length ? 'Totems in this chat' : chat ? 'Bring totems into this chat' : 'New group chat'}</T>
        <T size={13.5} muted lineHeight={19}>The chat’s agent hosts it: it asks the totems you pick, passes their answers between them, and pulls the result together. Say “@name” to talk to one directly.</T>
      </View>
      {jobs && !list.length ? <T muted>No agent totems yet. Make one first; built-in jobs can’t talk.</T> : null}
      <View style={{ gap: 4 }}>
        {list.map((j) => {
          const on = picked.includes(j.id)
          return (
            <Press key={j.id} onPress={() => toggle(j.id)} style={[st.opt, on && st.optOn]} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={j.name}>
              <View style={[st.box, on && st.boxOn]}>{on ? <TI icon={IconCheck} size={14} color={colors.bg} /> : null}</View>
              <TotemIcon name={j.iconName} small />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T size={15}>{j.name}</T>
                {j.description ? <T size={12.5} color={textAlpha(60)} numberOfLines={1}>{j.description}</T> : null}
              </View>
            </Press>
          )
        })}
      </View>
      {!chat ? (
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Name (optional), e.g. Weekly planning"
          placeholderTextColor={colors.muted}
          keyboardAppearance="dark"
          selectionColor={colors.accent}
          style={st.field}
          accessibilityLabel="Group chat name"
        />
      ) : null}
      <Btn
        kind="primary"
        title={busy ? 'Working…' : editing || chat ? 'Save' : 'Start group chat'}
        disabled={busy || (!picked.length && !thread?.members?.length)}
        onPress={done}
      />
    </ScrollView>
  )
}

const st = StyleSheet.create({
  opt: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: 'transparent' },
  optOn: { borderColor: colors.line, backgroundColor: colors.bg3 },
  box: { width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, borderColor: textAlpha(40), alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  field: {
    height: 44, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.line,
    backgroundColor: colors.bg, color: colors.text, fontSize: 16, fontFamily: fonts[400],
  },
})
