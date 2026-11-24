// The drawer's Undo line, drawn in its foot (AppDrawer) rather than in the list:
// a row removed halfway down a long drawer would otherwise take its Undo out of
// sight with it. One line at a time, as on the Tasks page (undo.ts). A discarded
// draft's line (features/chat/appDrafts.ts) shows here.
import React, { useCallback, useSyncExternalStore } from 'react'
import { View } from 'react-native'
import { UndoLine, type UndoState } from '../todos/detail/bits'

let line: UndoState | null = null
const subs = new Set<() => void>()
const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } }

export function showUndo(next: UndoState | null) {
  const was = line
  line = next
  subs.forEach((fn) => fn())
  // A pressed line is closed before its action runs; onGone waits for that.
  if (was?.onGone && was !== next) setTimeout(was.onGone, 0)
}

export function DockedUndo() {
  const undo = useSyncExternalStore(subscribe, () => line, () => line)
  const done = useCallback(() => showUndo(null), [])
  if (!undo) return null
  return <View style={{ paddingTop: 8 }}><UndoLine undo={undo} onDone={done} /></View>
}
