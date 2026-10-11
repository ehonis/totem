// The web's page glows (web/src/glow.css): a dark top and two slow-drifting
// colour lights rising from the bottom corners, one pair of colours per page.
// The lights are SVG gradients moved by transforms on the UI thread, and hold
// still when the phone asks for reduced motion.
import React, { useEffect } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import Animated, {
  Easing, interpolate, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming,
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

export function PageGlow({ page }: { page: GlowPage }) {
  const { a, b, speed } = GLOWS[page]
  const { width, height } = useWindowDimensions()
  const driftA = useDrift(DRIFT_A, speed, width, height)
  const driftB = useDrift(DRIFT_B, speed * 1.3, width, height)
  return (
    <View style={st.frame} pointerEvents="none">
      <Animated.View style={[st.light, { opacity: 0.95 }, driftA]}>
        <Light id={`glow-a-${page}`} color={a} cx={0.28} cy={1} rx={0.78} ry={0.66} />
      </Animated.View>
      <Animated.View style={[st.light, { opacity: 0.8, mixBlendMode: 'screen' }, driftB]}>
        <Light id={`glow-b-${page}`} color={b} cx={0.76} cy={1.02} rx={0.7} ry={0.6} />
      </Animated.View>
    </View>
  )
}

const st = StyleSheet.create({
  frame: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' },
  light: { position: 'absolute', top: '-30%', left: '-30%', right: '-30%', bottom: '-30%' },
})
