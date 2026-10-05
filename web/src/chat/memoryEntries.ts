// A memory file as entries: each top-level bullet (with its indented lines) or
// paragraph, under the heading it sits beneath. The twin of memoryEntries in
// chat/projects.mjs; the bridge matches entries by their text, so keep the two
// in step.

export interface MemoryEntry {
  heading: string
  text: string
}

export function memoryEntries(text: string): MemoryEntry[] {
  const lines = String(text || '').split('\n')
  const out: MemoryEntry[] = []
  let heading = ''
  let cur: { heading: string; start: number } | null = null
  const close = (end: number) => {
    if (cur) { out.push({ heading: cur.heading, text: lines.slice(cur.start, end).join('\n').trimEnd() }); cur = null }
  }
  lines.forEach((line, i) => {
    if (/^#{1,6}\s/.test(line)) { close(i); heading = line.trim(); return }
    if (!line.trim()) { close(i); return }
    const bullet = /^\s{0,1}([-*+]|\d+[.)])\s/.test(line)
    if (cur && (!bullet || /^\s{2,}/.test(line))) return
    close(i)
    cur = { heading, start: i }
  })
  close(lines.length)
  return out
}
