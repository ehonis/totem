// The web's ToastHost (components/ToastHost.tsx) on a phone: one solid fill per
// kind, white text, full width at the bottom of the screen, stacked as T3 Code's
// deck (newest in front, two peeking above it; tap to spread upward, which holds them).
// The deck sits on whatever owns the bottom (toastFloor.ts): an open chat's composer,
// the floating buttons beside it, and the keyboard when it is up.
// Reads the same toast store (lib/toast.ts) so ported code that calls
// pushError() just works.
import React, { useCallback, useEffect, useState } from 'react'
import { StyleSheet, Pressable } from 'react-native'
import Animated, { FadeInUp, FadeOut, cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import { useToastFloor } from './toastFloor'
import { useToasts, dismissToast, holdToasts, type Toast } from '../lib/toast'
import { Hi, XMarkIcon, ArrowUturnLeftIcon, ExclamationTriangleIcon, CheckCircleIcon, InformationCircleIcon } from '../lib/icons'
import { colors } from '../theme'
import { T } from './Text'
import { Press } from './kit'
import { success, tap, warn } from './haptics'

const ICONS = { error: ExclamationTriangleIcon, success: CheckCircleIcon, info: InformationCircleIcon }
const FILL = { error: colors.toastError, success: colors.toastSuccess, info: colors.toastInfo }

const SHOWN = 3
const PEEK = 10
const SHRINK = 0.06
const GAP = 8
const EASE = { duration: 420, easing: Easing.bezier(0.22, 1, 0.36, 1) }
const FAB_SPACE = 16 + 54 + 10 // Screen.tsx: the buttons' right margin and size, plus a gap

/** Time left on screen, flush with the top edge; holds while the deck is spread. */
function Countdown({ duration, held, restart }: { duration: number; held: boolean; restart: number }) {
  const left = useSharedValue(1)
  useEffect(() => { left.value = 1 }, [restart, left])
  useEffect(() => {
    if (held) { cancelAnimation(left); return }
    left.value = withTiming(0, { duration: duration * left.value, easing: Easing.linear })
  }, [held, duration, left, restart])
  const style = useAnimatedStyle(() => ({ transform: [{ scaleX: left.value }] }))
  return <Animated.View pointerEvents="none" style={[st.bar, style]} />
}

function Item({ t, index, open, offset, frontHeight, onHeight }: {
  t: Toast; index: number; open: boolean; offset: number; frontHeight: number
  onHeight: (id: number, h: number) => void
}) {
  useEffect(() => { if (t.kind === 'error') warn(); else if (t.kind === 'success') success() }, [t.kind, t.count])
  const behind = index > 0 && !open
  const y = useSharedValue(0)
  const scale = useSharedValue(1)
  const fade = useSharedValue(1)
  useEffect(() => {
    y.value = withTiming(-(open ? offset : index * PEEK), EASE)
    scale.value = withTiming(open ? 1 : 1 - index * SHRINK, EASE)
    fade.value = withTiming(behind ? 0 : 1, { duration: 200 })
  }, [open, offset, index, behind, y, scale, fade])
  const frame = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }, { scale: scale.value }] }))
  const body = useAnimatedStyle(() => ({ opacity: fade.value }))
  const ActionIcon = t.action?.icon === null ? null : t.action?.icon || ArrowUturnLeftIcon
  return (
    <Animated.View
      entering={FadeInUp.duration(180)}
      exiting={FadeOut.duration(150)}
      pointerEvents={behind ? 'none' : 'auto'}
      style={[st.toast, { backgroundColor: FILL[t.kind] || FILL.error, zIndex: SHOWN - index }, behind && { height: frontHeight }, frame]}
    >
      {t.duration > 0 ? <Countdown duration={t.duration} held={open} restart={t.count} /> : null}
      <Animated.View style={[st.row, body]} onLayout={(e) => onHeight(t.id, Math.round(e.nativeEvent.layout.height))}>
        <Hi icon={ICONS[t.kind] || ICONS.error} size={16} color={colors.white} style={{ marginTop: 1 }} />
        <T size={14} color={colors.white} style={{ flex: 1 }}>
          {t.text}{t.count > 1 ? <T size={12} weight={600} color={colors.white}>{`  ×${t.count}`}</T> : null}
        </T>
        {t.action ? (
          <Press style={st.action} onPress={() => { const run = t.action!.onClick; dismissToast(t.id); run() }}>
            {ActionIcon ? <Hi icon={ActionIcon} size={13} color={colors.white} /> : null}
            <T size={13} weight={600} color={colors.white}>{t.action.label}</T>
          </Press>
        ) : null}
        <Press hitSlop={10} onPress={() => dismissToast(t.id)} accessibilityLabel="Dismiss notification">
          <Hi icon={XMarkIcon} size={15} color="rgba(255,255,255,0.75)" />
        </Press>
      </Animated.View>
    </Animated.View>
  )
}

export default function ToastHost() {
  const toasts = useToasts()
  const insets = useSafeAreaInsets()
  const floor = useToastFloor()
  const keyboard = useReanimatedKeyboardAnimation()
  // Over the chat's dock when one is open, else just off the home indicator; the
  // keyboard lifts either, past whatever bottom gap already covers it.
  const rest = floor.dock ? floor.dock + GAP : Math.max(insets.bottom, 14) + 8
  const covered = floor.dock ? floor.lift : rest - 8
  const place = useAnimatedStyle(() => ({ bottom: rest + Math.max(0, Math.abs(keyboard.height.value) - covered) }), [rest, covered])
  const [open, setOpen] = useState(false)
  const [heights, setHeights] = useState<Record<number, number>>({})
  const onHeight = useCallback((id: number, h: number) => setHeights((m) => (m[id] === h ? m : { ...m, [id]: h })), [])
  const shown = toasts.slice(-SHOWN).reverse() // front first
  useEffect(() => { if (shown.length < 2 && open) { setOpen(false); holdToasts(false) } }, [shown.length, open])
  if (!shown.length) return null
  // Beside the floating buttons, not over them; a chat's dock sits above them anyway.
  const right = floor.fab && !floor.dock ? FAB_SPACE : 12

  const hOf = (t: Toast) => heights[t.id] || 48
  const frontHeight = hOf(shown[0])
  const offsets: number[] = []
  shown.reduce((y, t) => { offsets.push(y); return y + hOf(t) + GAP }, 0)
  const height = open ? offsets[shown.length - 1] + hOf(shown[shown.length - 1]) : frontHeight + (shown.length - 1) * PEEK
  const toggle = () => { if (shown.length < 2) return; tap(); setOpen(!open); holdToasts(!open) }

  return (
    <Animated.View pointerEvents="box-none" style={[st.wrap, { right, height }, place]}>
      <Pressable onPress={toggle} style={StyleSheet.absoluteFill} accessibilityLabel={open ? 'Stack notifications' : 'Show all notifications'}>
        {shown.map((t, i) => (
          <Item key={t.id} t={t} index={i} open={open} offset={offsets[i]} frontHeight={frontHeight} onHeight={onHeight} />
        ))}
      </Pressable>
    </Animated.View>
  )
}

const st = StyleSheet.create({
  wrap: { position: 'absolute', left: 12, zIndex: 1000 },
  toast: {
    position: 'absolute', left: 0, right: 0, bottom: 0, transformOrigin: 'bottom',
    borderRadius: 12, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 8 },
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingTop: 14, paddingBottom: 12, paddingLeft: 14, paddingRight: 12 },
  bar: { position: 'absolute', top: 0, left: 0, right: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.6)', transformOrigin: 'left' },
  action: {
    flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'center',
    paddingHorizontal: 10, minHeight: 32, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.15)',
  },
})
