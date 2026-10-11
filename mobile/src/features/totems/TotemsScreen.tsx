// Totems: standing agents that wake on a schedule, remember between runs, and tell
// the owner only what matters (web TotemsView.tsx + totems.css, phone layout).
// Every scheduled job is one. A totem's page and the builder are pushed screens.
import React, { useCallback, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { IconMessage, IconPlus, IconSparkles } from '../../lib/chat/icons'
import { Hi } from '../../lib/icons'
import { Screen, FAB_CLEARANCE } from '../../shell/Screen'
import { colors, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, IconBtn, Press, Toggle } from '../../ui/kit'
import { KindTag, TotemIcon, kindOf, loadJobs, openTotemChat, setEnabled, statusLine, useJobs } from './shared'

export default function TotemsScreen() {
  const jobs = useJobs()
  const [refreshing, setRefreshing] = useState(false)

  // Poll while on screen, so next-run times and running states stay honest.
  useFocusEffect(useCallback(() => {
    void loadJobs()
    const t = setInterval(() => { void loadJobs() }, 30_000)
    return () => clearInterval(t)
  }, []))

  // Agent totems first, then built-ins; on before paused; then by name.
  const sorted = useMemo(() => [...(jobs || [])].sort((a, b) =>
    Number(!!(a.runner || a.skillId)) - Number(!!(b.runner || b.skillId)) || Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)), [jobs])

  const build = () => router.push('/totem/new')

  return (
    <Screen title="Totems">
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 18, paddingBottom: FAB_CLEARANCE }}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.muted} onRefresh={async () => { setRefreshing(true); await loadJobs(); setRefreshing(false) }} />}
      >
        <View style={{ marginBottom: 26, gap: 20 }}>
          <View>
            <T size={26} weight={600} lineHeight={32} style={{ letterSpacing: -0.26 }}>Totems</T>
            <T size={14} muted lineHeight={22} style={{ marginTop: 6 }}>
              Standing agents that work on their own schedule, remember what they’ve seen, and only tell you what matters.
            </T>
          </View>
          <Btn kind="primary" title="New totem" icon={IconPlus} onPress={build} style={{ alignSelf: 'flex-start' }} />
        </View>

        {!jobs ? <T muted>Loading…</T> : null}
        {jobs && !jobs.length ? (
          <Press onPress={build} style={st.empty}>
            <Hi icon={IconSparkles} size={22} color={colors.muted} />
            <T size={15} weight={500}>Make your first totem</T>
            <T size={14} muted align="center">Describe a job, such as watching a listing or writing a weekly review, and the builder sets it up.</T>
          </Press>
        ) : null}

        <View style={{ gap: 8 }}>
          {sorted.map((j) => {
            const bad = j.lastRun?.status === 'error'
            return (
              <View key={j.id} style={[st.card, !j.enabled && { opacity: 0.62 }]}>
                <Press
                  onPress={() => router.push({ pathname: '/totem/[id]', params: { id: j.id } })}
                  accessibilityRole="button"
                  accessibilityLabel={j.name}
                  style={st.main}
                >
                  <TotemIcon name={j.iconName} />
                  <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                    <T size={15} weight={600}>{j.name}</T>
                    <T size={13.5} lineHeight={19} color={textAlpha(72)} numberOfLines={2}>{j.description || j.scheduleLabel}</T>
                    <KindTag label={kindOf(j)} />
                    <T size={12.5} lineHeight={18} muted>
                      {j.scheduleLabel}
                      <T size={12.5} muted style={{ opacity: 0.6 }}>{'  ·  '}</T>
                      <T size={12.5} color={bad ? '#f0879e' : colors.muted}>{statusLine(j)}</T>
                    </T>
                  </View>
                </Press>
                <View style={st.side}>
                  <Toggle value={!!j.enabled} onChange={(v) => { void setEnabled(j, v) }} />
                  <IconBtn icon={IconMessage} size={18} box={32} color={colors.muted} label={`Chat with ${j.name}`} onPress={() => { void openTotemChat(j) }} />
                </View>
              </View>
            )
          })}
        </View>
      </ScrollView>
    </Screen>
  )
}

const st = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4, paddingLeft: 4, paddingRight: 12,
    borderWidth: 1, borderColor: colors.line, borderRadius: 12, backgroundColor: colors.bg2,
  },
  main: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 14, padding: 12 },
  side: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  empty: {
    alignItems: 'center', gap: 8, paddingVertical: 40, paddingHorizontal: 20, marginBottom: 12,
    borderWidth: 1, borderStyle: 'dashed', borderColor: colors.line, borderRadius: 14,
  },
})
