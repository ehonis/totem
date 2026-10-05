/**
 * Settings → Shortcuts.
 *
 * Everything about the leader-key system is editable here: the leader itself,
 * how long a sequence stays open, and the key sequence behind each action.
 * Sequences are captured by pressing the keys rather than typed as text, so
 * what you press is exactly what gets stored.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Hi, WarnIcon, ArrowPathIcon, XMarkIcon } from '../icons'
import { useSettings } from '../settings'
import {
  ACTIONS,
  ACTION_GROUPS,
  ACTIONS_BY_ID,
  DEFAULT_BINDINGS,
  GRACE_MAX,
  GRACE_MIN,
  findConflicts,
  normalizeKey,
  readConfig,
  resetShortcuts,
  setBinding,
  writeConfig,
} from '../shortcuts'
import { Keycap } from './ShortcutOverlay'

const MAX_SEQUENCE = 3

interface ToggleProps {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  disabled?: boolean
}

function Toggle({ checked, onChange, label, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

interface SequenceInputProps {
  value: string
  leader: string
  label: string
  onChange: (sequence: string) => void
}

/**
 * Capture a key sequence by pressing it.
 *
 * A real `<input>` rather than a div with a key handler: focus, tab order and
 * the "is the user typing?" guard in useShortcuts all come free, which is what
 * stops the field from firing the very shortcut it's being used to rebind.
 * Every keystroke is swallowed - the value only ever changes through here.
 */
function SequenceInput({ value, leader, label, onChange }: SequenceInputProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const live = draft ?? value

  const commit = (next: string) => {
    setDraft(null)
    if (next !== value) onChange(next)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab') return // let focus move on
    e.preventDefault()
    e.stopPropagation()

    if (e.key === 'Escape') {
      setDraft(null)
      inputRef.current?.blur()
      return
    }
    if (e.key === 'Enter') {
      commit(live)
      inputRef.current?.blur()
      return
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      setDraft((d) => (d ?? value).slice(0, -1))
      return
    }
    const key = normalizeKey(e.key)
    if (!key) return
    // Recording restarts once the sequence is full, so a mistyped third key is
    // fixed by pressing the whole thing again rather than clearing first.
    const base = draft ?? ''
    setDraft((base.length >= MAX_SEQUENCE ? '' : base) + key)
  }

  return (
    <div className="seq-input-wrap">
      <span className="seq-leader"><Keycap k={leader} /><span className="key-then">then</span></span>
      <input
        ref={inputRef}
        className={`seq-input${draft !== null ? ' recording' : ''}`}
        // Read-only in spirit: the value is built from keydown, never from typing.
        value=""
        onChange={() => {}}
        onKeyDown={onKeyDown}
        onBlur={() => commit(live)}
        aria-label={`Key sequence for ${label}`}
        placeholder=""
      />
      <span className="seq-display" aria-hidden="true">
        {live
          ? Array.from(live).map((k, i) => <Keycap key={`${k}-${i}`} k={k} />)
          : <em>{draft !== null ? 'press keys…' : 'unbound'}</em>}
      </span>
      {value && (
        <button
          type="button"
          className="seq-clear"
          title="Clear binding"
          onClick={() => { setDraft(null); onChange('') }}
        >
          <Hi icon={XMarkIcon} size={13} />
        </button>
      )}
    </div>
  )
}

/** Single-key capture for the leader itself. */
function LeaderInput({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  const [armed, setArmed] = useState(false)
  return (
    <button
      type="button"
      className={`seq-leader-btn${armed ? ' recording' : ''}`}
      onClick={() => setArmed(true)}
      onBlur={() => setArmed(false)}
      onKeyDown={(e) => {
        if (!armed || e.key === 'Tab') return
        e.preventDefault()
        if (e.key === 'Escape') { setArmed(false); return }
        const key = normalizeKey(e.key)
        if (!key) return
        onChange(key)
        setArmed(false)
      }}
    >
      {armed ? <em>press a key…</em> : <Keycap k={value} />}
    </button>
  )
}

const GRACE_STEPS = [600, 800, 1000, 1200, 1500, 2000, 3000]

export default function ShortcutsSettings() {
  const settings = useSettings()
  const config = useMemo(() => readConfig(), [settings.shortcuts])
  const conflicts = useMemo(() => findConflicts(config.bindings), [config.bindings])

  // Which action ids sit on a doubly-bound sequence, for the inline warnings.
  const conflicted = useMemo(() => {
    const ids = new Set<string>()
    for (const list of Object.values(conflicts)) list.forEach((id) => ids.add(id))
    return ids
  }, [conflicts])

  const grouped = useMemo(
    () => ACTION_GROUPS
      .map((group) => ({ group, actions: ACTIONS.filter((a) => a.group === group) }))
      .filter((g) => g.actions.length),
    [],
  )

  const leaderClash = useMemo(
    () => Object.entries(config.bindings)
      .filter(([id, seq]) => seq && ACTIONS_BY_ID[id] && seq[0] === config.leader && seq.length === 1)
      .map(([id]) => ACTIONS_BY_ID[id].label),
    [config.bindings, config.leader],
  )

  const [confirmReset, setConfirmReset] = useState(false)
  // Drop the confirm state if the user wanders off rather than leaving a primed
  // destructive button sitting there.
  useEffect(() => {
    if (!confirmReset) return
    const t = window.setTimeout(() => setConfirmReset(false), 5000)
    return () => window.clearTimeout(t)
  }, [confirmReset])

  const customised = useMemo(
    () => ACTIONS.some((a) => (config.bindings[a.id] || '') !== (DEFAULT_BINDINGS[a.id] || '')),
    [config.bindings],
  )

  return (
    <div className="settings-pane">
      <header className="settings-pane-head">
        <h2>Shortcuts</h2>
        <p>
          Press the leader key, let go, then press the next key: <Keycap k={config.leader} />
          <span className="key-then">then</span><Keycap k="t" /> opens Todos.
        </p>
      </header>

      <div className="settings-section-title"><span /><strong>Behaviour</strong></div>
      <div className="setting-list">
        <SettingRow title="Keyboard shortcuts" desc="Turn the whole leader-key system on or off on this device.">
          <Toggle
            label="Keyboard shortcuts"
            checked={config.enabled}
            onChange={(v) => writeConfig({ enabled: v })}
          />
        </SettingRow>
        <SettingRow title="Leader key" desc="The key that opens a sequence. Never fires while you're typing in a field.">
          <LeaderInput value={config.leader} onChange={(leader) => writeConfig({ leader })} />
        </SettingRow>
        <SettingRow title="Grace period" desc="How long a half-typed sequence stays live before it's forgotten.">
          <select
            className="model-select"
            value={String(config.graceMs)}
            onChange={(e) => writeConfig({ graceMs: Number(e.target.value) })}
          >
            {GRACE_STEPS.filter((ms) => ms >= GRACE_MIN && ms <= GRACE_MAX).map((ms) => (
              <option key={ms} value={ms}>{ms / 1000}s</option>
            ))}
          </select>
        </SettingRow>
        <SettingRow title="Show the hint panel" desc="After the leader key, list what one more press would do.">
          <Toggle
            label="Show the hint panel"
            checked={config.showHud}
            onChange={(v) => writeConfig({ showHud: v })}
            disabled={!config.enabled}
          />
        </SettingRow>
      </div>

      {leaderClash.length > 0 && (
        <div className="shortcut-warn">
          <WarnIcon />
          <span>
            <Keycap k={config.leader} /> is both the leader and the first key of{' '}
            {leaderClash.join(', ')} — press it twice to reach {leaderClash.length > 1 ? 'those' : 'that'}.
          </span>
        </div>
      )}

      {Object.keys(conflicts).length > 0 && (
        <div className="shortcut-warn error">
          <WarnIcon />
          <span>
            {Object.keys(conflicts).length === 1 ? 'One sequence is' : `${Object.keys(conflicts).length} sequences are`}{' '}
            bound twice. Only the first action listed will fire.
          </span>
        </div>
      )}

      {grouped.map(({ group, actions }) => (
        <React.Fragment key={group}>
          <div className="settings-section-title"><span /><strong>{group}</strong></div>
          <div className="setting-list shortcut-editor">
            {actions.map((action) => (
              <div className={`setting-row shortcut-row${conflicted.has(action.id) ? ' conflict' : ''}`} key={action.id}>
                <div className="setting-copy">
                  <strong>{action.label}</strong>
                  {conflicted.has(action.id) && (
                    <span className="inline-warn"><WarnIcon /> Also bound to another action.</span>
                  )}
                </div>
                <div className="setting-control">
                  <SequenceInput
                    value={config.bindings[action.id] || ''}
                    leader={config.leader}
                    label={action.label}
                    onChange={(seq) => setBinding(action.id, seq)}
                  />
                </div>
              </div>
            ))}
          </div>
        </React.Fragment>
      ))}

      <div className="settings-section-title"><span /><strong>Reset</strong></div>
      <div className="setting-list">
        <SettingRow
          title="Restore defaults"
          desc={customised ? 'Put every binding, the leader and the grace period back to stock.' : 'Nothing has been customised yet.'}
        >
          <button
            className={`btn${confirmReset ? ' danger' : ''}`}
            disabled={!customised && !confirmReset}
            onClick={() => {
              if (!confirmReset) { setConfirmReset(true); return }
              resetShortcuts()
              setConfirmReset(false)
            }}
          >
            <Hi icon={ArrowPathIcon} size={15} /> {confirmReset ? 'Confirm reset' : 'Restore defaults'}
          </button>
        </SettingRow>
      </div>
    </div>
  )
}

interface SettingRowProps {
  title: string
  desc?: string
  children?: React.ReactNode
}

function SettingRow({ title, desc, children }: SettingRowProps) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <strong>{title}</strong>
        {desc && <span>{desc}</span>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}
