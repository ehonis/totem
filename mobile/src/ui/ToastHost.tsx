// The web's ToastHost (components/ToastHost.tsx) on a phone: one solid fill per
// kind, white text, full width above the home indicator. Reads the same toast
// store (lib/toast.ts) so ported code that calls pushError() just works.
import React, { useEffect } from 'react'
import { View, StyleSheet } from 'react-native'
import Animated, { FadeInDown, FadeOutDown, cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useToasts, dismissToast, pauseToast, resumeToast, type Toast } from '../lib/toast'
import { Hi, XMarkIcon, ArrowUturnLeftIcon, ExclamationTriangleIcon, CheckCircleIcon, InformationCircleIcon } from '../lib/icons'
import { colors } from '../theme'
import { T } from './Text'
import { Press } from './kit'
import { success, warn } from './haptics'

const ICONS = { error: ExclamationTriangleIcon, success: CheckCircleIcon, info: InformationCircleIcon }
const FILL = { error: colors.toastError, success: colors.toastSuccess, info: colors.toastInfo }

/** Time left on screen, flush with the top edge; holds while the toast is touched. */
function Countdown({ duration, held }: { duration: number; held: boolean }) {
  const left = useSharedValue(1)
  useEffect(() => {
    if (held) { cancelAnimation(left); return }
    left.value = withTiming(0, { duration: duration * left.value, easing: Easing.linear })
  }, [held, duration, left])
  const style = useAnimatedStyle(() => ({ transform: [{ scaleX: left.value }] }))
  return <Animated.View pointerEvents="none" style={[st.bar, style]} />
}

function Item({ t }: { t: Toast }) {
  const [held, setHeld] = React.useState(false)
  useEffect(() => { if (t.kind === 'error') warn(); else if (t.kind === 'success') success() }, [t.kind])
  const ActionIcon = t.action?.icon === null ? null : t.action?.icon || ArrowUturnLeftIcon
  return (
    <Animated.View
      entering={FadeInDown.duration(180)}
      exiting={FadeOutDown.duration(150)}
      onTouchStart={() => { setHeld(true); pauseToast(t.id) }}
      onTouchEnd={() => { setHeld(false); resumeToast(t.id) }}
      onTouchCancel={() => { setHeld(false); resumeToast(t.id) }}
      style={[st.toast, { backgroundColor: FILL[t.kind] || FILL.error }]}
    >
      {t.duration > 0 ? <Countdown duration={t.duration} held={held} /> : null}
      <Hi icon={ICONS[t.kind] || ICONS.error} size={16} color={colors.white} style={{ marginTop: 1 }} />
      <T size={14} color={colors.white} style={{ flex: 1 }}>{t.text}</T>
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
  )
}

export default function ToastHost() {
  const toasts = useToasts()
  const insets = useSafeAreaInsets()
  if (!toasts.length) return null
  return (
    <View pointerEvents="box-none" style={[st.wrap, { bottom: insets.bottom + 12 }]}>
      {toasts.map((t) => <Item key={t.id} t={t} />)}
    </View>
  )
}

const st = StyleSheet.create({
  wrap: { position: 'absolute', left: 12, right: 12, gap: 8, flexDirection: 'column-reverse', zIndex: 1000 },
  toast: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingTop: 14, paddingBottom: 12, paddingLeft: 14, paddingRight: 12,
    borderRadius: 12, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 8 },
  },
  bar: { position: 'absolute', top: 0, left: 0, right: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.6)', transformOrigin: 'left' },
  action: {
    flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'center',
    paddingHorizontal: 10, minHeight: 32, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.15)',
  },
})
