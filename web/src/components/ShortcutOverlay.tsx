/**
 * The two bits of shortcut chrome.
 *
 * `ShortcutHud` is the small panel that appears the moment you press the leader
 * and lists what one more key would do — the point of a leader key is that you
 * don't have to remember the second half. `ShortcutCheatSheet` is the full
 * modal behind `g ?`.
 *
 * Both are pure readouts of the config: nothing here decides what a key does.
 */
import React, { useMemo, useState } from 'react'
import { Hi, XMarkIcon, CommandLineIcon } from '../icons'
import { useSettings } from '../settings'
import {
  ACTIONS,
  ACTION_GROUPS,
  COMMANDS,
  readConfig,
  type ShortcutAction,
} from '../shortcuts'
import { useCommand, type ChordState } from '../useShortcuts'

/** A single key rendered as a keycap. Spaces and blanks get a readable stand-in. */
export function Keycap({ k }: { k: string }) {
  const label = k === ' ' ? 'Space' : k === ',' ? ',' : k.toUpperCase()
  return <kbd className="keycap">{label}</kbd>
}

/** "G then T then T" — the leader plus each key of a sequence. */
export function KeySequence({ leader, sequence }: { leader: string; sequence: string }) {
  const keys = [leader, ...Array.from(sequence)]
  return (
    <span className="key-seq">
      {keys.map((k, i) => (
        <React.Fragment key={`${k}-${i}`}>
          {i > 0 && <span className="key-then">then</span>}
          <Keycap k={k} />
        </React.Fragment>
      ))}
    </span>
  )
}

interface HudProps {
  chord: ChordState
}

/**
 * "You pressed G — here's what's next."
 *
 * Docked bottom-left because the quick-launch FAB and the terminal both own the
 * bottom-right. Non-interactive: it's a prompt, not a menu, so it never steals
 * the focus that the next keystroke depends on.
 */
export function ShortcutHud({ chord }: HudProps) {
  const settings = useSettings()
  const config = useMemo(() => readConfig(), [settings.shortcuts])

  if (!chord.armed || !config.showHud) return null

  const typed = [config.leader, ...Array.from(chord.buffer)]
  // A dead end is possible mid-chord (an eager nav already fired and nothing
  // extends it); showing an empty panel is worse than showing none.
  if (!chord.continuations.length) return null

  return (
    <div className="shortcut-hud" role="status" aria-live="polite">
      <div className="shortcut-hud-head">
        <span className="shortcut-hud-typed">
          {typed.map((k, i) => <Keycap key={`${k}-${i}`} k={k} />)}
        </span>
        <span className="shortcut-hud-hint">then…</span>
      </div>
      <div className="shortcut-hud-list">
        {chord.continuations.map(({ action, sequence }) => (
          <div className="shortcut-hud-row" key={action.id}>
            {/* Only the part still to be typed - the prefix is already shown above. */}
            <span className="shortcut-hud-keys">
              {Array.from(sequence.slice(chord.buffer.length)).map((k, i) => (
                <Keycap key={`${k}-${i}`} k={k} />
              ))}
            </span>
            <span className="shortcut-hud-label">{action.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

interface CheatSheetProps {
  open: boolean
  onClose: () => void
}

/** Every bound shortcut, grouped. Unbound actions are left out on purpose. */
export function ShortcutCheatSheet({ open, onClose }: CheatSheetProps) {
  const settings = useSettings()
  const config = useMemo(() => readConfig(), [settings.shortcuts])

  const grouped = useMemo(() => {
    const bound = ACTIONS.filter((a) => config.bindings[a.id])
    return ACTION_GROUPS
      .map((group) => ({ group, actions: bound.filter((a: ShortcutAction) => a.group === group) }))
      .filter((g) => g.actions.length)
  }, [config.bindings])

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="event-modal shortcut-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-kicker">Keyboard</div>
            <h2>Shortcuts</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Hi icon={XMarkIcon} size={18} />
          </button>
        </div>
        <p className="shortcut-sheet-intro">
          Press <Keycap k={config.leader} /> then the keys below — one after another, not held down.
        </p>
        {grouped.map(({ group, actions }) => (
          <div className="shortcut-sheet-group" key={group}>
            <div className="settings-section-title"><span /><strong>{group}</strong></div>
            <div className="shortcut-sheet-list">
              {actions.map((action) => (
                <div className="shortcut-sheet-row" key={action.id}>
                  <span>{action.label}</span>
                  <KeySequence leader={config.leader} sequence={config.bindings[action.id]} />
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="modal-actions">
          <span className="shortcut-sheet-foot">
            <Hi icon={CommandLineIcon} size={14} /> Rebind these under Settings → Shortcuts.
          </span>
        </div>
      </div>
    </div>
  )
}

/** Both pieces, wired to the chord and to the `show all shortcuts` command. */
export default function ShortcutOverlay({ chord }: HudProps) {
  const [sheetOpen, setSheetOpen] = useState(false)
  useCommand(COMMANDS.cheatsheet, () => setSheetOpen((v) => !v))
  return (
    <>
      <ShortcutHud chord={chord} />
      <ShortcutCheatSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </>
  )
}
