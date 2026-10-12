// The habits payload, held once for the tab and every sheet it opens. On the web
// the dialogs were children of HabitsView and shared its state; here they are
// their own routes, so the payload lives in a tiny external store instead. Every
// bridge mutation answers with the whole payload, so a write is "send, swap in".
import { useSyncExternalStore } from 'react'
import { AuthError, clearSecret, getHabits } from '../../lib/api'
import { pushToast } from '../../lib/toast'
import type { HabitsPayload } from './logic'
import { rememberSiblingApps } from '../../lib/siblingApps'

let data: HabitsPayload | null = null
let loading = false
const listeners = new Set<() => void>()
const emit = () => { for (const fn of listeners) fn() }

export function setHabits(next: HabitsPayload) { data = next; rememberSiblingApps(next.apps); emit() }
export const getHabitsData = () => data

export function useHabits(): { data: HabitsPayload | null; loading: boolean } {
  const d = useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn) }, () => data)
  const l = useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn) }, () => loading)
  return { data: d, loading: l }
}

/** A 401 means the stored secret is dead: back to Connect, as the web's onAuthError does. */
export function failed(e: unknown): string {
  if (e instanceof AuthError) { clearSecret(); return 'Session expired' }
  return e instanceof Error ? e.message : String(e)
}

export async function loadHabits(): Promise<void> {
  loading = true
  emit()
  try { setHabits(await getHabits()) } catch (e) { pushToast(failed(e)) } finally { loading = false; emit() }
}

/** Run a mutation that answers with the full payload. Throws the message on failure. */
export async function mutate(run: () => Promise<HabitsPayload>): Promise<void> {
  try { setHabits(await run()) } catch (e) { throw new Error(failed(e)) }
}
