// The keyboard goes down as the drawer starts to open, whether a swipe or the Menu
// button opens it: the chat composer rides the keyboard over the drawer and would
// leave half of it out of reach. `(app)/_layout.tsx` watches the drawer's progress
// (0 shut, 1 open) on the UI thread and asks this at every step.

// Below this the drawer counts as shut: a few points of the drawer.
const SHUT = 0.01

/** Whether this step is the drawer leaving shut: once per opening, never while closing. */
export function startsOpening(progress: number, previous: number | null) {
  'worklet'
  return previous !== null && previous < SHUT && progress >= SHUT
}
