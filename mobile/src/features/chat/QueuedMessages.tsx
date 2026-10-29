// The messages waiting for the running reply (web chat/QueuedMessages.tsx), T3
// Code's queued-runs drawer: a strip on the composer's top edge, first in line
// first. Each one can be edited in the composer, sent into the running reply as
// a steer, or removed. Reordering is the web's (drag, or the arrow keys).
import React, { useState } from 'react'
import { Image, StyleSheet, View } from 'react-native'
import type { QueuedMessage } from '../../lib/chat/types'
import { imageSource } from './Message'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { TI, vc } from './ui'
import { IconListNumbers, IconChevronDown, IconPencil, IconCornerUpRight, IconX } from './icons'

export default function QueuedMessages({ queue, canSteer, editingId, onEdit, onCancelEdit, onSteer, onRemove }: {
  queue: QueuedMessage[]
  /** A reply is running that can take a steer. */
  canSteer: boolean
  /** The message being edited in the composer, if any. */
  editingId: string | null
  onEdit: (q: QueuedMessage) => void
  onCancelEdit: () => void
  onSteer: (id: string) => void
  onRemove: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(true)
  if (!queue.length) return null
  const n = queue.length
  return (
    <View style={st.drawer} accessibilityLabel={`${n} queued message${n === 1 ? '' : 's'}`} accessibilityLiveRegion="polite">
      <Press style={st.head} onPress={() => { tap(); setExpanded((x) => !x) }} accessibilityLabel={expanded ? 'Collapse queued messages' : 'Expand queued messages'}>
        <TI icon={IconListNumbers} size={12} />
        <T size={12} color={vc.soft}>Queued</T>
        <View style={st.count}><T size={11} color={vc.text} style={{ fontVariant: ['tabular-nums'] }}>{n}</T></View>
        <View style={{ flex: 1 }} />
        <TI icon={IconChevronDown} size={14} style={expanded ? undefined : { transform: [{ rotate: '180deg' }] }} />
      </Press>
      {expanded ? queue.map((q) => {
        const editing = editingId === q.id
        const images = (q.attachments || []).filter((a) => a.kind === 'image')
        const files = (q.attachments || []).filter((a) => a.kind !== 'image')
        const preview = q.text.trim().replace(/\s+/g, ' ') || (files.length ? files.map((f) => f.name).join(', ') : images.length ? '' : 'Queued message')
        return (
          <View key={q.id} style={[st.row, editing && st.rowEditing]}>
            <View style={st.content}>
              {images.map((a) => (
                <View key={a.id} style={st.thumb}>{a.url ? <Image source={imageSource(a.url, a.id)} style={st.thumbImg} /> : null}</View>
              ))}
              <T size={13} color={vc.text} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>{preview}</T>
            </View>
            {editing ? (
              <Press style={st.pill} onPress={() => { tap(); onCancelEdit() }} accessibilityLabel="Cancel editing"><T size={12} color={vc.soft}>Cancel</T></Press>
            ) : (
              <>
                <Press style={st.btn} hitSlop={4} onPress={() => { tap(); onEdit(q) }} accessibilityLabel="Edit queued message"><TI icon={IconPencil} size={14} color={vc.faint} /></Press>
                <Press style={st.pill} onPress={() => { tap(); onSteer(q.id) }} disabled={!canSteer}
                  accessibilityLabel={canSteer ? 'Send as a steer instead' : 'There is no active run to steer'}>
                  <TI icon={IconCornerUpRight} size={13} /><T size={12} color={vc.soft}>Steer</T>
                </Press>
                <Press style={st.btn} hitSlop={4} onPress={() => { tap(); onRemove(q.id) }} accessibilityLabel="Remove queued message"><TI icon={IconX} size={15} color={vc.faint} /></Press>
              </>
            )}
          </View>
        )
      }) : null}
    </View>
  )
}

const st = StyleSheet.create({
  // Tucked under the composer's top edge, the box drawn over its lower lip.
  drawer: {
    marginHorizontal: 26, marginBottom: -20, paddingTop: 4, paddingHorizontal: 6, paddingBottom: 24,
    borderWidth: 1, borderBottomWidth: 0, borderColor: 'rgba(255,255,255,0.09)', borderTopLeftRadius: 16, borderTopRightRadius: 16,
    backgroundColor: 'rgba(23,26,34,0.82)',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 5, paddingHorizontal: 6 },
  count: { minWidth: 16, paddingHorizontal: 5, borderRadius: 99, alignItems: 'center', backgroundColor: vc.raise },
  row: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 32, paddingLeft: 6, borderRadius: 8 },
  rowEditing: { backgroundColor: vc.raise },
  content: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 4 },
  thumb: { width: 16, height: 16, borderRadius: 4, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', backgroundColor: vc.raise },
  thumbImg: { width: '100%', height: '100%' },
  btn: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 30, paddingHorizontal: 8, borderRadius: 8 },
})
