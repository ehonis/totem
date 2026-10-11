// Small pieces the Journal screens share: the spinning glyph (.spin), the audio
// player that stands in for <audio controls>, and a select that opens a native menu.
import React, { useEffect, useMemo, useRef } from 'react'
import { Platform, StyleSheet, View } from 'react-native'
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import { useAudioPlayer, useAudioPlayerStatus, type AudioSource } from 'expo-audio'
import { MenuView } from '@react-native-menu/menu'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { showMenu } from '../../ui/menu'
import { tap } from '../../ui/haptics'
import { ChevronDownIcon, Hi, PauseIcon, PlayIcon, type IconType } from '../../lib/icons'
import { fmtClock } from '../../lib/journal/format'

/** An icon that turns, for "Transcribing…" and "Saving…". */
export function Spin({ icon, size = 12, color }: { icon: IconType; size?: number; color?: string }) {
  const turn = useSharedValue(0)
  useEffect(() => {
    turn.value = withRepeat(withTiming(360, { duration: 900, easing: Easing.linear }), -1, false)
    return () => cancelAnimation(turn)
  }, [turn])
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value}deg` }] }))
  return <Animated.View style={style}><Hi icon={icon} size={size} color={color} /></Animated.View>
}

/**
 * Play / pause, a seekable track and the clock: what `<audio controls>` gives the
 * web. The source may carry headers (the bridge's audio route is bearer authed).
 */
export function AudioBar({ source, autoPlay = false }: { source: AudioSource; autoPlay?: boolean }) {
  const player = useAudioPlayer(source)
  const trackW = useRef(0)
  const status = useAudioPlayerStatus(player)
  useEffect(() => { if (autoPlay) player.play() }, [autoPlay, player])
  const duration = status.duration || 0
  const progress = duration ? Math.min(1, status.currentTime / duration) : 0
  const toggle = () => {
    tap()
    if (status.playing) player.pause()
    else {
      if (duration && status.currentTime >= duration - 0.05) player.seekTo(0)
      player.play()
    }
  }
  return (
    <View style={st.bar}>
      <Press onPress={toggle} hitSlop={8} accessibilityLabel={status.playing ? 'Pause' : 'Play'} style={st.play}>
        <Hi icon={status.playing ? PauseIcon : PlayIcon} size={16} color={colors.text} />
      </Press>
      <Press
        style={st.track}
        onPress={(e) => { if (duration && trackW.current) player.seekTo((e.nativeEvent.locationX / trackW.current) * duration) }}
        onLayout={(e) => { trackW.current = e.nativeEvent.layout.width }}
      >
        <View style={st.rail}><View style={[st.fill, { width: `${progress * 100}%` }]} /></View>
      </Press>
      <T size={12} muted style={{ fontVariant: ['tabular-nums'] }}>
        {fmtClock(status.currentTime)} / {status.isLoaded ? fmtClock(duration) : '–:––'}
      </T>
    </View>
  )
}

export interface SelectOption { value: string; label: string }

/**
 * A <select>: shows the current choice and opens a native menu of the options
 * (a UIMenu on iOS, an action sheet elsewhere).
 */
export function SelectField({ value, options, onChange, disabled, title }: {
  value: string
  options: SelectOption[]
  onChange: (v: string) => void
  disabled?: boolean
  title?: string
}) {
  const current = options.find((o) => o.value === value)?.label ?? value
  const actions = useMemo(
    () => options.map((o) => ({ id: o.value || '__default', title: o.label, state: o.value === value ? ('on' as const) : ('off' as const) })),
    [options, value],
  )
  const face = (
    <View style={[st.select, disabled && { opacity: 0.5 }]}>
      <T numberOfLines={1} style={{ flex: 1 }}>{current}</T>
      <Hi icon={ChevronDownIcon} size={14} color={colors.muted} />
    </View>
  )
  if (disabled) return face
  if (Platform.OS === 'ios') {
    return (
      <MenuView
        title={title}
        actions={actions}
        themeVariant="dark"
        onPressAction={({ nativeEvent }) => { tap(); onChange(nativeEvent.event === '__default' ? '' : nativeEvent.event) }}
      >
        {face}
      </MenuView>
    )
  }
  return (
    <Press onPress={() => showMenu(options.map((o) => ({ label: o.label, onPress: () => onChange(o.value) })), { title })}>
      {face}
    </Press>
  )
}

const st = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 10, height: 40, paddingHorizontal: 10,
    backgroundColor: colors.bg3, borderRadius: 8, borderWidth: 1, borderColor: colors.line,
  },
  play: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  track: { flex: 1, height: 28, justifyContent: 'center' },
  rail: { height: 4, borderRadius: 2, backgroundColor: colors.line, overflow: 'hidden' },
  fill: { height: 4, backgroundColor: colors.accent },
  select: {
    flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingHorizontal: 10,
  },
})

