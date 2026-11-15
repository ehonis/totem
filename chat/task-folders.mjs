// chat/task-folders.mjs — which chat project or folder each task is filed under.
//
// The chats panel's Tasks face lists the owner's tasks grouped by the project or
// folder they belong to, and a chat started from a task opens there. A task is a
// row in the task database (or a shared sheet row) and a folder is a chat project
// (chat/projects.mjs), so the link between them lives here, on the chat side,
// rather than as a column the task service would have to know about.
//
// Layout: one JSON file, { "<task ref>": "<project id>" }. Only the owner writes
// it, from the dashboard; it carries nothing secret. A project that no longer
// exists is dropped on read by the caller (it has the project list).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { validTaskRef } from './store.mjs'
import { validProjectId } from './projects.mjs'

export function createTaskFolderStore({ file } = {}) {
  if (!file) throw new TypeError('createTaskFolderStore requires file')
  let queue = Promise.resolve()

  async function all() {
    let raw = {}
    try { raw = JSON.parse(await readFile(file, 'utf8')) } catch {}
    const out = {}
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [task, project] of Object.entries(raw)) {
        if (validTaskRef(task) && validProjectId(project)) out[task] = project
      }
    }
    return out
  }

  async function write(map) {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(map, null, 2) + '\n')
    await rename(tmp, file)
  }

  function change(fn) {
    const run = queue.then(async () => {
      const map = await all()
      const out = fn(map)
      await write(map)
      return out
    })
    queue = run.catch(() => {})
    return run
  }

  /** File a task under a project or folder, or take it out of any with null. */
  function set(task, projectId) {
    if (!validTaskRef(task)) return Promise.reject(Object.assign(new Error('not a task id'), { status: 400 }))
    if (projectId != null && !validProjectId(projectId)) return Promise.reject(Object.assign(new Error('not a project id'), { status: 400 }))
    return change((map) => {
      if (projectId) map[task] = projectId
      else delete map[task]
      return map
    })
  }

  /** A project was deleted: its tasks move to its parent folder's project, or to none. */
  function reassign(projectId, to = null) {
    return change((map) => {
      for (const [task, p] of Object.entries(map)) {
        if (p !== projectId) continue
        if (to) map[task] = to
        else delete map[task]
      }
      return map
    })
  }

  return { all, set, reassign }
}
