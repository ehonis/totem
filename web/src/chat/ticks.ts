// A light tick as each burst of a reply appears, the way ChatGPT's app taps
// while it types. Only phones that let a web page vibrate feel it (Android;
// iOS Safari has no vibration API). mobile/src/lib/chat/ticks.ts does the same
// with real haptics.
import { useEffect, useRef } from 'react'

const GAP_MS = 70

export function useTextTicks(shown: string) {
  const len = useRef(shown.length)
  const last = useRef(0)
  useEffect(() => {
    const grew = shown.length > len.current
    len.current = shown.length
    if (!grew || document.visibilityState !== 'visible') return
    const now = performance.now()
    if (now - last.current < GAP_MS) return
    last.current = now
    navigator.vibrate?.(4)
  }, [shown])
}
