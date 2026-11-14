// The app's side of landing on a search hit (src/lib/landing.ts): one hook a
// screen calls to scroll to the item once it can show it, and the flash drawn
// over that item. The web's twin is web/src/landing.ts.
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Dimensions, StyleSheet, type ScrollView, type View } from 'react-native'
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withTiming } from 'react-native-reanimated'
import { FLASH_MS, pendingLanding, pollLanding, subscribeLanding, type Landing } from '../lib/landing'
import { useSettings } from '../lib/settings'
import { alpha, colors } from '../theme'

/** Less motion: the system's setting or the app's own (Settings → Appearance). */
export function useStill() {
  const system = useReducedMotion()
  const app = useSettings().reduceMotion
  return system || app
}

/** The landing waiting for `kind`, as React state. */
export function useLanding(kind: string): Landing | null {
  return useSyncExternalStore(subscribeLanding, () => pendingLanding(kind), () => null)
}

/**
 * While a landing for `kind` waits and the screen is `ready` (focused, loaded),
 * `prepare` runs once (switch a tab, unfold a group, pick the list), then
 * `locate` is asked until it has scrolled to the item and names the key to
 * flash. Returns that key for about a second, for <LandFlash on={…} />.
 */
export function useLandOn(kind: string, { ready = true, delayMs, prepare, locate }: {
  ready?: boolean
  /** How long to let the screen settle before the first try (a chat opening at its end). */
  delayMs?: number
  prepare?: (landing: Landing) => void
  locate: (landing: Landing) => string | null
}): string | null {
  const landing = useLanding(kind)
  const [flashing, setFlashing] = useState<string | null>(null)
  const latest = useRef({ prepare, locate })
  latest.current = { prepare, locate }
  useEffect(() => {
    if (!landing || !ready) return undefined
    latest.current.prepare?.(landing)
    return pollLanding(landing, (l) => latest.current.locate(l), (key) => { if (key) setFlashing(key) }, delayMs ? { firstMs: delayMs } : undefined)
  }, [kind, landing, ready, delayMs])
  useEffect(() => {
    if (!flashing) return undefined
    const timer = setTimeout(() => setFlashing(null), FLASH_MS + 300)
    return () => clearTimeout(timer)
  }, [flashing])
  return flashing
}

/**
 * Scroll a ScrollView so `node` (inside `content`, the scroll's first child)
 * sits a little below the top: a smooth scroll when `animated` and it is within
 * about two screens of the top, a jump otherwise. False when it cannot be measured yet.
 */
export function scrollToNode(scroll: ScrollView | null, content: View | null, node: View | null | undefined, animated: boolean): boolean {
  if (!scroll || !content || !node) return false
  let ok = true
  const screen = Dimensions.get('window').height
  node.measureLayout(content as any, (_x, y) => { scroll.scrollTo({ y: Math.max(0, y - 120), animated: animated && y < 2 * screen }) }, () => { ok = false })
  return ok
}

/**
 * The flash over a landed item: an accent wash that fades after a beat (the
 * scroll lands first), or with less motion a still outline that goes when `on`
 * does. Put it last inside the item's own box (which must not clip it away);
 * `pad` reaches that far outside it, so text that runs to the box's edge has a margin.
 */
export function LandFlash({ on, radius = 12, pad = 0 }: { on: boolean; radius?: number; pad?: number }) {
  const still = useStill()
  const shown = useSharedValue(0)
  useEffect(() => {
    if (!on) { shown.value = 0; return }
    shown.value = 1
    if (!still) shown.value = withDelay(350, withTiming(0, { duration: FLASH_MS - 350 }))
  }, [on, still, shown])
  const style = useAnimatedStyle(() => ({ opacity: shown.value }))
  if (!on) return null
  return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, pad ? { top: -pad, left: -pad, right: -pad, bottom: -pad } : null, { borderRadius: radius }, still ? st.still : st.wash, style]} />
}

const st = StyleSheet.create({
  wash: { backgroundColor: alpha(colors.accent, 0.16), borderWidth: 1, borderColor: alpha(colors.accent, 0.55) },
  still: { borderWidth: 2, borderColor: alpha(colors.accent, 0.7) },
})
