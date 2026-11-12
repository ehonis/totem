import test from 'node:test'
import assert from 'node:assert/strict'
import { clamp, dragWidth, keyWidth, readWidth, roomIn, shareWidth, writeWidth, KEY_STEP, KEY_STEP_LARGE } from './panelResize.ts'

const bounds = { min: 300, max: 900 }

test('clamp keeps a width inside its bounds and rounds it', () => {
  assert.equal(clamp(120, bounds), 300)
  assert.equal(clamp(1200, bounds), 900)
  assert.equal(clamp(512.6, bounds), 513)
  // A container too small for the minimum still answers the minimum, never less.
  assert.equal(clamp(500, { min: 300, max: 200 }), 300)
})

test('a right-docked panel grows as the pointer moves left, a left-docked one as it moves right', () => {
  assert.equal(dragWidth(500, 1000, 900, 'right', bounds), 600)
  assert.equal(dragWidth(500, 1000, 1100, 'right', bounds), 400)
  assert.equal(dragWidth(268, 300, 400, 'left', { min: 220, max: 560 }), 368)
  assert.equal(dragWidth(268, 300, 200, 'left', { min: 220, max: 560 }), 220)
  assert.equal(dragWidth(500, 1000, -5000, 'right', bounds), 900)
})

test('arrow keys move the divider the way they point', () => {
  assert.equal(keyWidth('ArrowLeft', false, 500, 'right', bounds), 500 + KEY_STEP)
  assert.equal(keyWidth('ArrowRight', false, 500, 'right', bounds), 500 - KEY_STEP)
  assert.equal(keyWidth('ArrowRight', true, 500, 'left', bounds), 500 + KEY_STEP_LARGE)
  assert.equal(keyWidth('ArrowLeft', true, 500, 'left', bounds), 500 - KEY_STEP_LARGE)
  assert.equal(keyWidth('ArrowLeft', false, 895, 'right', bounds), 900)
  assert.equal(keyWidth('Home', false, 500, 'right', bounds), 300)
  assert.equal(keyWidth('End', false, 500, 'right', bounds), 900)
  assert.equal(keyWidth('Enter', false, 500, 'right', bounds), 'reset')
  assert.equal(keyWidth('a', false, 500, 'right', bounds), null)
  assert.equal(keyWidth('Escape', false, 500, 'right', bounds), null)
})

test('saved widths survive bad values and storage that throws', () => {
  const store = new Map<string, string>()
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }
  assert.equal(readWidth(storage, 'w'), null)
  writeWidth(storage, 'w', 512.4)
  assert.equal(store.get('w'), '512')
  assert.equal(readWidth(storage, 'w'), 512)
  writeWidth(storage, 'w', null)
  assert.equal(readWidth(storage, 'w'), null)
  for (const bad of ['', 'abc', '-40', '0', 'NaN', 'Infinity']) {
    store.set('w', bad)
    assert.equal(readWidth(storage, 'w'), null, bad)
  }
  const broken = {
    getItem: () => { throw new Error('blocked') },
    setItem: () => { throw new Error('blocked') },
    removeItem: () => { throw new Error('blocked') },
  }
  assert.equal(readWidth(broken, 'w'), null)
  assert.doesNotThrow(() => writeWidth(broken, 'w', 400))
  assert.equal(readWidth(undefined, 'w'), null)
})

test('a panel past its own room takes from its neighbours in turn, each down to its minimum', () => {
  const own = { min: 320, max: 400 }
  const term = { start: 520, min: 340 }, chats = { start: 268, min: 220 }
  assert.equal(roomIn([term, chats]), 180 + 48)
  // Within its own room the neighbours are untouched.
  assert.deepEqual(shareWidth(380, own, [term, chats]), { width: 380, neighbours: null })
  assert.deepEqual(shareWidth(400, own, [term, chats]), { width: 400, neighbours: null })
  // Past it, the terminal gives first; the chats panel is held where it is.
  assert.deepEqual(shareWidth(450, own, [term, chats]), { width: 450, neighbours: [470, 268] })
  // The terminal at its minimum, then the chats panel.
  assert.deepEqual(shareWidth(600, own, [term, chats]), { width: 600, neighbours: [340, 248] })
  // Everything at its minimum, and no further.
  assert.deepEqual(shareWidth(5000, own, [term, chats]), { width: 628, neighbours: [340, 220] })
  // A neighbour already under its minimum gives nothing and takes nothing back.
  assert.deepEqual(shareWidth(450, own, [{ start: 300, min: 340 }, chats]), { width: 448, neighbours: [300, 220] })
  // Narrower stays narrower; no neighbours, no sharing.
  assert.deepEqual(shareWidth(100, own, [term]), { width: 320, neighbours: null })
  assert.deepEqual(shareWidth(450, own, []), { width: 400, neighbours: null })
})
