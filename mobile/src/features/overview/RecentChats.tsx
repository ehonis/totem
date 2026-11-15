// "Recent chats" on the Overview, right under the ask box: the chats to get back
// into, with words still in their composer first (lib/chat/recents.ts). A tap
// opens the chat, draft and all.
import React, { useCallback, useMemo, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { useChat, threadTitle } from '../../lib/chat/store'
import { DRAFTS_KEY, OPENED_KEY, readJson, recentChats } from '../../lib/chat/recents'
import { openChat } from '../../shell/nav'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { ThreadIcon } from '../chat/ThreadIcon'
import { IconPencil } from '../../lib/components/overview/icons'
import { ov, Section, TI } from './parts'

// Markdown down to its words: no list bullets or numbers, emphasis, headings or link targets.
const plain = (s: string) => s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '').replace(/[*_`#>|]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim()

function ago(ts: number, now: number): string {
  const m = Math.round((now - ts) / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  return d < 7 ? `${d}d` : new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function RecentChats() {
  const threads = useChat((s) => s.threads)
  // Drafts and opened marks live in localStorage (ChatScreen, the chat store); read again whenever the Overview shows.
  const [drafts, setDrafts] = useState<Record<string, string>>(() => readJson(localStorage, DRAFTS_KEY, {}))
  const [opened, setOpened] = useState<Record<string, number>>(() => readJson(localStorage, OPENED_KEY, {}))
  useFocusEffect(useCallback(() => {
    setDrafts(readJson(localStorage, DRAFTS_KEY, {}))
    setOpened(readJson(localStorage, OPENED_KEY, {}))
  }, []))
  const now = Date.now()
  const rows = useMemo(() => recentChats(threads, { drafts, opened, now }), [threads, drafts, opened]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows.length) return null
  return (
    <Section title="Recent chats">
      {rows.map(({ thread: t, draft, at }, i) => {
        const last = t.messages[t.messages.length - 1]
        const sub = draft || (last ? `${last.role === 'user' ? 'You: ' : ''}${plain(last.content || '')}` : '')
        return (
          <Press key={t.id} haptic onPress={() => openChat(t.id)} style={[st.row, i > 0 && st.rule]} accessibilityRole="button"
            accessibilityLabel={`Open ${threadTitle(t)}${draft ? ', unsent draft' : ''}`}>
            <View style={st.icon}><ThreadIcon t={t} size={17} /></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={st.top}>
                <T size={14.5} color={ov.text} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>{threadTitle(t)}</T>
                <T size={12.5} color={ov.faint}>{ago(at, now)}</T>
              </View>
              {sub ? (
                <View style={st.sub}>
                  {draft ? <TI icon={IconPencil} size={13} color={ov.soft} /> : null}
                  <T size={13} color={draft ? ov.soft : ov.faint} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>{draft ? `Draft: ${sub}` : sub}</T>
                </View>
              ) : null}
            </View>
          </Press>
        )
      })}
    </Section>
  )
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 50, paddingVertical: 8 },
  rule: { borderTopWidth: 1, borderTopColor: ov.rowLine },
  icon: { width: 22, alignItems: 'center' },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sub: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
})
