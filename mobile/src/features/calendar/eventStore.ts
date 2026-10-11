// Hands the tapped event to the detail sheet (src/app/calendar/event.tsx) and the
// saved event back to the calendar. A route param would have to round-trip the
// whole event through a string; this is the same object the grid already holds.
import { router } from 'expo-router'
import type { CalEvent } from './dates'

let selected: CalEvent | null = null
const savedSubs = new Set<(ev: CalEvent) => void>()

export function openEvent(ev: CalEvent) {
  selected = ev
  router.push('/calendar/event')
}

export const getSelectedEvent = () => selected

export function emitEventSaved(ev: CalEvent) {
  selected = ev
  savedSubs.forEach((fn) => fn(ev))
}

export function onEventSaved(fn: (ev: CalEvent) => void) {
  savedSubs.add(fn)
  return () => { savedSubs.delete(fn) }
}
