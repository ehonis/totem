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
 */
import type { Route } from './router'
import { getSettings, setSetting } from './settings'
import { QUICK_PANEL_COMMANDS, QUICK_PANEL_SHORTCUTS } from './quickPanels'

export interface ShortcutAction {
  id: string
  label: string
  /** Section heading in the cheat sheet and the settings editor. */
  group: string
  /** Where this action goes. Mutually exclusive with `command`. */
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
  journalRecord: 'journal.record',
  terminalToggle: 'terminal.toggle',
  cheatsheet: 'shortcuts.cheatsheet',
  ...QUICK_PANEL_COMMANDS,
} as const

export const ACTIONS: ShortcutAction[] = [
  // --- Navigation ---
  { id: 'nav.overview', label: 'Overview', group: 'Go to', nav: { tab: 'overview' }, chainable: true },
  { id: 'nav.chat', label: 'Chat', group: 'Go to', nav: { tab: 'chat' }, chainable: true },
  { id: 'nav.todos', label: 'Todos', group: 'Go to', nav: { tab: 'productivity', app: 'todos' }, chainable: true },
  { id: 'nav.calendar', label: 'Calendar', group: 'Go to', nav: { tab: 'productivity', app: 'calendar' }, chainable: true },
  { id: 'nav.habits', label: 'Habits', group: 'Go to', nav: { tab: 'productivity', app: 'habits' }, chainable: true },
  { id: 'nav.goals', label: 'Goals', group: 'Go to', nav: { tab: 'productivity', app: 'goals' }, chainable: true },
  { id: 'nav.journal', label: 'Journal', group: 'Go to', nav: { tab: 'productivity', app: 'journal' }, chainable: true },
  { id: 'nav.code', label: 'Code', group: 'Go to', nav: { tab: 'code' }, chainable: true },
  { id: 'nav.inbox', label: 'Inbox', group: 'Go to', nav: { tab: 'inbox' }, chainable: true },
  { id: 'nav.logs', label: 'Logs', group: 'Go to', nav: { tab: 'logs' }, chainable: true },
  { id: 'nav.brain', label: 'Brain', group: 'Go to', nav: { tab: 'brain' }, chainable: true },
  { id: 'nav.studio', label: 'Totems', group: 'Go to', nav: { tab: 'totems' }, chainable: true },
  { id: 'nav.skills', label: 'Settings · Skills', group: 'Go to', nav: { tab: 'settings', sub: 'skills' }, chainable: true },
  { id: 'nav.connections', label: 'Settings · Connections', group: 'Go to', nav: { tab: 'settings', sub: 'connections' }, chainable: true },
  { id: 'nav.settings', label: 'Settings', group: 'Go to', nav: { tab: 'settings' }, chainable: true },
  { id: 'nav.providers', label: 'Settings · Providers', group: 'Go to', nav: { tab: 'settings', sub: 'providers' }, chainable: true },
  { id: 'nav.shortcuts', label: 'Settings · Shortcuts', group: 'Go to', nav: { tab: 'settings', sub: 'shortcuts' }, chainable: true },

  // --- Actions ---
  { id: 'cmd.todoNew', label: 'New todo', group: 'Create', command: COMMANDS.todoNew },
  { id: 'cmd.habitNew', label: 'New habit', group: 'Create', command: COMMANDS.habitNew },
  { id: 'cmd.chatNew', label: 'New chat', group: 'Create', command: COMMANDS.chatNew },
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
  'nav.todos': 't',
  'nav.calendar': 'a',
  'nav.habits': 'h',
  'nav.goals': 'g',
  'nav.journal': 'j',
  'nav.code': 'e',
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
  ...Object.fromEntries(QUICK_PANEL_SHORTCUTS.map(({ actionId, binding }) => [actionId, binding])),
  'cmd.terminal': 'k',
  'cmd.cheatsheet': '?',
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
}

export const DEFAULT_SHORTCUTS: ShortcutConfig = {
  enabled: true,
  leader: 'g',
  graceMs: 1200,
  showHud: true,
  bindings: { ...DEFAULT_BINDINGS },
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
  return {
    enabled: stored.enabled ?? DEFAULT_SHORTCUTS.enabled,
    leader: normalizeKey(stored.leader) || DEFAULT_SHORTCUTS.leader,
    graceMs: clampGrace(stored.graceMs),
    showHud: stored.showHud ?? DEFAULT_SHORTCUTS.showHud,
    bindings,
  }
}

export function writeConfig(patch: Partial<ShortcutConfig>) {
  setSetting('shortcuts', { ...readConfig(), ...patch })
}

export function setBinding(actionId: string, sequence: string) {
  const config = readConfig()
  writeConfig({ bindings: { ...config.bindings, [actionId]: normalizeSequence(sequence) } })
}

export function resetShortcuts() {
  setSetting('shortcuts', { ...DEFAULT_SHORTCUTS, bindings: { ...DEFAULT_BINDINGS } })
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
