// The habits payload, held once for the tab and every sheet it opens. On the web
// the dialogs were children of HabitsView and shared its state; here they are
// their own routes, so the payload lives in a tiny external store instead. Every
// bridge mutation answers with the whole payload, so a write is "send, swap in".
import { useSyncExternalStore } from 'react'
import { AuthError, clearSecret, getHabits, isAccountChanged, peekHabits } from '../../lib/api'
import { pushToast } from '../../lib/toast'
import type { HabitsPayload } from './logic'
import { rememberSiblingApps } from '../../lib/siblingApps'

let data: HabitsPayload | null = null
let loading = false
/** Why the last load failed, until one succeeds; the page shows it with a Retry. */
let error = ''
/**
 * Taps still on their way to the bridge, `habitId:date` → delta, so a check fills
 * the moment it is pressed. Kept here, beside the payload, so an answer and the
 * tap it settles leave in one emit and no frame counts the tap twice.
 */
let pending: Record<string, number> = {}
const listeners = new Set<() => void>()
const emit = () => { for (const fn of listeners) fn() }

export function setHabits(next: HabitsPayload) { data = next; rememberSiblingApps(next.apps); emit() }
export const getHabitsData = () => data

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

export function useHabits(): { data: HabitsPayload | null; loading: boolean; error: string; pending: Record<string, number> } {
  const d = useSyncExternalStore(subscribe, () => data)
  const l = useSyncExternalStore(subscribe, () => loading)
  const e = useSyncExternalStore(subscribe, () => error)
  const p = useSyncExternalStore(subscribe, () => pending)
  return { data: d, loading: l, error: e, pending: p }
}

function shift(key: string, delta: number) {
  const next = (pending[key] || 0) + delta
  const { [key]: _gone, ...rest } = pending
  pending = next ? { ...rest, [key]: next } : rest
}

/** Draw a tap now; `mutate(run, { key, delta })` takes it back out when it settles. */
export function addPending(key: string, delta: number) { shift(key, delta); emit() }

/** A 401 means the stored secret is dead: back to Connect, as the web's onAuthError does. */
export function failed(e: unknown): string {
  if (e instanceof AuthError) { clearSecret(); return 'Session expired' }
  return e instanceof Error ? e.message : String(e)
}

export async function loadHabits(): Promise<void> {
  // The first load draws the cached payload at once while the bridge is asked.
  const cached = data ? undefined : peekHabits()
  if (cached) setHabits(cached)
  loading = true
  emit()
  try {
    setHabits(await getHabits())
    error = ''
  } catch (e) {
    if (isAccountChanged(e)) return
    error = failed(e)
    // With habits on screen a toast is enough; with none, the page says it itself.
    if (data) pushToast(error)
  } finally { loading = false; emit() }
}

/**
 * Run a mutation that answers with the full payload. Throws the message on failure.
 * `settles` is a tap drawn with addPending, removed in the same emit as the answer.
 */
export async function mutate(run: () => Promise<HabitsPayload>, settles?: { key: string; delta: number }): Promise<void> {
  try {
    const next = await run()
    if (settles) shift(settles.key, -settles.delta)
    setHabits(next)
  } catch (e) {
    if (settles) { shift(settles.key, -settles.delta); emit() }
    throw new Error(failed(e))
  }
}
