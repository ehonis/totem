/**
 * The leader-key state machine.
 *
 * Idle → press the leader → *armed*. While armed, every single-character key
 * extends a buffer that's matched against the binding table; a grace-period
 * timer resets everything if you wander off. Modifiers, text fields and the
 * terminal are all excluded up front, so typing "get the groceries" in a
 * composer never navigates anywhere.
 *
 * Returns the live chord so the HUD can show what's pressable next.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSettings } from './settings'
import {
  ACTIONS_BY_ID,
  bindingIndex,
  matchSequence,
  normalizeKey,
  readConfig,
  onCommand,
  runCommand,
  type ShortcutAction,
  type ShortcutConfig,
} from './shortcuts'
import type { NavTarget } from './router'

export interface ChordState {
  /** True while a sequence is open (the leader has been pressed). */
  armed: boolean
  /** Keys typed since the leader. Empty right after the leader itself. */
  buffer: string
  /** What pressing one more key could still reach. */
  continuations: Array<{ action: ShortcutAction; sequence: string }>
}

const IDLE: ChordState = { armed: false, buffer: '', continuations: [] }

/**
 * Whether a keystroke belongs to whatever the user is typing into.
 *
 * Covers the obvious form controls plus contenteditable surfaces (the chat
 * composer) and anything that opts out with `data-shortcuts-off` — which is how
 * the terminal keeps its keystrokes, since xterm's hidden textarea would
 * otherwise have to be special-cased by tag name.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null
  if (!el) return false
  if (el.closest('[data-shortcuts-off]')) return true
  const editable = el.closest('input, textarea, select, [contenteditable]')
  if (!editable) return false
  // Checkboxes, radios and buttons are inputs that nobody types into, so a
  // shortcut fired while one has focus is still a shortcut.
  if (editable instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(editable.type)
  }
  if (editable instanceof HTMLElement && editable.isContentEditable) return true
  return editable.tagName === 'TEXTAREA' || editable.tagName === 'SELECT'
}

export function useShortcuts(onNavigate: (target: NavTarget) => void): ChordState {
  const settings = useSettings()
  // Re-read (and re-normalise) only when the stored blob actually changes,
  // rather than on every keystroke.
  const config: ShortcutConfig = useMemo(() => readConfig(), [settings.shortcuts])
  const index = useMemo(() => bindingIndex(config.bindings), [config.bindings])

  const [chord, setChord] = useState<ChordState>(IDLE)

  const bufferRef = useRef('')
  const armedRef = useRef(false)
  // An exact match that a longer sequence could still supersede — held until
  // the grace period expires rather than fired on the spot.
  const deferredRef = useRef<ShortcutAction | null>(null)
  const timerRef = useRef<number | null>(null)

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
  }

  const reset = useCallback(() => {
    clearTimer()
    armedRef.current = false
    bufferRef.current = ''
    deferredRef.current = null
    setChord(IDLE)
  }, [])

  const fire = useCallback((action: ShortcutAction) => {
    if (action.nav) onNavigate(action.nav)
    else if (action.command) runCommand(action.command)
  }, [onNavigate])

  // Kept in a ref so the keydown listener below can stay registered across
  // re-renders instead of being torn down whenever the callback identity moves.
  const stateRef = useRef({ config, index, fire, reset })
  useEffect(() => { stateRef.current = { config, index, fire, reset } }, [config, index, fire, reset])

  const arm = useCallback((buffer: string) => {
    const { config: cfg, index: idx, fire: run, reset: stop } = stateRef.current
    armedRef.current = true
    bufferRef.current = buffer
    const { continuations } = matchSequence(idx, buffer)
    setChord({ armed: true, buffer, continuations })
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      // Grace expired: a match we were holding back now wins uncontested.
      const held = deferredRef.current
      stop()
      if (held) run(held)
    }, cfg.graceMs)
  }, [])

  useEffect(() => {
    if (!config.enabled) {
      reset()
      return
    }
    const onKeyDown = (e: KeyboardEvent) => {
      const { config: cfg, index: idx, fire: run, reset: stop } = stateRef.current
      if (e.defaultPrevented || e.isComposing) return

      // Escape always abandons an open sequence, and only that - it must still
      // reach whatever dialog is listening for it.
      if (e.key === 'Escape') {
        if (armedRef.current) stop()
        return
      }

      // Modifier combos belong to the browser or to Ctrl+` and friends. Holding
      // one mid-sequence is a sign the chord is over.
      if (e.ctrlKey || e.metaKey || e.altKey) {
        if (armedRef.current) stop()
        return
      }

      const key = normalizeKey(e.key)
      // Shift/Tab/arrows produce multi-character key names. Ignore rather than
      // cancel: Shift is how you reach '?' in the first place.
      if (!key) return

      if (!armedRef.current) {
        if (key !== cfg.leader || isTypingTarget(e.target)) return
        e.preventDefault()
        arm('')
        return
      }

      // Focus can move into a field between the leader and the next key (a
      // dialog autofocusing an input). Hand the key back rather than eat it.
      if (isTypingTarget(e.target)) {
        stop()
        return
      }

      e.preventDefault()
      const buffer = bufferRef.current + key
      const { exact, continuations } = matchSequence(idx, buffer)

      if (exact && !continuations.length) {
        stop()
        run(exact)
        return
      }
      if (exact) {
        // Ambiguous: this sequence is also the prefix of a longer one. Navigation
        // is safe to do now (you wanted to be there either way); anything else
        // waits to see whether another key is coming.
        if (exact.chainable) {
          deferredRef.current = null
          run(exact)
        } else {
          deferredRef.current = exact
        }
        arm(buffer)
        return
      }
      if (continuations.length) {
        arm(buffer)
        return
      }
      // Dead end. Pressing the leader on one is a change of mind, not a typo —
      // `g t` then `g b` should reach Brain, and it wouldn't if this reset and
      // left the `b` to fall on an unarmed matcher. Bindings that legitimately
      // contain the leader are unaffected: they matched above.
      if (key === cfg.leader) {
        deferredRef.current = null
        arm('')
        return
      }
      // Anything else that misses loses, along with whatever was deferred.
      stop()
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      clearTimer()
    }
  }, [config.enabled, arm, reset])

  // Clicking away or tabbing to another window shouldn't leave a chord hanging.
  useEffect(() => {
    const drop = () => { if (armedRef.current) reset() }
    window.addEventListener('blur', drop)
    window.addEventListener('mousedown', drop, true)
    return () => {
      window.removeEventListener('blur', drop)
      window.removeEventListener('mousedown', drop, true)
    }
  }, [reset])

  return chord
}

/**
 * Claim a shortcut command for as long as this component is mounted.
 *
 * The handler is held in a ref so an inline arrow function doesn't churn the
 * subscription every render - which would also re-run the parked-command check
 * in `onCommand` and fire it more than once.
 */
export function useCommand(command: string, handler: () => void) {
  const ref = useRef(handler)
  useEffect(() => { ref.current = handler })
  useEffect(() => onCommand(command, () => ref.current()), [command])
}

/** The bound sequence for an action, leader included, or null if unbound. */
export function sequenceFor(config: ShortcutConfig, actionId: string): string[] | null {
  const seq = config.bindings[actionId]
  if (!seq || !ACTIONS_BY_ID[actionId]) return null
  return [config.leader, ...Array.from(seq)]
}
