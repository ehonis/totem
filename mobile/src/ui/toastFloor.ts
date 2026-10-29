// What the toast deck has to sit above at the bottom of the screen. The open
// chat registers its dock (composer and what rides on it), the floating voice and
// new-chat buttons register themselves, each only while their screen is focused.
// ToastHost adds the keyboard on top.
import { useSyncExternalStore } from 'react'

export type ToastFloor = {
  /** Height of the chat's dock from the bottom edge, keyboard down; 0 when no chat is open. */
  dock: number
  /** How much of the keyboard the dock's own bottom gap already absorbs. */
  lift: number
  /** The floating buttons are in the bottom-right corner. */
  fab: boolean
}

let floor: ToastFloor = { dock: 0, lift: 0, fab: false }
const subs = new Set<() => void>()

export function setToastFloor(patch: Partial<ToastFloor>) {
  const next = { ...floor, ...patch }
  if (next.dock === floor.dock && next.lift === floor.lift && next.fab === floor.fab) return
  floor = next
  subs.forEach((fn) => fn())
}

const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } }
export const useToastFloor = () => useSyncExternalStore(subscribe, () => floor, () => floor)
