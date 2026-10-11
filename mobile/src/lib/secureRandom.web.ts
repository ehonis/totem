// The web preview's secure random bytes: the browser's own crypto.
export function secureRandom(out: Uint8Array, n: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(n))
  out.set(bytes)
}
