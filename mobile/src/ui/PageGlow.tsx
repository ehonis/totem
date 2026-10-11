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
 * While `live` (an agent replying) the lights swing, slide and pulse (glow.css's
 * --glow-amp). Three phases loop at different speeds and `amp` scales how far
 * they move, rising when a reply starts and falling after, so the motion swells
 * in and dies away rather than switching.
 */
function useLiveSwing(live: boolean) {
  const reduced = useReducedMotion()
  const amp = useSharedValue(0)
  const w = useSharedValue(0)
  const v = useSharedValue(0)
  const p = useSharedValue(0)
  useEffect(() => {
    amp.value = withTiming(live ? 1 : 0, { duration: 1100 })
    if (reduced) return
    const loop = (sv: typeof w, from: number, to: number, ms: number) => {
      sv.value = from
      sv.value = withRepeat(withTiming(to, { duration: ms, easing: Easing.inOut(Easing.sin) }), -1, true)
    }
    if (live) {
      loop(w, -1, 1, 1700); loop(v, 1, -1, 2300); loop(p, 0, 1, 1100)
      return
    }
    // Let the swing die away with amp, then stop the loops.
    const t = setTimeout(() => { cancelAnimation(w); cancelAnimation(v); cancelAnimation(p) }, 1200)
    return () => clearTimeout(t)
  }, [live, reduced, amp, w, v, p])
  const { width, height } = useWindowDimensions()
  const swingA = useAnimatedStyle(() => ({
    transform: [
      { translateX: amp.value * 0.09 * v.value * width },
      { translateY: amp.value * -0.07 * w.value * height },
      { scale: 1 + amp.value * 0.22 * w.value },
      { rotate: `${amp.value * 8 * v.value}deg` },
    ],
  }))
  const swingB = useAnimatedStyle(() => ({
    transform: [
      { translateX: amp.value * -0.1 * w.value * width },
      { translateY: amp.value * -0.06 * v.value * height },
      { scale: 1 - amp.value * 0.2 * v.value },
      { rotate: `${amp.value * -9 * w.value}deg` },
    ],
  }))
  // A brighter copy of the main light pulses in while live: brightness without a filter.
  const boost = useAnimatedStyle(() => ({ opacity: amp.value * (0.3 + 0.5 * p.value) }))
  return { swingA, swingB, boost }
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
  const { swingA, swingB, boost } = useLiveSwing(live)
  const key = `${page || 'chat'}-${a.slice(1)}-${b.slice(1)}`
  return (
    <View style={st.frame} pointerEvents="none">
      <Animated.View style={[st.light, { opacity: 0.95 }, driftA]}>
        <Animated.View style={[st.fill, swingA]}>
          <Light id={`glow-a-${key}`} color={a} cx={0.28} cy={1} rx={0.78} ry={0.66} />
        </Animated.View>
      </Animated.View>
      <Animated.View style={[st.light, { opacity: 0.8, mixBlendMode: 'screen' }, driftB]}>
        <Animated.View style={[st.fill, swingB]}>
          <Light id={`glow-b-${key}`} color={b} cx={0.76} cy={1.02} rx={0.7} ry={0.6} />
        </Animated.View>
      </Animated.View>
      <Animated.View style={[st.light, { mixBlendMode: 'screen' }, boost, driftA]}>
        <Animated.View style={[st.fill, swingA]}>
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
