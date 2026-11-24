// The chat projects and folders the drawer files chats under. The GET cache keeps
// the bridge's last list (http/etag.mjs tags it), so a cold start draws them at once,
// before a weak connection answers, and no chat shows in Home and then jumps into
// its folder. No React Native here: node's test runner loads it.
import type { GetOptions } from '../httpCache'
import type { Project } from './types'

export const PROJECTS_PATH = '/api/chat/projects'

// A refresh never answers the stored copy: the store's list is newer than the disk
// (a project made or renamed on this phone since), so a slow or failed refresh keeps
// what the store has. The list is small; one stuck request gives way to the next poll.
export const PROJECTS_GET: GetOptions = { stored: false, deadlineMs: 20_000 }

interface Scope { projects: Project[]; projectId: string | null }

export function projectList({ peek, list, get, set, fail }: {
  peek: () => { projects: Project[] } | undefined
  list: () => Promise<{ projects: Project[] }>
  get: () => Scope
  set: (patch: Partial<Scope>) => void
  fail: (e: unknown) => unknown
}) {
  // Bumped by every change the phone makes to its own list (made, renamed, deleted).
  let clock = 0
  return {
    /** The list the bridge gave last time, before the first refresh. */
    seed() {
      const stored = peek()?.projects
      if (Array.isArray(stored)) set({ projects: stored })
    },
    /** The phone changed a project: a list asked for before now is out of date. */
    changed() { clock++ },
    /**
     * The bridge's list replaces the store's, and a project page whose project went
     * closes. A failure keeps both, and so does a list asked for before the phone's
     * last change (a poll still out when a project was made): the next one has it.
     */
    async load() {
      const askedAt = clock
      try {
        const { projects } = await list()
        // Not a list (a sign-in or captive page answered): keep what the app holds.
        if (!Array.isArray(projects)) throw new Error('The bridge did not answer with the projects list.')
        if (askedAt !== clock) return
        const { projectId } = get()
        set({ projects, projectId: projectId && !projects.some((p) => p.id === projectId) ? null : projectId })
      } catch (e) { fail(e) }
    },
  }
}
