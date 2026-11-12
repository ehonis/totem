// The arithmetic behind every resizable side panel (components/ResizeHandle.tsx).
// Kept free of the DOM so it can be tested on its own.
//
// A panel is docked to one side of the screen. Its handle sits on the edge that
// faces the page, so a right-docked panel (terminal, files, browser, agents, the
// canvas) grows as the pointer moves left and a left-docked one (the chats
// panel) grows as it moves right.

export type Dock = 'left' | 'right'

export interface Bounds { min: number; max: number }

/** Arrow keys move by this much; with Shift, by the larger step. */
export const KEY_STEP = 16
export const KEY_STEP_LARGE = 64

export function clamp(width: number, { min, max }: Bounds): number {
  return Math.round(Math.min(Math.max(width, min), Math.max(min, max)))
}

/** The width a drag that started at `startX` on a panel `startWidth` wide has reached at `x`. */
export function dragWidth(startWidth: number, startX: number, x: number, dock: Dock, bounds: Bounds): number {
  const moved = dock === 'right' ? startX - x : x - startX
  return clamp(startWidth + moved, bounds)
}

/**
 * What a key does on a focused handle: a new width, `'reset'` for the default,
 * or null when the key is not the handle's. The arrows move the divider the way
 * they point, so on a right-docked panel ArrowLeft widens it.
 */
export function keyWidth(key: string, shift: boolean, width: number, dock: Dock, bounds: Bounds): number | 'reset' | null {
  const step = shift ? KEY_STEP_LARGE : KEY_STEP
  const grow = dock === 'right' ? 'ArrowLeft' : 'ArrowRight'
  const shrink = dock === 'right' ? 'ArrowRight' : 'ArrowLeft'
  if (key === grow) return clamp(width + step, bounds)
  if (key === shrink) return clamp(width - step, bounds)
  if (key === 'Home') return clamp(bounds.min, bounds)
  if (key === 'End') return clamp(bounds.max, bounds)
  if (key === 'Enter') return 'reset'
  return null
}

/** A neighbouring panel a handle may take room from: its width now and its minimum. */
export interface Give { start: number; min: number }

/** The room the neighbours can give, all told. */
export const roomIn = (gives: Give[]) => gives.reduce((sum, g) => sum + Math.max(0, g.start - g.min), 0)

/**
 * Where a panel wanting `want` lands when it may take room from its neighbours,
 * the way VS Code's sashes do. Up to `bounds.max` (what the page beside it can
 * spare) the neighbours are untouched (`neighbours: null`). Past it, the room
 * comes from each neighbour in turn, down to its minimum; and once any is taken,
 * every neighbour is held at its width (`neighbours` lists them all), so one
 * that was squeezed cannot grow back into the room just made.
 */
export function shareWidth(want: number, bounds: Bounds, gives: Give[]): { width: number; neighbours: number[] | null } {
  const width = clamp(want, { min: bounds.min, max: bounds.max + roomIn(gives) })
  let extra = width - bounds.max
  if (extra <= 0) return { width, neighbours: null }
  const neighbours = gives.map((g) => {
    const take = Math.min(extra, Math.max(0, g.start - g.min))
    extra -= take
    return Math.round(g.start - take)
  })
  return { width, neighbours }
}

/** A saved width, or null when there is none (or storage is unavailable). */
export function readWidth(storage: Pick<Storage, 'getItem'> | undefined, key: string): number | null {
  try {
    const value = Number(storage?.getItem(key))
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null
  } catch {
    return null
  }
}

/** Saves a width, or forgets it when `width` is null. Storage failures are ignored. */
export function writeWidth(storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined, key: string, width: number | null): void {
  try {
    if (width === null) storage?.removeItem(key)
    else storage?.setItem(key, String(Math.round(width)))
  } catch {
    // Private mode or blocked storage: the width just isn't remembered.
  }
}
