import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  COMMANDS, DEFAULT_HOTKEYS, findConflicts, hotkeyFromEvent, hotkeyIndex, hotkeyKeys, hotkeyTaken,
  normalizeHotkey, onCommand, readConfig, resetShortcuts, setHotkey, DEFAULT_BINDINGS,
} from './shortcuts'
import { useShortcuts } from './useShortcuts'

const press = (key: string, code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
  ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

describe('hotkey spelling', () => {
  it('normalizes the order and refuses chords with no ⌘/Ctrl/Alt', () => {
    expect(normalizeHotkey('Shift+Mod+O')).toBe('mod+shift+o')
    expect(normalizeHotkey('alt+k')).toBe('alt+k')
    expect(normalizeHotkey('mod++')).toBe('mod++')
    expect(normalizeHotkey('shift+o')).toBe('')
    expect(normalizeHotkey('o')).toBe('')
    expect(normalizeHotkey('mod+shift')).toBe('')
    expect(normalizeHotkey('')).toBe('')
  })

  it('reads a press by key position, ⌘ on a Mac and Ctrl elsewhere', () => {
    expect(hotkeyFromEvent(press('O', 'KeyO', { metaKey: true, shiftKey: true }), true)).toBe('mod+shift+o')
    expect(hotkeyFromEvent(press('O', 'KeyO', { ctrlKey: true, shiftKey: true }), false)).toBe('mod+shift+o')
    // Ctrl on a Mac is its own modifier, not ⌘.
    expect(hotkeyFromEvent(press('O', 'KeyO', { ctrlKey: true, shiftKey: true }), true)).toBe('ctrl+shift+o')
    // ⌥O types "ø"; it is still O.
    expect(hotkeyFromEvent(press('ø', 'KeyO', { altKey: true }), true)).toBe('alt+o')
    expect(hotkeyFromEvent(press('!', 'Digit1', { ctrlKey: true, shiftKey: true }), false)).toBe('mod+shift+1')
    expect(hotkeyFromEvent(press('Shift', 'ShiftLeft', { shiftKey: true, ctrlKey: true }), false)).toBe('')
    expect(hotkeyFromEvent(press('o', 'KeyO', { shiftKey: true }), false)).toBe('')
  })

  it('draws keycaps per platform', () => {
    expect(hotkeyKeys('mod+shift+o', true)).toEqual(['⌘', '⇧', 'O'])
    expect(hotkeyKeys('mod+shift+o', false)).toEqual(['Ctrl', 'Shift', 'O'])
    expect(hotkeyKeys('mod++', false)).toEqual(['Ctrl', '+'])
    expect(hotkeyKeys('alt+arrowup', true)).toEqual(['⌥', '↑'])
  })

  it('warns about chords the browser or the terminal keeps', () => {
    expect(hotkeyTaken('mod+w')).toMatch(/browser/)
    expect(hotkeyTaken('mod+`')).toMatch(/terminal/)
    expect(hotkeyTaken('mod+shift+o')).toBeNull()
  })
})

describe('stored hotkeys', () => {
  afterEach(() => resetShortcuts())

  it('starts with ⌘/Ctrl+Shift+O for a new chat in Home, and no clash', () => {
    expect(readConfig().hotkeys).toEqual(DEFAULT_HOTKEYS)
    expect(DEFAULT_HOTKEYS['cmd.chatNewHome']).toBe('mod+shift+o')
    expect(findConflicts(DEFAULT_BINDINGS)).toEqual({})
    expect(hotkeyIndex(readConfig().hotkeys).get('mod+shift+o')?.command).toBe(COMMANDS.chatNewHome)
  })

  it('can be rebound and cleared, and keeps the clearing', () => {
    setHotkey('cmd.chatNewHome', 'Alt+N')
    expect(readConfig().hotkeys['cmd.chatNewHome']).toBe('alt+n')
    setHotkey('cmd.chatNewHome', '')
    expect(readConfig().hotkeys['cmd.chatNewHome']).toBe('')
    expect(hotkeyIndex(readConfig().hotkeys).size).toBe(0)
  })
})

describe('useShortcuts hotkeys', () => {
  afterEach(() => resetShortcuts())

  const ctrlShiftO = (target: EventTarget) => {
    const e = new KeyboardEvent('keydown', { key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })
    act(() => { target.dispatchEvent(e) })
    return e
  }

  it('goes to the chat and starts a new chat in Home, even from a text field', () => {
    const navigate = vi.fn()
    const ran = vi.fn()
    const off = onCommand(COMMANDS.chatNewHome, ran)
    const { unmount } = renderHook(() => useShortcuts(navigate))
    const field = document.createElement('textarea')
    document.body.appendChild(field)
    const e = ctrlShiftO(field)
    expect(e.defaultPrevented).toBe(true)
    expect(navigate).toHaveBeenCalledWith({ tab: 'chat' })
    expect(ran).toHaveBeenCalledTimes(1)
    field.remove()
    unmount()
    off()
  })

  it('leaves the keys to a field recording a hotkey', () => {
    const navigate = vi.fn()
    const ran = vi.fn()
    const off = onCommand(COMMANDS.chatNewHome, ran)
    const { unmount } = renderHook(() => useShortcuts(navigate))
    const wrap = document.createElement('div')
    wrap.setAttribute('data-hotkey-capture', '')
    const field = document.createElement('input')
    wrap.appendChild(field)
    document.body.appendChild(wrap)
    expect(ctrlShiftO(field).defaultPrevented).toBe(false)
    expect(ran).not.toHaveBeenCalled()
    wrap.remove()
    unmount()
    off()
  })
})
