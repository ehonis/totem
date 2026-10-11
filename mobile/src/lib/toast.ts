// Global toast notifications. Any module can call pushToast(...) - typically from
// an error path - and <ToastHost/> (mounted once in App) renders them in the
// bottom-left corner. This is a tiny external store so non-React code (and
// components without a shared parent) can raise toasts without prop drilling.
import { useSyncExternalStore, useEffect, type ComponentType } from 'react'

export type ToastKind = 'error' | 'success' | 'info'

// An optional inline button on a toast - used for "Undo" on reversible actions.
// The toast dismisses itself once the handler is invoked.
export interface ToastAction {
  label: string
  onClick: () => void | Promise<void>
  /** The button's glyph; Undo's arrow by default, null for none. */
  icon?: ComponentType<any> | null
}

export interface Toast {
  id: number
  text: string
  kind: ToastKind
  action?: ToastAction
  /** How long it stays, in ms; 0 until dismissed. The bar along its top counts this down. */
  duration: number
  /** How many times this same message arrived; repeats join one toast (×3) instead of stacking. */
  count: number
}

// Toasts are a deck, as in T3 Code: the newest in front, a couple peeking behind,
// spread out while hovered or tapped. Short-lived, and errors a little longer.
const DEFAULT_MS = { error: 5000, success: 3500, info: 3500 } as const
/** Older toasts past this are dropped rather than piling up behind the deck. */
const KEEP = 5

let toasts: Toast[] = []
const listeners = new Set<() => void>()
let seq = 0
// Each timed toast's timer, and how long it had left when a hover paused it.
const timers = new Map<number, { handle: ReturnType<typeof setTimeout> | null; endsAt: number; left: number }>()

function emit() {
  for (const fn of listeners) fn()
}

// kind is 'error' | 'success' | 'info'. duration 0 keeps it until dismissed.
export function pushToast(
  message: any,
  kind: ToastKind = 'error',
  { duration, action }: { duration?: number; action?: ToastAction } = {},
): number | null {
  const text = typeof message === 'string' ? message : (message && message.message) || String(message || '')
  if (!text) return null
  const ms = duration ?? DEFAULT_MS[kind]
  // The same message again joins the toast already showing it, back at the front.
  const same = !action && toasts.find((t) => t.text === text && t.kind === kind && !t.action)
  if (same) {
    const timer = timers.get(same.id)
    if (timer?.handle) clearTimeout(timer.handle)
    toasts = [...toasts.filter((t) => t.id !== same.id), { ...same, count: same.count + 1, duration: ms }]
    startTimer(same.id, ms)
    emit()
    return same.id
  }
  const id = ++seq
  toasts = [...toasts, { id, text, kind, action, duration: ms, count: 1 }]
  for (const old of toasts.slice(0, Math.max(0, toasts.length - KEEP))) dismissToast(old.id, false)
  startTimer(id, ms)
  emit()
  return id
}

let held = false
function startTimer(id: number, ms: number) {
  if (!ms) { timers.delete(id); return }
  timers.set(id, held
    ? { handle: null, endsAt: 0, left: ms }
    : { handle: setTimeout(() => dismissToast(id), ms), endsAt: Date.now() + ms, left: ms })
}

export function dismissToast(id: number, notify = true) {
  const timer = timers.get(id)
  if (timer?.handle) clearTimeout(timer.handle)
  timers.delete(id)
  toasts = toasts.filter((t) => t.id !== id)
  if (notify) emit()
}

/** Hold every toast while the deck is hovered or spread open, and let them go after. */
export function holdToasts(on: boolean) {
  held = on
  for (const t of toasts) (on ? pauseToast : resumeToast)(t.id)
}

/** Hold a toast while it is touched (its countdown bar stops too). */
export function pauseToast(id: number) {
  const timer = timers.get(id)
  if (!timer?.handle) return
  clearTimeout(timer.handle)
  timers.set(id, { handle: null, endsAt: 0, left: Math.max(0, timer.endsAt - Date.now()) })
}

export function resumeToast(id: number) {
  const timer = timers.get(id)
  if (!timer || timer.handle) return
  timers.set(id, { handle: setTimeout(() => dismissToast(id), timer.left), endsAt: Date.now() + timer.left, left: timer.left })
}

export const pushError = (message: any) => pushToast(message, 'error')
export const pushSuccess = (message: any) => pushToast(message, 'success')

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function getSnapshot(): Toast[] {
  return toasts
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getSnapshot)
}

// Surface a component's local `error` state as a toast: fires whenever `message`
// transitions to a truthy value. Lets existing views keep their error state and
// catch logic untouched while replacing the inline banner with a toast.
export function useErrorToast(message: any, kind: ToastKind = 'error') {
  useEffect(() => {
    if (message) pushToast(message, kind)
  }, [message, kind])
}
