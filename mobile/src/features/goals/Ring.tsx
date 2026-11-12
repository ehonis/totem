// A progress ring (#180): the goal's icon or a period's count in the middle, the
// arc drawn clockwise from 12 o'clock and eased to each new value, so logging
// progress visibly moves it. Reduce Motion sets the arc without the ease.
import React, { useEffect } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import Animated, { Easing, useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated'
import { colors } from '../../theme'
import { ringOffset } from './summary'
import { useCalm } from '../habits/motion'

const AnimatedCircle = Animated.createAnimatedComponent(Circle)

export default function Ring({ percent, color, size = 44, stroke = 4, track = colors.bg3, children, style }: {
  /** 0–100; null draws the empty track. */
  percent: number | null
  color: string
  size?: number
  stroke?: number
  track?: string
  children?: React.ReactNode
  style?: StyleProp<ViewStyle>
}) {
  const reduced = useCalm()
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r
  const offset = useSharedValue(ringOffset(percent, circumference))
  useEffect(() => {
    const target = ringOffset(percent, circumference)
    offset.value = reduced ? target : withTiming(target, { duration: 600, easing: Easing.out(Easing.cubic) })
  }, [percent, circumference, reduced, offset])
  const arc = useAnimatedProps(() => ({ strokeDashoffset: offset.value }))
  const show = (percent ?? 0) > 0
  return (
    <View style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}>
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        {show && (
          <AnimatedCircle
            cx={size / 2} cy={size / 2} r={r}
            stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round"
            strokeDasharray={`${circumference} ${circumference}`}
            animatedProps={arc}
          />
        )}
      </Svg>
      {children}
    </View>
  )
}
