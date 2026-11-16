/**
 * Leader-key shortcuts.
 *
 * Press the leader (`g` by default), let go, then press one or more keys: `g t`
 * opens Todos, `g t t` opens Todos *and* pops the new-todo composer. Sequences
 * are typed one key at a time with a grace period between them — nothing is
 * held down, and a key pressed minutes later doesn't complete a stale chord.
 *
 * The binding table is flat (`actionId -> "tt"`); the prefix tree the matcher
 * walks is derived from it. That keeps the settings blob small and makes
 * "which action owns this sequence" a single lookup rather than a tree crawl.
 *
 * Actions come in two flavours:
 *   • nav     — a route to navigate to. Cheap and idempotent, so a nav bound to
 *               a *prefix* of a longer sequence fires eagerly (see `chainable`),
 *               which is what makes `g t t` feel like "go to Todos, then new".
 *   • command — a view-level action (open a composer, toggle the terminal). The
 *               view that owns it subscribes via `useCommand`.
 * An action with both goes there first, then runs the command.
 *
 * Any action can also have a hotkey: one modifier chord (`mod+shift+o`, where
 * `mod` is ⌘ on a Mac and Ctrl elsewhere) that fires at once, even from a text
 * field, since a chord with a modifier is never typing.
 */
import type { Route } from './router'
import { getSettings, setSetting } from './settings'
import { QUICK_PANEL_COMMANDS, QUICK_PANEL_SHORTCUTS } from './quickPanels'

export interface ShortcutAction {
  id: string
  label: string
  /** Section heading in the cheat sheet and the settings editor. */
  group: string
  /** Where this action goes; with a `command`, it goes there first. */
  nav?: Partial<Route>
  /** Command id broadcast to whichever view owns it. */
  command?: string
  /**
   * Safe to fire the moment its sequence matches, even when a longer sequence
   * shares the prefix. True for navigation and reversible panels (going to
   * Todos on the way to "new todo," or opening limits on the way to activity,
   * is exactly what you wanted); false for commands with durable side effects,
   * which wait out the grace period so a longer chord can supersede them.
   */
  chainable?: boolean
}

/** Commands a view can claim with `useCommand`. */
export const COMMANDS = {
  todoNew: 'todo.new',
  habitNew: 'habit.new',
  chatNew: 'chat.new',
  chatNewHome: 'chat.newHome',
  chatSettle: 'chat.settle',
  journalRecord: 'journal.record',
  terminalToggle: 'terminal.toggle',
  cheatsheet: 'shortcuts.cheatsheet',
  ...QUICK_PANEL_COMMANDS,
} as const

export const ACTIONS: ShortcutAction[] = [
  // --- Navigation ---
  { id: 'nav.overview', label: 'Overview', group: 'Go to', nav: { tab: 'overview' }, chainable: true },
  { id: 'nav.chat', label: 'Chat', group: 'Go to', nav: { tab: 'chat' }, chainable: true },
  { id: 'nav.search', label: 'Search', group: 'Go to', nav: { tab: 'search' }, chainable: true },
  { id: 'nav.todos', label: 'Tasks', group: 'Go to', nav: { tab: 'productivity', app: 'todos' }, chainable: true },
  { id: 'nav.calendar', label: 'Calendar', group: 'Go to', nav: { tab: 'productivity', app: 'calendar' }, chainable: true },
  { id: 'nav.habits', label: 'Habits', group: 'Go to', nav: { tab: 'productivity', app: 'habits' }, chainable: true },
  { id: 'nav.goals', label: 'Goals', group: 'Go to', nav: { tab: 'productivity', app: 'goals' }, chainable: true },
  { id: 'nav.journal', label: 'Journal', group: 'Go to', nav: { tab: 'productivity', app: 'journal' }, chainable: true },
  { id: 'nav.dev', label: 'Dev', group: 'Go to', nav: { tab: 'dev' }, chainable: true },
  { id: 'nav.inbox', label: 'Inbox', group: 'Go to', nav: { tab: 'inbox' }, chainable: true },
  { id: 'nav.logs', label: 'Settings · Activity', group: 'Go to', nav: { tab: 'settings', sub: 'logs' }, chainable: true },
  { id: 'nav.brain', label: 'Brain', group: 'Go to', nav: { tab: 'brain' }, chainable: true },
  { id: 'nav.studio', label: 'Totems', group: 'Go to', nav: { tab: 'totems' }, chainable: true },
  { id: 'nav.skills', label: 'Settings · Skills', group: 'Go to', nav: { tab: 'settings', sub: 'skills' }, chainable: true },
  { id: 'nav.connections', label: 'Settings · Connections', group: 'Go to', nav: { tab: 'settings', sub: 'connections' }, chainable: true },
  { id: 'nav.settings', label: 'Settings', group: 'Go to', nav: { tab: 'settings' }, chainable: true },
  { id: 'nav.providers', label: 'Settings · Providers', group: 'Go to', nav: { tab: 'settings', sub: 'providers' }, chainable: true },
  { id: 'nav.shortcuts', label: 'Settings · Keyboard', group: 'Go to', nav: { tab: 'settings', sub: 'shortcuts' }, chainable: true },

  // --- Actions ---
  { id: 'cmd.todoNew', label: 'New todo', group: 'Create', command: COMMANDS.todoNew },
  { id: 'cmd.habitNew', label: 'New habit', group: 'Create', command: COMMANDS.habitNew },
  { id: 'cmd.chatNew', label: 'New chat', group: 'Create', command: COMMANDS.chatNew },
  { id: 'cmd.chatNewHome', label: 'New chat in Home', group: 'Create', nav: { tab: 'chat' }, command: COMMANDS.chatNewHome },
  { id: 'cmd.chatSettle', label: 'Settle or un-settle this chat', group: 'Utilities', command: COMMANDS.chatSettle },
  { id: 'cmd.journalRecord', label: 'Record a journal entry', group: 'Create', command: COMMANDS.journalRecord },
  ...QUICK_PANEL_SHORTCUTS.map(({ actionId, label, command, chainable }) => ({
    id: actionId,
    label,
    group: 'Quick panels',
    command,
    chainable: chainable || undefined,
  })),
  { id: 'cmd.terminal', label: 'Toggle terminal', group: 'Utilities', command: COMMANDS.terminalToggle },
  { id: 'cmd.cheatsheet', label: 'Show all shortcuts', group: 'Utilities', command: COMMANDS.cheatsheet },
]

export const ACTIONS_BY_ID: Record<string, ShortcutAction> =
  Object.fromEntries(ACTIONS.map((a) => [a.id, a]))

/** Position in ACTIONS, so lists can be sorted back into declaration order. */
const ACTION_ORDER: Record<string, number> =
  Object.fromEntries(ACTIONS.map((a, i) => [a.id, i]))

/** Groups in cheat-sheet / editor order, rather than Object.keys order. */
export const ACTION_GROUPS = ['Go to', 'Create', 'Quick panels', 'Utilities']

/**
 * Default sequences, keyed by action. A sequence is the keys *after* the
 * leader; `''` means unbound. Sub-actions deliberately extend their parent's
 * sequence (`t` → Todos, `tt` → new todo) so muscle memory nests.
 */
export const DEFAULT_BINDINGS: Record<string, string> = {
  'nav.overview': 'o',
  'nav.chat': 'c',
  'nav.search': 'f',
  'nav.todos': 't',
  'nav.calendar': 'a',
  'nav.habits': 'h',
  'nav.goals': 'g',
  'nav.journal': 'j',
  'nav.dev': 'd',
  'nav.inbox': 'i',
  'nav.logs': 'l',
  'nav.brain': 'b',
  'nav.studio': 's',
  'nav.skills': 'sk',
  'nav.connections': 'sn',
  'nav.settings': ',',
  'nav.providers': ',p',
  'nav.shortcuts': ',s',
  'cmd.todoNew': 'tt',
  'cmd.habitNew': 'hh',
  'cmd.journalRecord': 'jj',
  'cmd.chatNew': 'cc',
  'cmd.chatSettle': 'cs',
  ...Object.fromEntries(QUICK_PANEL_SHORTCUTS.map(({ actionId, binding }) => [actionId, binding])),
  'cmd.terminal': 'k',
  'cmd.cheatsheet': '?',
}

/**
 * Default hotkeys, keyed by action. T3 Code's new-thread chord starts a blank
 * chat at Home from any page.
 */
export const DEFAULT_HOTKEYS: Record<string, string> = {
  'cmd.chatNewHome': 'mod+shift+o',
}

export interface ShortcutConfig {
  enabled: boolean
  /** Single key that opens a sequence. Lower-cased, no modifiers. */
  leader: string
  /** How long a partial sequence stays live, in ms. */
  graceMs: number
  /** Show the floating "what can I press next" panel while a chord is open. */
  showHud: boolean
  /** actionId -> sequence after the leader. */
  bindings: Record<string, string>
  /** actionId -> modifier chord (`mod+shift+o`); '' clears a default. */
  hotkeys: Record<string, string>
}

export const DEFAULT_SHORTCUTS: ShortcutConfig = {
  enabled: true,
  leader: 'g',
  graceMs: 1200,
  showHud: true,
  bindings: { ...DEFAULT_BINDINGS },
  hotkeys: { ...DEFAULT_HOTKEYS },
}

export const GRACE_MIN = 400
export const GRACE_MAX = 5000

/** Merge stored config over the defaults, dropping bindings for dead actions. */
export function readConfig(): ShortcutConfig {
  const stored = getSettings().shortcuts || {}
  const bindings: Record<string, string> = { ...DEFAULT_BINDINGS }
  for (const [id, seq] of Object.entries(stored.bindings || {})) {
    // An action removed in a later release leaves its key behind in localStorage;
    // ignoring it here keeps the editor and the matcher from disagreeing.
    if (ACTIONS_BY_ID[id]) bindings[id] = normalizeSequence(String(seq))
  }
  const hotkeys: Record<string, string> = { ...DEFAULT_HOTKEYS }
  for (const [id, combo] of Object.entries(stored.hotkeys || {})) {
    if (ACTIONS_BY_ID[id]) hotkeys[id] = normalizeHotkey(String(combo))
  }
  return {
    enabled: stored.enabled ?? DEFAULT_SHORTCUTS.enabled,
    leader: normalizeKey(stored.leader) || DEFAULT_SHORTCUTS.leader,
    graceMs: clampGrace(stored.graceMs),
    showHud: stored.showHud ?? DEFAULT_SHORTCUTS.showHud,
    bindings,
    hotkeys,
  }
}

export function writeConfig(patch: Partial<ShortcutConfig>) {
  setSetting('shortcuts', { ...readConfig(), ...patch })
}

export function setBinding(actionId: string, sequence: string) {
  const config = readConfig()
  writeConfig({ bindings: { ...config.bindings, [actionId]: normalizeSequence(sequence) } })
}

export function setHotkey(actionId: string, combo: string) {
  const config = readConfig()
  writeConfig({ hotkeys: { ...config.hotkeys, [actionId]: normalizeHotkey(combo) } })
}

export function resetShortcuts() {
  setSetting('shortcuts', { ...DEFAULT_SHORTCUTS, bindings: { ...DEFAULT_BINDINGS }, hotkeys: { ...DEFAULT_HOTKEYS } })
}

const clampGrace = (ms: unknown) => {
  const n = Number(ms)
  return Number.isFinite(n) ? Math.min(GRACE_MAX, Math.max(GRACE_MIN, n)) : DEFAULT_SHORTCUTS.graceMs
}

/**
 * A key as the matcher sees it: one lower-case character. Anything longer
 * ('Shift', 'ArrowUp', 'Enter') isn't a sequence key — those either cancel the
 * chord or pass through untouched.
 */
export function normalizeKey(key: unknown): string {
  const k = typeof key === 'string' ? key : ''
  return k.length === 1 ? k.toLowerCase() : ''
}

/** Keep only usable keys, cap the length, and lower-case the lot. */
export function normalizeSequence(seq: string, max = 3): string {
  return Array.from(seq || '')
    .map((c) => normalizeKey(c))
    .filter(Boolean)
    .slice(0, max)
    .join('')
}

// ---------------------------------------------------------------------------
// Hotkeys
// ---------------------------------------------------------------------------

export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const MODIFIERS = ['mod', 'ctrl', 'meta', 'alt', 'shift'] as const
type Modifier = typeof MODIFIERS[number]

/**
 * A chord in its stored spelling: modifiers in a fixed order, then one key, all
 * lower case. Without ⌘/Ctrl/Alt it is no hotkey (Shift+O is a capital O), so ''.
 */
export function normalizeHotkey(combo: string): string {
  const parts = String(combo || '').toLowerCase().split('+').map((p) => p.trim())
  // "mod++" is the plus key.
  if (parts.length > 1 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') parts.splice(-2, 2, '+')
  const key = parts.pop() || ''
  const mods = new Set(parts.filter((p): p is Modifier => (MODIFIERS as readonly string[]).includes(p)))
  if (!key || MODIFIERS.includes(key as Modifier) || !(mods.has('mod') || mods.has('ctrl') || mods.has('meta') || mods.has('alt'))) return ''
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join('+')
}

/**
 * The chord a key press makes, or '' for a press that is no hotkey. Letters and
 * digits are read from the key's position (`e.code`), so Shift or a Mac's Option
 * (⌥O types "ø") never changes which key it was.
 */
export function hotkeyFromEvent(e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, mac = isMac()): string {
  if (['Meta', 'Control', 'Alt', 'Shift', 'OS', 'AltGraph', 'CapsLock'].includes(e.key)) return ''
  const letter = /^Key([A-Z])$/.exec(e.code || '')
  const digit = /^Digit(\d)$/.exec(e.code || '')
  const key = letter ? letter[1].toLowerCase() : digit ? digit[1] : (e.key || '').toLowerCase()
  if (!key) return ''
  const mods: string[] = []
  if (mac ? e.metaKey : e.ctrlKey) mods.push('mod')
  if (mac && e.ctrlKey) mods.push('ctrl')
  if (!mac && e.metaKey) mods.push('meta')
  if (e.altKey) mods.push('alt')
  if (e.shiftKey) mods.push('shift')
  return normalizeHotkey([...mods, key].join('+'))
}

const KEY_NAMES: Record<string, [mac: string, other: string]> = {
  mod: ['⌘', 'Ctrl'], ctrl: ['⌃', 'Ctrl'], meta: ['⌘', 'Win'], alt: ['⌥', 'Alt'], shift: ['⇧', 'Shift'],
  enter: ['↩', 'Enter'], escape: ['Esc', 'Esc'], backspace: ['⌫', 'Backspace'], ' ': ['Space', 'Space'],
  arrowup: ['↑', '↑'], arrowdown: ['↓', '↓'], arrowleft: ['←', '←'], arrowright: ['→', '→'],
}

/** A chord as keycaps: `mod+shift+o` → ⌘ ⇧ O on a Mac, Ctrl Shift O elsewhere. */
export function hotkeyKeys(combo: string, mac = isMac()): string[] {
  const n = normalizeHotkey(combo)
  if (!n) return []
  const parts = n.endsWith('++') ? [...n.slice(0, -2).split('+'), '+'] : n.split('+')
  return parts.map((p) => KEY_NAMES[p]?.[mac ? 0 : 1] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
}

/**
 * Chords the browser or Totem keeps for itself: a page never sees the first
 * (new tab, close tab, quit), and Ctrl+` already opens the terminal.
 */
export function hotkeyTaken(combo: string): string | null {
  const n = normalizeHotkey(combo)
  if (['mod+t', 'mod+w', 'mod+n', 'mod+q', 'mod+shift+t', 'mod+shift+n', 'mod+shift+w', 'mod+tab', 'mod+shift+tab'].includes(n)) return 'Your browser keeps this one, so it may never reach Totem.'
  if (n === 'mod+`') return 'This one opens the terminal.'
  return null
}

/** Hotkeys as chord -> action, first writer wins like the sequences. */
export function hotkeyIndex(hotkeys: Record<string, string>): Map<string, ShortcutAction> {
  const index = new Map<string, ShortcutAction>()
  for (const [id, combo] of Object.entries(hotkeys)) {
    const action = ACTIONS_BY_ID[id]
    if (action && combo && !index.has(combo)) index.set(combo, action)
  }
  return index
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface SequenceMatch {
  /** Action bound to exactly this sequence, if any. */
  exact: ShortcutAction | null
  /** Actions whose sequence starts with (and is longer than) this one. */
  continuations: Array<{ action: ShortcutAction; sequence: string }>
}

/** Bindings as sequence -> action, skipping unbound and unknown ids. */
export function bindingIndex(bindings: Record<string, string>): Map<string, ShortcutAction> {
  const index = new Map<string, ShortcutAction>()
  for (const [id, seq] of Object.entries(bindings)) {
    const action = ACTIONS_BY_ID[id]
    // First writer wins, so a duplicate sequence can never silently shadow the
    // action the user sees listed first in the editor.
    if (action && seq && !index.has(seq)) index.set(seq, action)
  }
  return index
}

export function matchSequence(index: Map<string, ShortcutAction>, buffer: string): SequenceMatch {
  const continuations: Array<{ action: ShortcutAction; sequence: string }> = []
  for (const [sequence, action] of index) {
    if (sequence.length > buffer.length && sequence.startsWith(buffer)) {
      continuations.push({ action, sequence })
    }
  }
  // Declaration order, not alphabetical: the HUD should read like the sidebar
  // (Overview, Chat, Todos…) rather than leading with whatever got bound to a
  // punctuation key.
  continuations.sort((a, b) => ACTION_ORDER[a.action.id] - ACTION_ORDER[b.action.id])
  return { exact: index.get(buffer) || null, continuations }
}

/** Sequences bound more than once — surfaced as warnings in the editor. */
export function findConflicts(bindings: Record<string, string>): Record<string, string[]> {
  const bySequence: Record<string, string[]> = {}
  for (const [id, seq] of Object.entries(bindings)) {
    if (seq && ACTIONS_BY_ID[id]) (bySequence[seq] ||= []).push(id)
  }
  return Object.fromEntries(Object.entries(bySequence).filter(([, ids]) => ids.length > 1))
}

// ---------------------------------------------------------------------------
// Command bus
// ---------------------------------------------------------------------------

type Handler = () => void
const handlers = new Map<string, Set<Handler>>()

/**
 * A command fired at a view that isn't mounted yet.
 *
 * `g t t` navigates to Todos on the second key and fires `todo.new` on the
 * third. Those are separate keydown events so React has normally committed the
 * mount in between — but a slow render, or a chord replayed from the cheat
 * sheet, can still land the command first. Parking it lets the view claim it on
 * mount instead of dropping it on the floor.
 */
let parked: { command: string; at: number } | null = null
const PARK_MS = 1500

/** Fire a command at whichever view owns it, or park it briefly if none does. */
export function runCommand(command: string) {
  const set = handlers.get(command)
  if (set?.size) {
    set.forEach((fn) => fn())
    return
  }
  parked = { command, at: Date.now() }
}

/** Register a handler; returns the unsubscribe. Claims a freshly parked command. */
export function onCommand(command: string, fn: Handler): () => void {
  const set = handlers.get(command) || new Set<Handler>()
  set.add(fn)
  handlers.set(command, set)
  if (parked && parked.command === command && Date.now() - parked.at < PARK_MS) {
    parked = null
    fn()
  }
  return () => {
    set.delete(fn)
    if (!set.size) handlers.delete(command)
  }
}
