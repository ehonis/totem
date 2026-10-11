// Swipe left/right to move a period. A horizontal ScrollView exactly one page
// wide that always bounces: a drag rubber-bands the calendar under the finger,
// letting go past the threshold steps the period, and the new period slides in
// from the side it came from. Being a native scroll view, it locks to one axis,
// so the time grid inside still scrolls vertically.
import React, { useState } from 'react'
import { ScrollView, View } from 'react-native'
import Animated, { SlideInLeft, SlideInRight } from 'react-native-reanimated'

const THRESHOLD = 48

export default function SwipePeriods({ periodKey, dir, onStep, children }: {
  /** Changes when the period does; remounts the page so it can slide in. */
  periodKey: string
  /** The direction of the last step: -1, 1, or 0 for a jump (Today, a view switch). */
  dir: number
  onStep: (dir: -1 | 1) => void
  children: React.ReactNode
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const entering = dir > 0 ? SlideInRight.duration(220) : dir < 0 ? SlideInLeft.duration(220) : undefined
  return (
    <View style={{ flex: 1 }} onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      {size ? (
        <ScrollView
          horizontal
          bounces
          alwaysBounceHorizontal
          alwaysBounceVertical={false}
          directionalLockEnabled
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onScrollEndDrag={(e) => {
            const x = e.nativeEvent.contentOffset.x
            if (x <= -THRESHOLD) onStep(-1)
            else if (x >= THRESHOLD) onStep(1)
          }}
          style={{ flex: 1 }}
        >
          <Animated.View key={periodKey} entering={entering} style={{ width: size.w, height: size.h }}>
            {children}
          </Animated.View>
        </ScrollView>
      ) : null}
    </View>
  )
}
