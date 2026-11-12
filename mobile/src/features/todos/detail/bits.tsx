// Small pieces of the task page: the quiet "Saved" mark, the inline undo line,
// section headings, and how times read.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, StyleSheet, View } from 'react-native'
import Animated, { FadeIn, FadeOut, useReducedMotion } from 'react-native-reanimated'
import { colors } from '../../../theme'
import { T } from '../../../ui/Text'
import { Press } from '../../../ui/kit'
import { Hi, ArrowUturnLeftIcon, CheckIcon } from '../../../lib/icons'
import { once, undoLineTimeout } from '../undo'

/** "Tue 5 Nov, 09:00", with the year only when it is not this one. */
export function whenLabel(value: string | Date, withTime = true) {
  const at = new Date(value)
  const sameYear = at.getFullYear() === new Date().getFullYear()
  return new Intl.DateTimeFormat(undefined, {
    weekday: sameYear ? 'short' : undefined, month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  }).format(at)
}

/** "Saving…" while a save is out, then "Saved" with a tick for a moment. Says nothing otherwise. */
export function SavedMark({ pending, savedAt }: { pending: boolean; savedAt: number }) {
  const reduced = useReducedMotion()
  const [showSaved, setShowSaved] = useState(false)
  useEffect(() => {
    if (!savedAt) return
    setShowSaved(true)
    const timer = setTimeout(() => setShowSaved(false), 1800)
    return () => clearTimeout(timer)
  }, [savedAt])
  const enter = reduced ? undefined : FadeIn.duration(140)
  const exit = reduced ? undefined : FadeOut.duration(400)
  return (
    <View style={st.mark} accessibilityLiveRegion="polite">
      {pending ? (
        <Animated.View key="saving" entering={enter} exiting={exit}><T size={12.5} muted>Saving…</T></Animated.View>
      ) : showSaved ? (
        <Animated.View key="saved" entering={enter} exiting={exit} style={st.saved}>
          <Hi icon={CheckIcon} size={12} color={colors.green} strokeWidth={2.6} />
          <T size={12.5} color={colors.green}>Saved</T>
        </Animated.View>
      ) : null}
    </View>
  )
}

export interface UndoState { id: number; text: string; action?: { label: string; run: () => void } }

/** Whether VoiceOver (or another screen reader) is running, kept up to date. */
function useScreenReader() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let live = true
    AccessibilityInfo.isScreenReaderEnabled().then((value) => { if (live) setOn(value) }, () => {})
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setOn)
    return () => { live = false; sub.remove() }
  }, [])
  return on
}

/**
 * The line after a completion, snooze or delete: what happened, and Undo (or Open).
 * Sighted, it closes after UNDO_MS. With a screen reader it would be gone before
 * VoiceOver reached it (it is drawn after the list), so VoiceOver is moved onto it,
 * it stays two minutes (undoLineTimeout) unless the next change replaces it or the
 * escape gesture dismisses it, and a two-finger double tap (the magic tap) runs its Undo.
 */
export function UndoLine({ undo, onDone }: { undo: UndoState | null; onDone: () => void }) {
  const reduced = useReducedMotion()
  const reader = useScreenReader()
  const line = useRef<View>(null)
  // One press per line: a double tap must not send the same undo twice.
  const press = useMemo(() => once(() => { onDone(); undo?.action?.run() }), [undo, onDone])
  useEffect(() => {
    if (!undo) return
    const timer = setTimeout(onDone, undoLineTimeout(reader))
    // After the line has mounted and faded in, so VoiceOver has an element to land on.
    const focus = reader ? setTimeout(() => { if (line.current) AccessibilityInfo.sendAccessibilityEvent(line.current, 'focus') }, 250) : null
    return () => { clearTimeout(timer); if (focus) clearTimeout(focus) }
  }, [undo, onDone, reader])
  if (!undo) return null
  const spoken = undo.action ? `${undo.text}. ${undo.action.label}` : undo.text
  return (
    <Animated.View key={undo.id} entering={reduced ? undefined : FadeIn.duration(180)} exiting={reduced ? undefined : FadeOut.duration(200)}>
      <View
        ref={line}
        style={st.undo}
        // One element for VoiceOver: it reads what happened, and a double tap is the button.
        accessible
        accessibilityLabel={spoken}
        accessibilityRole={undo.action ? 'button' : 'text'}
        accessibilityHint={undo.action ? `Double-tap to ${undo.action.label.toLowerCase()}.` : undefined}
        accessibilityLiveRegion="polite"
        onAccessibilityTap={undo.action ? () => { press() } : undefined}
        onMagicTap={undo.action ? () => { press() } : undefined}
        onAccessibilityEscape={onDone}
      >
        <T size={13.5} style={{ flex: 1 }} numberOfLines={2}>{undo.text}</T>
        {undo.action ? (
          <Press haptic onPress={press} style={st.undoBtn} accessibilityRole="button" accessibilityLabel={`${undo.action.label}: ${undo.text}`}>
            {undo.action.label === 'Undo' ? <Hi icon={ArrowUturnLeftIcon} size={14} color={colors.accent} /> : null}
            <T size={14} weight={600} color={colors.accent}>{undo.action.label}</T>
          </Press>
        ) : null}
      </View>
    </Animated.View>
  )
}

/** A section's name, with an optional quiet aside on the right. */
export function SectionTitle({ title, aside }: { title: string; aside?: string | number }) {
  return (
    <View style={st.section} accessibilityRole="header">
      <T size={15} weight={600}>{title}</T>
      {aside !== undefined && aside !== '' ? <T size={13} muted>{String(aside)}</T> : null}
    </View>
  )
}

const st = StyleSheet.create({
  mark: { minWidth: 64, alignItems: 'flex-end' },
  saved: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  undo: {
    flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingLeft: 12, paddingRight: 4, paddingVertical: 6,
    borderRadius: 10, backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line,
  },
  undoBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44, paddingHorizontal: 10 },
  section: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 2 },
})
