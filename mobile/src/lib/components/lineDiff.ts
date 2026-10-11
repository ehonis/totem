// A line diff, so an AI's proposed edit to a skill can be read before it is
// accepted. Small and self-contained on purpose: the alternative is a dependency
// for something that is one dynamic-programming table.

export type DiffOp = 'same' | 'add' | 'remove'

export interface DiffRow {
  op: DiffOp
  text: string
  /** 1-based line number in the original, or null for an added line. */
  beforeLine: number | null
  /** 1-based line number in the revision, or null for a removed line. */
  afterLine: number | null
}

// Above this, the O(n×m) table stops being worth building. A skill body is tens
// of lines; anything approaching this is not a document a person is reading a
// diff of, so it degrades to "all of it changed" rather than locking the tab.
const MAX_LINES = 3000

export function lineDiff(before: string, after: string): DiffRow[] {
  const a = String(before ?? '').split('\n')
  const b = String(after ?? '').split('\n')
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text, i) => ({ op: 'remove' as DiffOp, text, beforeLine: i + 1, afterLine: null })),
      ...b.map((text, i) => ({ op: 'add' as DiffOp, text, beforeLine: null, afterLine: i + 1 })),
    ]
  }

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ op: 'same', text: a[i], beforeLine: i + 1, afterLine: j + 1 })
      i++; j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      // Removals before additions at the same position, so a changed line reads
      // as "was this, now that" in the order a person expects.
      rows.push({ op: 'remove', text: a[i], beforeLine: i + 1, afterLine: null })
      i++
    } else {
      rows.push({ op: 'add', text: b[j], beforeLine: null, afterLine: j + 1 })
      j++
    }
  }
  while (i < a.length) { rows.push({ op: 'remove', text: a[i], beforeLine: i + 1, afterLine: null }); i++ }
  while (j < b.length) { rows.push({ op: 'add', text: b[j], beforeLine: null, afterLine: j + 1 }); j++ }
  return rows
}

export interface DiffHunk {
  rows: DiffRow[]
  /** Unchanged lines collapsed away immediately before this hunk. */
  skipped: number
}

// Group into hunks with `context` unchanged lines around each change, and report
// how many lines were collapsed between them. A skill body is mostly unchanged
// text; showing all of it buries the two lines that matter.
export function diffHunks(rows: DiffRow[], context = 3): DiffHunk[] {
  const changed = rows.map((r) => r.op !== 'same')
  if (!changed.some(Boolean)) return []
  const keep = new Array(rows.length).fill(false)
  for (let i = 0; i < rows.length; i++) {
    if (!changed[i]) continue
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true
  }
  const hunks: DiffHunk[] = []
  let current: DiffRow[] = []
  let skipped = 0
  let pendingSkip = 0
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      if (!current.length) { skipped = pendingSkip; pendingSkip = 0 }
      current.push(rows[i])
    } else {
      if (current.length) { hunks.push({ rows: current, skipped }); current = [] }
      pendingSkip++
    }
  }
  if (current.length) hunks.push({ rows: current, skipped })
  return hunks
}

export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const r of rows) {
    if (r.op === 'add') added++
    else if (r.op === 'remove') removed++
  }
  return { added, removed }
}
