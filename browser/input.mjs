// The owner's raw input to a chat's browser: what the panel may send, checked,
// and turned into the Chrome DevTools Protocol's Input events.
//
// The panel maps its pointer from the frame it draws to the page's own CSS
// pixels (web/src/chat/browserInput.ts), so x and y arrive in viewport
// coordinates whatever size the frame was shown at; here they are only clamped
// to the viewport. Mouse and wheel go to Input.dispatchMouseEvent with the
// modifiers the owner held. Keys go through Playwright's keyboard, which knows
// each key's code and text; typed text and pastes are inserted whole.
//
//   { kind: 'mouse', type: 'move'|'down'|'up', x, y, button, buttons, clickCount, modifiers }
//   { kind: 'wheel', x, y, deltaX, deltaY, modifiers }
//   { kind: 'key',   type: 'down'|'up', key, modifiers }
//   { kind: 'text',  text }

export const MODIFIERS = ['Alt', 'Control', 'Meta', 'Shift']
const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
const BUTTONS = ['none', 'left', 'middle', 'right', 'back', 'forward']
const MOUSE_TYPES = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' }
export const TEXT_MAX = 4000
const WHEEL_MAX = 10_000

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const finite = (n) => typeof n === 'number' && Number.isFinite(n)

/** CDP's modifier bitmask: Alt 1, Control 2, Meta 4, Shift 8. */
export function modifierBits(modifiers = []) {
  let bits = 0
  for (const m of new Set(modifiers)) bits |= MODIFIER_BITS[m] || 0
  return bits
}

/** A key the page can be sent: one character, or a DOM key name (Enter, ArrowLeft, F5). */
export function validKey(key) {
  if (typeof key !== 'string' || !key) return false
  if ([...key].length === 1) return !/[\u0000-\u001f\u007f]/.test(key)
  return /^[A-Z][A-Za-z0-9]{0,23}$/.test(key)
}

/**
 * One input event from the panel, checked and normalised, or null when it is not
 * one. Coordinates are clamped to `viewport`, modifiers kept to the four real ones.
 */
export function parseInput(raw, viewport) {
  if (!raw || typeof raw !== 'object') return null
  const modifiers = Array.isArray(raw.modifiers) ? [...new Set(raw.modifiers.filter((m) => MODIFIERS.includes(m)))] : []
  const point = () => (finite(raw.x) && finite(raw.y)
    ? { x: clamp(raw.x, 0, Math.max(0, viewport.width - 1)), y: clamp(raw.y, 0, Math.max(0, viewport.height - 1)) }
    : null)
  if (raw.kind === 'mouse') {
    const at = point()
    if (!at || !MOUSE_TYPES[raw.type]) return null
    const button = BUTTONS.includes(raw.button) ? raw.button : raw.type === 'move' ? 'none' : 'left'
    const buttons = finite(raw.buttons) ? clamp(Math.trunc(raw.buttons), 0, 31) : 0
    const clickCount = raw.type === 'move' ? 0 : finite(raw.clickCount) ? clamp(Math.trunc(raw.clickCount), 1, 3) : 1
    return { kind: 'mouse', type: raw.type, ...at, button, buttons, clickCount, modifiers }
  }
  if (raw.kind === 'wheel') {
    const at = point()
    if (!at || !(finite(raw.deltaX) || finite(raw.deltaY))) return null
    const deltaX = finite(raw.deltaX) ? clamp(raw.deltaX, -WHEEL_MAX, WHEEL_MAX) : 0
    const deltaY = finite(raw.deltaY) ? clamp(raw.deltaY, -WHEEL_MAX, WHEEL_MAX) : 0
    if (!deltaX && !deltaY) return null
    return { kind: 'wheel', ...at, deltaX, deltaY, modifiers }
  }
  if (raw.kind === 'key') {
    if ((raw.type !== 'down' && raw.type !== 'up') || !validKey(raw.key)) return null
    return { kind: 'key', type: raw.type, key: raw.key, modifiers }
  }
  if (raw.kind === 'text') {
    if (typeof raw.text !== 'string' || !raw.text || raw.text.length > TEXT_MAX) return null
    return { kind: 'text', text: raw.text }
  }
  return null
}

/** Input.dispatchMouseEvent's parameters for a parsed mouse event. */
export function cdpMouse(ev) {
  return {
    type: MOUSE_TYPES[ev.type],
    x: ev.x, y: ev.y,
    button: ev.button,
    buttons: ev.buttons,
    clickCount: ev.clickCount,
    modifiers: modifierBits(ev.modifiers),
    pointerType: 'mouse',
  }
}

/** Input.dispatchMouseEvent's parameters for a parsed wheel event. */
export function cdpWheel(ev) {
  return { type: 'mouseWheel', x: ev.x, y: ev.y, deltaX: ev.deltaX, deltaY: ev.deltaY, button: 'none', modifiers: modifierBits(ev.modifiers), pointerType: 'mouse' }
}

/**
 * Fold a new event into the last one still waiting, when nothing is lost by it:
 * a move into the move before it, a wheel into the wheel before it at the same
 * place. Returns the merged event, or null when the two must both be sent.
 */
export function coalesce(last, next) {
  if (!last || last.kind !== next.kind) return null
  if (next.kind === 'mouse' && last.type === 'move' && next.type === 'move' && last.buttons === next.buttons) return next
  if (next.kind === 'wheel' && last.x === next.x && last.y === next.y && modifierBits(last.modifiers) === modifierBits(next.modifiers)) {
    return { ...next, deltaX: clamp(last.deltaX + next.deltaX, -WHEEL_MAX, WHEEL_MAX), deltaY: clamp(last.deltaY + next.deltaY, -WHEEL_MAX, WHEEL_MAX) }
  }
  return null
}
