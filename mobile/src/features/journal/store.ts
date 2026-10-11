// What the Journal view shares with its sheets (settings, transcript editor): the
// last settings it loaded, and the changes they make, so the list updates without
// another round-trip. Same shape as calendar/eventStore.ts.
import type { JournalEntry, JournalSettings } from '../../lib/journal/types'

let settings: JournalSettings | null = null
const entrySubs = new Set<(e: JournalEntry) => void>()
const settingsSubs = new Set<(s: JournalSettings) => void>()

export const getCachedSettings = () => settings
export const cacheSettings = (next: JournalSettings) => { settings = next }

export function emitSettingsChanged(next: JournalSettings) {
  settings = next
  settingsSubs.forEach((fn) => fn(next))
}
export function onSettingsChanged(fn: (s: JournalSettings) => void) {
  settingsSubs.add(fn)
  return () => { settingsSubs.delete(fn) }
}

export const emitEntryChanged = (entry: JournalEntry) => entrySubs.forEach((fn) => fn(entry))
export function onEntryChanged(fn: (e: JournalEntry) => void) {
  entrySubs.add(fn)
  return () => { entrySubs.delete(fn) }
}
