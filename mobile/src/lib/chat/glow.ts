// Every chat gets its own glow: a pair of colours picked from the thread id, so
// it looks random across chats but stays the same each time one is opened.
// A copy of web/src/chat/glow.ts.

export const CHAT_GLOWS: { a: string; b: string }[] = [
  { a: '#6633ee', b: '#4f46e5' }, // violet, indigo
  { a: '#10b981', b: '#0ea5e9' }, // emerald, sky
  { a: '#f59e0b', b: '#f43f5e' }, // amber, rose
  { a: '#06b6d4', b: '#6366f1' }, // cyan, indigo
  { a: '#ec4899', b: '#8b5cf6' }, // pink, violet
  { a: '#22c55e', b: '#14b8a6' }, // green, teal
  { a: '#f97316', b: '#eab308' }, // orange, gold
  { a: '#3b82f6', b: '#a855f7' }, // blue, purple
  { a: '#e11d48', b: '#7c3aed' }, // crimson, violet
  { a: '#14b8a6', b: '#84cc16' }, // teal, lime
  { a: '#0ea5e9', b: '#22d3ee' }, // sky, cyan
  { a: '#d946ef', b: '#f43f5e' }, // magenta, rose
]

/** FNV-1a over the id: cheap, and spreads similar ids apart. */
export function chatGlow(id: string | null | undefined): { a: string; b: string } {
  if (!id) return CHAT_GLOWS[0]
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return CHAT_GLOWS[(h >>> 0) % CHAT_GLOWS.length]
}
