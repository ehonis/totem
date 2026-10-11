// A soft haptic tap as each burst of a reply appears, the way ChatGPT's app taps
// while it types. web/src/chat/ticks.ts does the same with navigator.vibrate.
import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import { typeTick } from '../../ui/haptics'

const GAP_MS = 70

export function useTextTicks(shown: string) {
  const len = useRef(shown.length)
  const last = useRef(0)
  useEffect(() => {
    const grew = shown.length > len.current
    len.current = shown.length
    if (!grew || AppState.currentState !== 'active') return
    const now = Date.now()
    if (now - last.current < GAP_MS) return
    last.current = now
    typeTick()
  }, [shown])
}
