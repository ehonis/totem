// The waveform under the record button (web/src/journal/Waveform.tsx).
//
// Same two jobs: prove the microphone is hearing you while recording, and show
// the whole take's envelope before Save so a flatline is visible. Same geometry
// (3px bars, 2px gaps, a hairline rail through the middle).
//
// The web draws on a canvas; here each bar is a view whose height is a Reanimated
// shared value. The live loop reads the recorder's refs every SAMPLE_MS and writes
// one shared array, so a moving waveform costs no React renders, as on the web.
import React, { useEffect, useMemo, useState } from 'react'
import type { MutableRefObject } from 'react'
import { View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated'
import { colors } from '../../theme'
import { SAMPLE_MS } from './useRecorder'

const BAR_W = 3
const GAP = 2
const PITCH = BAR_W + GAP
const MIN_BAR = 2

/**
 * Squash an arbitrary-length envelope into exactly `bars` buckets, keeping peaks.
 * A live waveform pads (bars arrive at the right and march left); a finished take
 * stretches to the whole width. Verbatim from the web.
 */
export function bucket(samples: number[], bars: number, short: 'pad' | 'stretch' = 'pad'): number[] {
  if (bars <= 0) return []
  if (!samples.length) return new Array(bars).fill(0)
  if (samples.length <= bars) {
    if (short === 'pad') return [...new Array(bars - samples.length).fill(0), ...samples]
    return Array.from({ length: bars }, (_, i) => samples[Math.min(samples.length - 1, Math.floor((i * samples.length) / bars))])
  }
  const out = new Array(bars).fill(0)
  const per = samples.length / bars
  for (let i = 0; i < bars; i += 1) {
    const from = Math.floor(i * per)
    const to = Math.max(from + 1, Math.floor((i + 1) * per))
    let peak = 0
    for (let j = from; j < to && j < samples.length; j += 1) if (samples[j] > peak) peak = samples[j]
    out[i] = peak
  }
  return out
}

interface WaveformProps {
  /** Live amplitude history, newest last. Ignored when `samples` is given. */
  samplesRef?: MutableRefObject<number[]>
  levelRef?: MutableRefObject<number>
  /** A finished recording's envelope, drawn whole. Switches off the loop. */
  samples?: number[]
  live?: boolean
  paused?: boolean
  height?: number
  /** Written with the live level each tick, for the button's halo. */
  halo?: SharedValue<number>
  /** Bar colour when not live (the review uses the accent). */
  idleColor?: string
  label?: string
}

function Bar({ i, heights, usable, color }: { i: number; heights: SharedValue<number[]>; usable: number; color: string }) {
  const style = useAnimatedStyle(() => ({ height: Math.max(MIN_BAR, Math.min(1, heights.value[i] || 0) * usable) }))
  return <Animated.View style={[{ width: BAR_W, borderRadius: BAR_W / 2, backgroundColor: color }, style]} />
}

export default function Waveform({
  samplesRef, levelRef, samples, live = false, paused = false, height = 56, halo, idleColor = colors.muted, label,
}: WaveformProps) {
  const [width, setWidth] = useState(0)
  const bars = Math.max(1, Math.floor((width + GAP) / PITCH))
  const usable = height - 6
  const heights = useSharedValue<number[]>([])
  const color = live && !paused ? colors.red : idleColor

  const staticData = useMemo(() => (samples ? bucket(samples, bars, 'stretch') : null), [samples, bars])

  useEffect(() => {
    if (staticData) { heights.value = staticData; return }
    const draw = () => {
      heights.value = bucket((samplesRef?.current || []).slice(-bars), bars, 'pad')
      if (halo) halo.value = paused || !live ? 0 : levelRef?.current || 0
    }
    draw()
    if (!live || paused) return
    // Paused freezes the bars where they are, as a paused recording should look.
    const t = setInterval(draw, SAMPLE_MS)
    return () => clearInterval(t)
  }, [staticData, live, paused, bars, samplesRef, levelRef, halo, heights])

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={label || (live ? 'Live microphone level' : 'Recording waveform')}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ height, width: '100%', justifyContent: 'center', opacity: paused ? 0.7 : 1 }}
    >
      {/* The rail: a silent stretch still reads as "quiet", not as broken. */}
      <View style={{ position: 'absolute', left: 0, right: 0, top: height / 2 - 0.5, height: 1, backgroundColor: colors.line }} />
      {width > 0 && (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: GAP, height }}>
          {Array.from({ length: bars }, (_, i) => <Bar key={i} i={i} heights={heights} usable={usable} color={color} />)}
        </View>
      )}
    </View>
  )
}
