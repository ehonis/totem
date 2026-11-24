// When a chat's linked task was finished, added to the chat as `taskDoneAt` each
// time a chat is read (the list, a window, a write's answer, the threads tools), so
// every list settles it the way T3 Code settles a thread whose pull request merged
// (web/src/chat/settle.ts taskDoneSince has the rule: finished after the owner last
// wrote in it, and read).
//
// Worked out on read and never stored, so reopening the task brings the chat back
// by itself, and a task finished by any way in (the dashboard, the app, an agent's
// tool through the gateway, which writes the task database from its own process)
// counts the same. A local task counts when its status is done; a sheet row when
// the owner marked it done in Totem (todos/sheet-marks.mjs). A deleted task, a
// snoozed row, or a row the sheet itself closed (gone from the feed) doesn't.

const SHEET_REF = /^sheet:([^:]+):\d+:([^:]+)$/

/**
 * `task(id)`: the local task's DTO or null (todos/service.mjs get, synchronous).
 * `sheetMarks()`: every sheet mark by ref (the mark store's `all`).
 * `sheetRefs()`: the refs of the sheet's current rows, marked or not (the feed's
 * read, cached), asked for only when a chat names a row by a ref that has moved;
 * null when they can't be had in time, which leaves only exact refs matching.
 */
export function createTaskDone({ task, sheetMarks, sheetRefs = async () => [] }) {
  const localDoneAt = (id) => {
    let t = null
    try { t = task(id) } catch { return 0 }
    if (!t || t.deletedAt || t.status !== 'done') return 0
    return Date.parse(t.completedAt || t.updatedAt) || 0
  }

  // A row that moved keeps its tab and its title's hash, so a chat linked to its old
  // ref finds it among the sheet's current rows when exactly one matches, as
  // web/src/work/groups.ts resolveRef does; two rows with the same title are left
  // alone rather than guessed at.
  const resolveSheetRef = (ref, rows) => {
    const m = SHEET_REF.exec(ref)
    if (!m) return ref
    const same = rows.filter((k) => { const n = SHEET_REF.exec(k); return !!n && n[1] === m[1] && n[2] === m[2] })
    return same.length === 1 ? same[0] : ref
  }
  const sheetDoneAt = (ref, marks, rows) => {
    const mark = marks[ref] || (rows ? marks[resolveSheetRef(ref, rows)] : undefined)
    return mark?.state === 'done' ? Date.parse(mark.at) || 0 : 0
  }

  /** The threads, each with `taskDoneAt` set when its task is finished (and dropped otherwise). */
  async function decorate(threads) {
    const linked = threads.filter((t) => t && typeof t.taskId === 'string' && t.taskId)
    if (!linked.length) return threads
    let marks = {}
    let rows = null
    const sheet = linked.filter((t) => t.taskId.startsWith('sheet:'))
    if (sheet.length) {
      try { marks = (await sheetMarks()) || {} } catch { marks = {} }
      // Only for a ref that is not marked itself while a mark shares its tab and title (a
      // moved row, perhaps): most rows are simply open, and need no read of the sheet.
      const kin = (ref) => { const m = SHEET_REF.exec(ref); return m ? `${m[1]}:${m[2]}` : '' }
      const marked = new Set(Object.keys(marks).map(kin))
      if (sheet.some((t) => !marks[t.taskId] && marked.has(kin(t.taskId)))) {
        try { rows = (await sheetRefs()) || null } catch { rows = null }
      }
    }
    return threads.map((t) => {
      if (!t || typeof t.taskId !== 'string' || !t.taskId) return t
      const at = t.taskId.startsWith('sheet:') ? sheetDoneAt(t.taskId, marks, rows) : localDoneAt(t.taskId)
      const { taskDoneAt: _stale, ...rest } = t
      return at ? { ...rest, taskDoneAt: at } : rest
    })
  }

  return {
    decorate,
    async one(thread) { return thread ? (await decorate([thread]))[0] : thread },
  }
}
