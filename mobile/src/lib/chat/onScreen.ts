// Which chats are in front of the owner right now, so the running-chats panel
// (RunningChats.tsx) lists only the ones he can't already see.
//
// Two ways a chat is on screen: it is open in the chat view
// (`setViewing`), or its row in a list (the chats panel, a project page) is at
// least half inside the viewport. Rows are watched with one IntersectionObserver,
// which already accounts for a folded panel (no row), a scrolled list (clipped
// by its scroller) and the phone drawer slid off screen (transformed away).
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

const rows = new Map<Element, string>()
const seen = new Set<Element>()
const viewing: Record<string, string | null> = {}
const subs = new Set<() => void>()
let page: string | null = null
let snapshot: { rows: Set<string>; open: Set<string>; page: string | null } = { rows: new Set(), open: new Set(), page: null }

function emit() {
  const open = new Set(Object.values(viewing).filter((id): id is string => !!id))
  const shown = new Set<string>()
  for (const el of seen) { const id = rows.get(el); if (id) shown.add(id) }
  for (const id of open) shown.add(id)
  snapshot = { rows: shown, open, page }
  subs.forEach((fn) => fn())
}

const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting && e.intersectionRatio >= 0.5) seen.add(e.target)
    else seen.delete(e.target)
  }
  emit()
}, { threshold: [0, 0.5, 1] })

/** A ref for a chat's row in any list: while half of it is on screen, so is the chat. */
export function useRowOnScreen(id: string) {
  const el = useRef<Element | null>(null)
  const idRef = useRef(id)
  idRef.current = id
  useEffect(() => { if (el.current) rows.set(el.current, id) }, [id])
  return useCallback((node: Element | null) => {
    if (el.current) {
      observer?.unobserve(el.current)
      rows.delete(el.current)
      if (seen.delete(el.current)) emit()
    }
    el.current = node
    if (node) { rows.set(node, idRef.current); observer?.observe(node) }
  }, [])
}

/** A surface showing one chat in full ('main' is the chat view). */
export function useViewing(source: string, id: string | null) {
  useEffect(() => {
    viewing[source] = id
    emit()
    return () => { viewing[source] = null; emit() }
  }, [source, id])
}

/** A project or folder page (ProjectHome) is showing, listing that place's chats. */
export function useProjectPage(id: string) {
  useEffect(() => {
    page = id
    emit()
    return () => { if (page === id) page = null; emit() }
  }, [id])
}

const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } }

/** Chats on screen anywhere (`rows`), the ones open in full (`open`), and the project page showing (`page`). */
export function useOnScreen() {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
}

export const getOnScreen = () => snapshot
