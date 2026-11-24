// Unsent new-chat drafts at the top of the drawer's chats (web ChatsPanelDrafts.tsx),
// under "Unsent" as T3 Code's app lists them. Each row is an amber pencil and
// "Draft", where it will start, and its first line or how many files it holds.
// A tap opens it in the chat screen; swiped left it shows Discard, and a long
// press offers Open and Discard. A discard has Undo in the drawer's foot.
import React, { useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import { useChat } from '../../lib/chat/store'
import { draftRows, rowsSignature, type DraftRow } from '../../lib/chat/draftsShared'
import { colors, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { impact, tap } from '../../ui/haptics'
import { showMenu } from '../../ui/menu'
import { drawerPan } from '../../shell/drawerGesture'
import { discardDraft, drafts, openDraft, useDraftsSnapshot, useShownDraft } from './appDrafts'
import { ProjectIcon } from './ThreadIcon'
import { SwipeBtn } from './ChatsNav'
import { TI } from './ui'
import { IconChecklist, IconClock, IconHome, IconPencil, IconTrash } from './icons'

const AMBER_WASH = 'rgba(227, 179, 65, 0.08)'

function DraftItem({ row, onOpen }: { row: DraftRow; onOpen: () => void }) {
  const swipe = useRef<SwipeableMethods>(null)
  const open = () => { tap(); openDraft(row.key); onOpen() }
  const discard = () => { swipe.current?.close(); impact(); discardDraft(row.key) }
  const icon = row.icon === 'task' ? <TI icon={IconChecklist} size={14} color={colors.muted} />
    : row.project ? <ProjectIcon p={row.project} size={14} />
    : <TI icon={row.icon === 'temporary' ? IconClock : IconHome} size={14} color={colors.muted} />
  return (
    <ReanimatedSwipeable
      ref={swipe}
      friction={1.4}
      rightThreshold={40}
      overshootRight={false}
      blocksExternalGesture={drawerPan()}
      renderRightActions={() => (
        <View style={st.swipe}>
          <SwipeBtn label="Discard" icon={IconTrash} fill={colors.red} ink={colors.white} onPress={discard} />
        </View>
      )}
    >
      <View style={st.back}>
        <Press
          style={[st.row, row.active && st.rowOn]}
          onPress={open}
          onLongPress={() => {
            impact()
            showMenu([
              { label: 'Open draft', onPress: open },
              { label: 'Discard draft', destructive: true, onPress: discard },
            ], { title: row.preview })
          }}
          accessibilityRole="button"
          accessibilityLabel={`Unsent draft in ${row.place}: ${row.preview}`}
          accessibilityState={{ selected: row.active }}
          accessibilityHint="Opens the draft. Swipe left or long-press to discard."
          accessibilityActions={[{ name: 'discard', label: 'Discard draft' }]}
          onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'discard') discard() }}
        >
          <View style={st.head}>
            <TI icon={IconPencil} size={13} color={colors.amber} />
            <T size={12} weight={600} color={colors.amber}>Draft</T>
            <T size={12} color={textAlpha(40)}>·</T>
            {icon}
            <T size={12.5} color={colors.muted} numberOfLines={1} style={{ flexShrink: 1 }}>{row.place}</T>
          </View>
          <T size={15} numberOfLines={1} color={row.active ? colors.text : textAlpha(86)}>{row.preview}</T>
        </Press>
      </View>
    </ReanimatedSwipeable>
  )
}

/** The drafts for Home's list (every draft) or a project's (its own and its folders'); nothing when there are none. */
export default function ChatsNavDrafts({ projectId, homeOnly = false, onOpen }: { projectId: string | null; homeOnly?: boolean; onOpen: () => void }) {
  const shown = useShownDraft()
  const projects = useChat((s) => s.projects)
  // The draft on screen is listed only if it had words or files when it was opened.
  const [arrival, setArrival] = useState<{ key: string | null; listed: boolean }>({ key: null, listed: false })
  if (arrival.key !== shown) setArrival({ key: shown, listed: !!shown && !!drafts.get().drafts[shown] })
  const listedOnArrival = arrival.key === shown && arrival.listed
  // Scoped to Home: drafts headed for a project are left out (projectId null alone means every draft).
  const rowsNow = () => { const all = draftRows(drafts.get(), { projects, projectId, shown, listedOnArrival }); return homeOnly ? all.filter((r) => !r.project) : all }
  // Redrawn when a row changes, not on every keystroke in a draft that has no row.
  const signature = useDraftsSnapshot(() => rowsSignature(rowsNow()))
  const rows = useMemo(rowsNow, [signature, projects, projectId, homeOnly, shown, listedOnArrival]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows.length) return null
  return (
    <View style={st.block} accessibilityLabel="Unsent drafts">
      <View style={st.label}><T size={13.5} color={colors.muted}>Unsent</T></View>
      {rows.map((r) => <DraftItem key={r.key} row={r} onOpen={onOpen} />)}
    </View>
  )
}

const st = StyleSheet.create({
  block: { paddingBottom: 6, gap: 2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  label: { paddingTop: 12, paddingBottom: 4, paddingLeft: 12 },
  // Opaque, so Discard stays hidden until the row slides off it.
  back: { backgroundColor: colors.bg2, borderRadius: 10 },
  row: { gap: 3, minHeight: 52, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: AMBER_WASH },
  rowOn: { backgroundColor: colors.drawerOn },
  head: { flexDirection: 'row', alignItems: 'center', gap: 5, minWidth: 0 },
  swipe: { flexDirection: 'row', gap: 4, paddingLeft: 6, alignItems: 'center' },
})
