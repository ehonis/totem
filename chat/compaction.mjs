// chat/compaction.mjs — Compact idle threads → Before the cache expires (T3
// Code's IdleCompactionService): two minutes before an idle Claude chat's prompt
// cache expires, the bridge sends it `/compact` itself. When to compact is
// idleCompactionWindow in chat/context.mjs; this is only the timers.
//
// Timers live in memory, so a restart loses them; the chat then offers Compact
// and send instead (When you return). Each firing looks at the chat again: the
// owner may have written, settled or snoozed it since, or switched the account off.

import { idleCompactionWindow } from './context.mjs'

/**
 * `threads` is the thread store (get, list); `isRunning(id)` whether a reply is
 * running; `startTurn(body, { idle })` startChatTurn; `mode()` the setting;
 * `enabled(provider)` whether that account is still on.
 */
export function createIdleCompactor({ threads, isRunning, startTurn, mode, driverOf, enabled = async () => true, log = () => {}, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  const timers = new Map()
  const on = () => mode() === 'beforeCacheExpires'
  const windowFor = (t) => idleCompactionWindow(t, { driverOf, now: now(), running: !!t && isRunning(t.id) })

  function cancel(threadId) {
    clearTimer(timers.get(threadId))
    timers.delete(threadId)
  }

  async function fire(threadId) {
    timers.delete(threadId)
    if (!on()) return
    const t = await threads.get(threadId).catch(() => null)
    if (!windowFor(t) || !(await enabled(t.provider))) return
    const last = t.messages[t.messages.length - 1]
    log(`idle compaction: compacting ${threadId} before its prompt cache expires`)
    await startTurn({ threadId, text: '/compact', provider: t.provider, model: last.model, effort: last.effort, modelSettings: t.modelSettings }, { idle: 'beforeCacheExpires' })
  }

  /** After a run ends: this chat's timer for its idle spell, if it gets one. */
  async function schedule(threadId) {
    cancel(threadId)
    if (!on()) return
    const win = windowFor(await threads.get(threadId).catch(() => null))
    if (!win) return
    const timer = setTimer(() => { fire(threadId).catch((e) => log('idle compaction failed', e?.message || e)) }, Math.max(0, win.startMs - now()))
    timer?.unref?.()
    timers.set(threadId, timer)
  }

  /** The setting changed: every recently active chat gets (or loses) its timer. */
  async function reschedule() {
    for (const id of [...timers.keys()]) cancel(id)
    if (!on()) return
    const list = await threads.list().catch(() => [])
    // Claude's longest cache lasts an hour; nothing quiet for longer can still be warm.
    for (const t of list) if (Number(t.updatedAt) > now() - 2 * 60 * 60_000) await schedule(t.id)
  }

  return { schedule, reschedule, fire, pending: () => [...timers.keys()] }
}
