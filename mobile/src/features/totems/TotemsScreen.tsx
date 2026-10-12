// Totems: standing agents that wake on a schedule, remember between runs, and tell
// the owner only what matters (web TotemsView.tsx + totems.css, phone layout).
// Like the chats list: a row opens the totem's chat, where its runs are posted;
// the gear opens its page (settings, memory, runs). Group chats sit on top.
import React, { useCallback, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { IconPlus, IconSettings, IconSparkles, IconUsersGroup } from '../../lib/chat/icons'
import { syncThreads, threadTitle, useChat } from '../../lib/chat/store'
import { ago } from '../../lib/chat/settle'
import type { ChatThread } from '../../lib/chat/types'
import { Hi } from '../../lib/icons'
import { openChat } from '../../shell/nav'
import { Screen, FAB_CLEARANCE } from '../../shell/Screen'
import { colors, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, IconBtn, Press, Toggle } from '../../ui/kit'
import Spark from '../chat/Spark'
import { KindTag, TotemIcon, kindOf, loadJobs, openTotemChat, setEnabled, statusLine, useJobs } from './shared'

const plain = (s: string) => s.replace(/[*_`#>|]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim()

/** The newest message in a chat, as one plain line. */
function lastLine(t: ChatThread | undefined): { text: string; at: number } | null {
  const m = t?.messages[t.messages.length - 1]
  if (!m) return null
  const text = plain(m.content || '') || (m.parts?.some((p) => p.type === 'tool') ? 'Worked on something' : '')
  return text ? { text: m.role === 'user' ? `You: ${text}` : text, at: m.createdAt || t!.updatedAt } : null
}

function Unread() {
  return <View style={st.unread} accessibilityLabel="Unread" />
}

export default function TotemsScreen() {
  const jobs = useJobs()
  const threads = useChat((s) => s.threads)
  const runs = useChat((s) => s.runs)
  const [refreshing, setRefreshing] = useState(false)

  // Poll while on screen, so next-run times, running states and last messages stay honest.
  useFocusEffect(useCallback(() => {
    void loadJobs()
    void syncThreads()
    const t = setInterval(() => { void loadJobs(); void syncThreads() }, 30_000)
    return () => clearInterval(t)
  }, []))

  const ownChat = useMemo(() => new Map(threads.filter((t) => t.totemId).map((t) => [t.totemId!, t])), [threads])
  // Agent totems first, then built-ins; then whichever spoke last; then by name.
  const sorted = useMemo(() => [...(jobs || [])].sort((a, b) =>
    Number(!!(a.runner || a.skillId)) - Number(!!(b.runner || b.skillId))
    || (ownChat.get(b.id)?.updatedAt || 0) - (ownChat.get(a.id)?.updatedAt || 0)
    || Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)), [jobs, ownChat])
  const groups = useMemo(() => threads.filter((t) => t.members?.length).sort((a, b) => b.updatedAt - a.updatedAt), [threads])
  const now = Date.now()

  const build = () => router.push('/totem/new')

  return (
    <Screen title="Totems">
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 18, paddingBottom: FAB_CLEARANCE }}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.muted} onRefresh={async () => { setRefreshing(true); await Promise.all([loadJobs(), syncThreads()]); setRefreshing(false) }} />}
      >
        <View style={{ marginBottom: 22, gap: 20 }}>
          <View>
            <T size={26} weight={600} lineHeight={32} style={{ letterSpacing: -0.26 }}>Totems</T>
            <T size={14} muted lineHeight={22} style={{ marginTop: 6 }}>
              Standing agents that work on their own schedule, remember what they’ve seen, and only tell you what matters. Open one to read its runs and talk to it.
            </T>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn title="Group chat" icon={IconUsersGroup} disabled={!jobs?.length} onPress={() => router.push('/totem/group')} />
            <Btn kind="primary" title="New totem" icon={IconPlus} onPress={build} />
          </View>
        </View>

        {!jobs ? <T muted>Loading…</T> : null}

        {groups.length ? (
          <View style={{ marginBottom: 14 }}>
            <T size={12} weight={600} color={colors.muted} style={st.section}>GROUP CHATS</T>
            {groups.map((t) => {
              const last = lastLine(t)
              const members = (t.members || []).map((id) => jobs?.find((j) => j.id === id)).filter(Boolean)
              return (
                <Press key={t.id} onPress={() => openChat(t.id)} style={st.row} accessibilityRole="button" accessibilityLabel={threadTitle(t)}>
                  <View style={st.stack}>
                    {members.length ? members.slice(0, 3).map((j: any, i: number) => (
                      <View key={j.id} style={i ? { marginLeft: -12 } : undefined}><TotemIcon name={j.iconName} small /></View>
                    )) : <Hi icon={IconUsersGroup} size={16} color={colors.muted} />}
                  </View>
                  <View style={st.text}>
                    <View style={st.top}>
                      <T size={15} weight={600} numberOfLines={1} style={{ flexShrink: 1 }}>{threadTitle(t)}</T>
                      {t.needsReply ? <Unread /> : null}
                    </View>
                    <T size={13.5} color={textAlpha(72)} numberOfLines={1}>{runs[t.id] ? 'Answering…' : last ? last.text : 'No messages yet.'}</T>
                    <T size={12} muted numberOfLines={1}>You{members.length ? `, ${members.map((j: any) => j.name).join(', ')}` : ''}</T>
                  </View>
                  {last ? <T size={12} muted style={st.time}>{ago(last.at, now)}</T> : null}
                </Press>
              )
            })}
          </View>
        ) : null}

        {jobs && !jobs.length ? (
          <Press onPress={build} style={st.empty}>
            <Hi icon={IconSparkles} size={22} color={colors.muted} />
            <T size={15} weight={500}>Make your first totem</T>
            <T size={14} muted align="center">Describe a job, such as watching a listing or writing a weekly review, and the builder sets it up.</T>
          </Press>
        ) : null}

        {jobs?.length ? (
          <View>
            {groups.length ? <T size={12} weight={600} color={colors.muted} style={st.section}>TOTEMS</T> : null}
            {sorted.map((j) => {
              const bad = j.lastRun?.status === 'error'
              const chat = ownChat.get(j.id)
              const last = lastLine(chat)
              const running = (chat && !!runs[chat.id]) || j.lastRun?.status === 'running'
              return (
                <View key={j.id} style={[st.rowWrap, !j.enabled && { opacity: 0.62 }]}>
                  <Press onPress={() => { void openTotemChat(j) }} accessibilityRole="button" accessibilityLabel={`${j.name}, open its chat`} style={st.row}>
                    <TotemIcon name={j.iconName} />
                    <View style={st.text}>
                      <View style={st.top}>
                        <T size={15} weight={600} numberOfLines={1} style={{ flexShrink: 1 }}>{j.name}</T>
                        <KindTag label={kindOf(j)} />
                        {chat?.needsReply ? <Unread /> : null}
                      </View>
                      <T size={13.5} lineHeight={19} color={textAlpha(72)} numberOfLines={1}>{last ? last.text : j.description || 'No messages yet. Its runs are posted here.'}</T>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                        {running ? <Spark size={11} /> : null}
                        <T size={12} color={bad ? '#f0879e' : colors.muted} numberOfLines={1}>{running ? 'Running now…' : statusLine(j)}</T>
                      </View>
                    </View>
                    {last ? <T size={12} muted style={st.time}>{ago(last.at, now)}</T> : null}
                  </Press>
                  <View style={st.side}>
                    <Toggle value={!!j.enabled} onChange={(v) => { void setEnabled(j, v) }} />
                    <IconBtn icon={IconSettings} size={18} box={32} color={colors.muted} label={`${j.name} settings`} onPress={() => router.push({ pathname: '/totem/[id]', params: { id: j.id } })} />
                  </View>
                </View>
              )
            })}
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  )
}

const st = StyleSheet.create({
  section: { letterSpacing: 0.7, marginBottom: 4, marginLeft: 4 },
  rowWrap: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  row: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 4 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  time: { alignSelf: 'flex-start', paddingTop: 2 },
  side: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  stack: { width: 38, height: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  unread: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  empty: {
    alignItems: 'center', gap: 8, paddingVertical: 40, paddingHorizontal: 20, marginBottom: 12,
    borderWidth: 1, borderStyle: 'dashed', borderColor: colors.line, borderRadius: 14,
  },
})
