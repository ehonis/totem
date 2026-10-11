// The voice orb (chat.css .vc-orb): a lit sphere that breathes while it
// listens, swells while you talk, pulses with a ring while it thinks and sways
// while it speaks. Animated from the call's phase, never from the audio (the
// web learned that the hard way; on the phone there is no mic level to read).
// Reanimated's CSS animations take the web's keyframes nearly as written.
import React from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { type CSSAnimationKeyframes } from 'react-native-reanimated'
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg'
import { Press } from '../../ui/kit'

export type OrbPhase = 'starting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'paused' | 'error'

// The web's phone size (@media max-width 720px).
export const ORB_SIZE = 170

const THINK: CSSAnimationKeyframes = { '0%': { transform: [{ scale: 0.8 }] }, '50%': { transform: [{ scale: 0.88 }] }, '100%': { transform: [{ scale: 0.8 }] } }
const RING: CSSAnimationKeyframes = { from: { transform: [{ scale: 0.9 }], opacity: 0.9 }, to: { transform: [{ scale: 1.25 }], opacity: 0 } }
const SPEAK: CSSAnimationKeyframes = {
  '0%': { transform: [{ scale: 0.9 }, { rotate: '0deg' }] },
  '33%': { transform: [{ scale: 0.98 }, { rotate: '6deg' }] },
  '66%': { transform: [{ scale: 0.93 }, { rotate: '-4deg' }] },
  '100%': { transform: [{ scale: 0.9 }, { rotate: '0deg' }] },
}
const IDLE: CSSAnimationKeyframes = { '0%': { transform: [{ scale: 0.84 }] }, '50%': { transform: [{ scale: 0.88 }] }, '100%': { transform: [{ scale: 0.84 }] } }
const HEAR: CSSAnimationKeyframes = { '0%': { transform: [{ scale: 0.94 }] }, '50%': { transform: [{ scale: 1.04 }] }, '100%': { transform: [{ scale: 0.94 }] } }

const MOTION: Partial<Record<OrbPhase, { name: CSSAnimationKeyframes; duration: number }>> = {
  listening: { name: IDLE, duration: 3200 },
  hearing: { name: HEAR, duration: 900 },
  thinking: { name: THINK, duration: 1600 },
  speaking: { name: SPEAK, duration: 1100 },
}
// Phases that hold still, dimmed (.phase-starting/.phase-paused/.phase-error).
const STILL: Partial<Record<OrbPhase, number>> = { starting: 0.78, paused: 0.78, error: 0.75 }

// radial-gradient(circle at 35% 30%, …) and the same stops through the web's
// filters: saturate(.2) brightness(.6) for starting/paused, grayscale(1)
// brightness(.5) for error. React Native's filter can't saturate on iOS, so the
// dimmed versions are their own gradients, faded in over the lit one.
const LIT = ['#cfe0ff', '#6d93ff', '#6a4dff', '#2b2a7a']
const DIM = ['#838589', '#555966', '#3f3b51', '#1d1d27']
const GREY = ['#6f6f6f', '#4b4b4b', '#353535', '#191919']

function Sphere({ id, stops, opacity = 1 }: { id: string; stops: string[]; opacity?: number }) {
  return (
    <Animated.View style={[StyleSheet.absoluteFill, { opacity, transitionProperty: 'opacity', transitionDuration: 200 }]} pointerEvents="none">
      <Svg width="100%" height="100%" viewBox="0 0 100 100">
        <Defs>
          <RadialGradient id={id} cx="35%" cy="30%" r="80%" fx="35%" fy="30%">
            <Stop offset="0" stopColor={stops[0]} />
            <Stop offset="0.32" stopColor={stops[1]} />
            <Stop offset="0.68" stopColor={stops[2]} />
            <Stop offset="1" stopColor={stops[3]} />
          </RadialGradient>
        </Defs>
        <Circle cx="50" cy="50" r="50" fill={`url(#${id})`} />
      </Svg>
    </Animated.View>
  )
}

export function Orb({ phase, onPress, label }: { phase: OrbPhase; onPress: () => void; label: string }) {
  const motion = MOTION[phase]
  const still = STILL[phase]
  return (
    <Press onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={st.orb}>
      {phase === 'thinking' ? (
        <Animated.View
          pointerEvents="none"
          style={[st.ring, { animationName: RING, animationDuration: 1600, animationIterationCount: 'infinite', animationTimingFunction: 'ease-out' }]}
        />
      ) : null}
      <Animated.View
        style={[
          st.core,
          motion
            ? { animationName: motion.name, animationDuration: motion.duration, animationIterationCount: 'infinite', animationTimingFunction: 'ease-in-out' }
            : { transform: [{ scale: still ?? 0.82 }], transitionProperty: 'transform', transitionDuration: 200 },
        ]}
      >
        <View style={st.clip}>
          <Sphere id="orb-lit" stops={LIT} />
          <Sphere id="orb-dim" stops={DIM} opacity={phase === 'starting' || phase === 'paused' ? 1 : 0} />
          <Sphere id="orb-grey" stops={GREY} opacity={phase === 'error' ? 1 : 0} />
          {/* inset 0 -18px 40px #1b1a5a99: the shade under the sphere. */}
          <View pointerEvents="none" style={st.shade} />
        </View>
      </Animated.View>
    </Press>
  )
}

const st = StyleSheet.create({
  orb: { width: ORB_SIZE, height: ORB_SIZE, flexShrink: 0 },
  core: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: ORB_SIZE / 2, boxShadow: '0 0 80px #5b8cff55' },
  clip: { flex: 1, borderRadius: ORB_SIZE / 2, overflow: 'hidden' },
  shade: { ...StyleSheet.absoluteFill, borderRadius: ORB_SIZE / 2, boxShadow: 'inset 0 -18px 40px #1b1a5a99' },
  ring: { position: 'absolute', top: -14, left: -14, right: -14, bottom: -14, borderRadius: (ORB_SIZE + 28) / 2, borderWidth: 1, borderColor: '#8fb0ff30' },
})
