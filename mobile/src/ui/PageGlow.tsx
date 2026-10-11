// The web's page glows (web/src/glow.css): a dark top and two slow-drifting
// colour lights rising from the bottom corners, one pair of colours per page.
// The lights are SVG gradients moved by transforms on the UI thread, and hold
// still when the phone asks for reduced motion.
import React, { useEffect } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import Animated, {
  cancelAnimation, Easing, interpolate, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming,
} from 'react-native-reanimated'
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg'

export type GlowPage = 'overview' | 'productivity' | 'inbox' | 'search' | 'settings'

const GLOWS: Record<GlowPage, { a: string; b: string; speed: number }> = {
  overview: { a: '#6633ee', b: '#4f46e5', speed: 28 },
  productivity: { a: '#10b981', b: '#0ea5e9', speed: 32 },
  inbox: { a: '#f59e0b', b: '#f43f5e', speed: 26 },
  search: { a: '#06b6d4', b: '#6366f1', speed: 30 },
  settings: { a: '#ec4899', b: '#8b5cf6', speed: 36 },
}

// An eased falloff; a straight one shows a band where the slope changes.
const FALLOFF: [number, number][] = [[0, 1], [0.14, 0.78], [0.28, 0.55], [0.42, 0.35], [0.56, 0.2], [0.7, 0.09], [0.84, 0.03], [1, 0]]

function Light({ id, color, cx, cy, rx, ry }: { id: string; color: string; cx: number; cy: number; rx: number; ry: number }) {
  return (
    <Svg style={StyleSheet.absoluteFill}>
      <Defs>
        <RadialGradient id={id} cx={cx} cy={cy} rx={rx} ry={ry} fx={cx} fy={cy}>
          {FALLOFF.map(([o, a]) => <Stop key={o} offset={o} stopColor={color} stopOpacity={a} />)}
        </RadialGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  )
}

// glow.css's keyframes, as [x %, y %, scale] at 0, 50 and 100 %.
const DRIFT_A = [[-7, 3, 1], [4, -4, 1.12], [9, 2, 1.04]]
const DRIFT_B = [[6, 2, 1.08], [-5, -5, 1], [-9, 1, 1.14]]

function useDrift(steps: number[][], seconds: number, w: number, h: number) {
  const reduced = useReducedMotion()
  const t = useSharedValue(0)
  useEffect(() => {
    if (reduced) return
    t.value = withRepeat(withTiming(1, { duration: seconds * 1000, easing: Easing.inOut(Easing.sin) }), -1, true)
  }, [reduced, seconds, t])
  return useAnimatedStyle(() => {
    const at = (i: number) => interpolate(t.value, [0, 0.5, 1], steps.map((s) => s[i]))
    return { transform: [{ translateX: (at(0) / 100) * w }, { translateY: (at(1) / 100) * h }, { scale: at(2) }] }
  })
}

/**
 * While `live` (an agent replying) the lights wobble and brighten (glow.css's
 * .live). The wobble pauses where it is when the reply ends, so nothing snaps.
 */
function useWobble(live: boolean) {
  const reduced = useReducedMotion()
  const w = useSharedValue(0)
  const glow = useSharedValue(0)
  useEffect(() => {
    glow.value = withTiming(live ? 1 : 0, { duration: 1200 })
    if (live && !reduced) w.value = withRepeat(withTiming(w.value < 0.5 ? 1 : 0, { duration: 1300, easing: Easing.inOut(Easing.sin) }), -1, true)
    else cancelAnimation(w)
  }, [live, reduced, w, glow])
  const wobble = useAnimatedStyle(() => ({
    transform: [
      { scale: interpolate(w.value, [0, 0.5, 1], [1, 1.08, 0.97]) },
      { rotate: `${interpolate(w.value, [0, 0.5, 1], [-1.5, 2.5, -1])}deg` },
    ],
  }))
  const lightA = useAnimatedStyle(() => ({ opacity: interpolate(glow.value, [0, 1], [0.95, 1]) }))
  const lightB = useAnimatedStyle(() => ({ opacity: interpolate(glow.value, [0, 1], [0.8, 1]) }))
  // A third, brighter copy of the main light fades in while live: brightness without a filter.
  const boost = useAnimatedStyle(() => ({ opacity: glow.value * 0.45 }))
  return { wobble, lightA, lightB, boost }
}

export function PageGlow({ page, colors, live = false }: {
  page?: GlowPage
  /** A chat's own pair (lib/chat/glow.ts) instead of a page's. */
  colors?: { a: string; b: string }
  live?: boolean
}) {
  const preset = page ? GLOWS[page] : GLOWS.overview
  const { a, b } = colors || preset
  const speed = preset.speed
  const { width, height } = useWindowDimensions()
  const driftA = useDrift(DRIFT_A, speed, width, height)
  const driftB = useDrift(DRIFT_B, speed * 1.3, width, height)
  const { wobble, lightA, lightB, boost } = useWobble(live)
  const key = `${page || 'chat'}-${a.slice(1)}-${b.slice(1)}`
  return (
    <View style={st.frame} pointerEvents="none">
      <Animated.View style={[st.fill, wobble]}>
        <Animated.View style={[st.light, lightA, driftA]}>
          <Light id={`glow-a-${key}`} color={a} cx={0.28} cy={1} rx={0.78} ry={0.66} />
        </Animated.View>
        <Animated.View style={[st.light, { mixBlendMode: 'screen' }, lightB, driftB]}>
          <Light id={`glow-b-${key}`} color={b} cx={0.76} cy={1.02} rx={0.7} ry={0.6} />
        </Animated.View>
        <Animated.View style={[st.light, { mixBlendMode: 'screen' }, boost, driftA]}>
          <Light id={`glow-c-${key}`} color={a} cx={0.28} cy={1} rx={0.6} ry={0.5} />
        </Animated.View>
      </Animated.View>
    </View>
  )
}

const st = StyleSheet.create({
  frame: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  light: { position: 'absolute', top: '-30%', left: '-30%', right: '-30%', bottom: '-30%' },
})
