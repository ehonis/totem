// The lobby's pure half: what each totem looks like and where it stands, with no
// three.js, so it can be tested.

export type FigureKind = 'agent' | 'builtin' | 'draft' | 'new'
export type FigureStatus = 'on' | 'off' | 'running' | 'error'

/** Everything the scene needs to carve one figure. A change to any field rebuilds it. */
export interface FigureSpec {
  id: string
  kind: FigureKind
  /** taskType for an agent ('watcher', 'writer', …); decides colour and headpiece. */
  type: string
  status: FigureStatus
  /** Woken by a watch rather than a clock: gets the eye. */
  watcher: boolean
}

// FNV-1a: a stable seed per id, so a totem is carved the same way every visit.
export function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}

// mulberry32
export function rng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Colour says what kind of work it does, so the lobby can be read at a glance.
const TYPE_HUE: Record<string, number> = {
  watcher: 168, researcher: 212, analyst: 262, writer: 40, organiser: 132, coach: 16, coder: 190, other: 318,
}
const BUILTIN_HUE = 222
const NEW_HUE = 200

export function hueFor(spec: Pick<FigureSpec, 'id' | 'kind' | 'type' | 'watcher'>): number {
  if (spec.kind === 'new') return NEW_HUE
  if (spec.kind === 'builtin') return BUILTIN_HUE
  const base = TYPE_HUE[spec.watcher && !TYPE_HUE[spec.type] ? 'watcher' : spec.type] ?? TYPE_HUE.other
  // A little jitter so two writers side by side are not twins.
  return (base + ((hash(spec.id) % 25) - 12) + 360) % 360
}

// --- the ring ----------------------------------------------------------------------

/** World units of arc between neighbours. */
export const SPACING = 3.4
/**
 * The smallest ring. Until three quarters of it would be filled they stand on an
 * arc of it; after that it closes, a little wider spaced, so browsing wraps.
 */
export const MIN_RADIUS = 7.5

export interface Ring { radius: number; step: number; full: boolean }

export function ringFor(count: number): Ring {
  const radius = Math.max(MIN_RADIUS, (count * SPACING) / (2 * Math.PI))
  const full = count * SPACING >= 1.5 * Math.PI * MIN_RADIUS
  return { radius, step: full ? (2 * Math.PI) / count : SPACING / radius, full }
}

const wrapPi = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI))

/**
 * The ring rotation that brings `index` to the front, nearest to `current` so a
 * full ring spins the short way round instead of unwinding.
 */
export function rotationFor(index: number, ring: Ring, current: number): number {
  const target = -index * ring.step
  return ring.full ? current + wrapPi(target - current) : target
}

/** Which item stands nearest the front at a given rotation. */
export function frontIndex(rotation: number, ring: Ring, count: number): number {
  if (!count) return -1
  const raw = Math.round(-rotation / ring.step)
  return ring.full ? ((raw % count) + count) % count : Math.min(count - 1, Math.max(0, raw))
}
