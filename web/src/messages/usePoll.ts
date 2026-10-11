import { useEffect, useRef } from 'react'

/**
 * Call `fn` every `ms` while the page is visible, and once straight away when
 * it becomes visible again. A hidden tab (phone locked, another app in front)
 * polls nothing. `fn` is read through a ref, so a new closure each render does
 * not restart the timer.
 */
export function usePoll(fn: () => void, ms: number, enabled = true) {
  const latest = useRef(fn)
  latest.current = fn
  useEffect(() => {
    if (!enabled) return
    const tick = () => { if (document.visibilityState === 'visible') latest.current() }
    const timer = setInterval(tick, ms)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [ms, enabled])
}
