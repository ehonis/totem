// Global toast notifications. Any module can call pushToast(...) - typically from
// an error path - and <ToastHost/> (mounted once in App) renders them in the
// bottom-left corner. This is a tiny external store so non-React code (and
// components without a shared parent) can raise toasts without prop drilling.
import { useSyncExternalStore, useEffect } from 'react'

export type ToastKind = 'error' | 'success' | 'info'

// An optional inline button on a toast - used for "Undo" on reversible actions.
// The toast dismisses itself once the handler is invoked.
export interface ToastAction {
  label: string
  onClick: () => void | Promise<void>
}

export interface Toast {
  id: number
  text: string
  kind: ToastKind
  action?: ToastAction
}

let toasts: Toast[] = []
const listeners = new Set<() => void>()
let seq = 0

function emit() {
  for (const fn of listeners) fn()
}

// kind is 'error' | 'success' | 'info'. duration 0 keeps it until dismissed.
export function pushToast(
  message: any,
  kind: ToastKind = 'error',
  { duration = 6000, action }: { duration?: number; action?: ToastAction } = {},
): number | null {
  const text = typeof message === 'string' ? message : (message && message.message) || String(message || '')
  if (!text) return null
  const id = ++seq
  toasts = [...toasts, { id, text, kind, action }]
  emit()
  if (duration) setTimeout(() => dismissToast(id), duration)
  return id
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
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
