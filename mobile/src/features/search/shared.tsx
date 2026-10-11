// Pieces the Search list and its result sheet share: the kinds, highlighted text,
// opening a hit where it lives, and "Add to chat" (web SearchView.tsx).
import React, { useCallback } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { MenuView } from '@react-native-menu/menu'
import {
  BookOpenIcon, MicrophoneIcon, ChatBubbleLeftRightIcon, CheckCircleIcon, FlagIcon,
  ClipboardIcon, FolderIcon, PlusIcon, Hi, type IconType,
} from '../../lib/icons'
import { AuthError, searchResultAsContext, type SearchHit } from '../../lib/api'
import { useChat, setActive, openProject, threadTitle } from '../../lib/chat/store'
import { queueContext } from '../../lib/chat/pendingContext'
import type { Attachment } from '../../lib/chat/types'
import { pushError } from '../../lib/toast'
import { navigateTo, openChat } from '../../shell/nav'
import { colors, alpha } from '../../theme'
import { T } from '../../ui/Text'
import { s as kit } from '../../ui/kit'
import { success, tap } from '../../ui/haptics'

// Highlight markers from search/index.mjs.
const MARK_START = '\u0002'
const MARK_END = '\u0003'

/** The Totems tab's mark (assets/images/totems-icon.png), sized and tinted like an icon. */
export function TotemsGlyph({ size = 20, color = colors.text }: { size?: number; color?: any }) {
  return <Image source={require('../../../assets/images/totems-icon.png')} style={{ width: size, height: size, tintColor: color }} />
}

export const KINDS: { id: string; label: string; icon: IconType }[] = [
  { id: 'note', label: 'Memory', icon: BookOpenIcon },
  { id: 'chat', label: 'Chats', icon: ChatBubbleLeftRightIcon },
  { id: 'journal', label: 'Journal', icon: MicrophoneIcon },
  { id: 'task', label: 'Tasks', icon: CheckCircleIcon },
  { id: 'goal', label: 'Goals', icon: FlagIcon },
  { id: 'list', label: 'Lists', icon: ClipboardIcon },
  { id: 'project', label: 'Projects', icon: FolderIcon },
  { id: 'totem', label: 'Totems', icon: TotemsGlyph },
]
export const kindOf = (id: string) => KINDS.find((k) => k.id === id)

/** Text with search highlights as an amber wash (the web's <mark>). Nest inside a <T>. */
export function Marked({ text }: { text?: string }) {
  if (!text) return null
  const out: React.ReactNode[] = []
  text.split(MARK_START).forEach((chunk, i) => {
    if (i === 0) { out.push(chunk); return }
    const [hit, ...rest] = chunk.split(MARK_END)
    // Plain Text so it inherits the surrounding size and weight.
    out.push(<Text key={i} style={st.mark}>{hit}</Text>, rest.join(''))
  })
  return <>{out}</>
}

/** "MEMORY" with its glyph: the kind label above a result's title. */
export function KindLabel({ kind }: { kind: string }) {
  const k = kindOf(kind)
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      {k ? <Hi icon={k.icon} size={14} color={colors.muted} /> : null}
      <T size={12} muted style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>{k?.label || kind}</T>
    </View>
  )
}

// The sheet is a separate route; it reads the hit from here rather than
// round-tripping the whole object through URL params.
const hits = new Map<string, SearchHit>()
export const rememberHit = (hit: SearchHit) => { hits.set(hit.id, hit) }
export const recallHit = (id: string) => hits.get(id)

export function openResultSheet(hit: SearchHit) {
  rememberHit(hit)
  router.push({ pathname: '/search-result', params: { id: hit.id } })
}

/** Go where the hit lives (SearchView's open()). */
export function openHit(hit: SearchHit) {
  const t = hit.target || {}
  if (t.tab === 'chat' && t.thread) { openChat(t.thread); return }
  if (t.tab === 'chat' && t.project) { openProject(t.project); router.navigate('/chat'); return }
  // The app has no Brain tab: a note opens as its own sheet instead.
  if (t.tab === 'brain') { openResultSheet(hit); return }
  if (t.tab === 'totems' && t.totem) { router.push({ pathname: '/totem/[id]', params: { id: t.totem } }); return }
  navigateTo({ tab: t.tab, app: t.app })
}

/**
 * Save the result as a text attachment and hand it to the composer of the chosen
 * chat (null: a new chat on Home). Nothing is sent until he sends it.
 */
export async function addToChat(hit: SearchHit, threadId: string | null) {
  try {
    const { attachment } = (await searchResultAsContext(hit.id)) as { attachment: Attachment }
    queueContext(attachment)
    success()
    if (threadId) setActive(threadId)
    else openProject(null)
    router.navigate('/chat')
  } catch (e: any) {
    if (!(e instanceof AuthError)) pushError(e.message)
  }
}

/**
 * "Add to chat": a native menu of New chat and the eight most recent chats. The
 * web's type-to-filter box has no place in a system menu; recents cover the
 * common case and New chat covers the rest.
 */
export function AddToChatMenu({ hit, compact = true, onDone }: { hit: SearchHit; compact?: boolean; onDone?: () => void }) {
  const threads = useChat((s) => s.threads)
  const recent = threads.filter((t) => t.kind !== 'temporary' && t.messages?.length).slice(0, 8)
  const pick = useCallback((id: string | null) => { onDone?.(); void addToChat(hit, id) }, [hit, onDone])
  return (
    <MenuView
      shouldOpenOnLongPress={false}
      themeVariant="dark"
      title="Add to chat"
      onPressAction={({ nativeEvent }) => { tap(); pick(nativeEvent.event === '__new' ? null : nativeEvent.event) }}
      actions={[
        { id: '__new', title: 'New chat', image: 'plus' },
        ...recent.map((t) => ({ id: t.id, title: threadTitle(t), image: 'bubble.left.and.bubble.right' })),
      ]}
    >
      <View style={[kit.btn, compact && st.sm]}>
        <Hi icon={PlusIcon} size={14} color={colors.text} />
        <T size={13} weight={500}>Add to chat</T>
      </View>
    </MenuView>
  )
}

export const st = StyleSheet.create({
  mark: { backgroundColor: alpha(colors.amber, 0.28), color: colors.text, borderRadius: 3 },
  // .search-view .btn.sm
  sm: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8, gap: 5, minHeight: 32 },
})
