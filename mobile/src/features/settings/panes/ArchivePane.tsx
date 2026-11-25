// Settings → Archive (web components/settings/ArchivePane.tsx): what was put away,
// and the way back. Only chat projects and folders for now (chat/projects.mjs
// `archivedAt`); nothing in Totem deletes one. An archived project carries its
// folders; a folder archived on its own is listed by itself, under its project's name.
import React, { useCallback, useEffect, useState } from 'react'
import { ApiError, AuthError } from '../../../lib/api'
import { listArchivedProjects } from '../../../lib/chat/api'
import { restoreProject } from '../../../lib/chat/store'
import type { ArchivedProject } from '../../../lib/chat/types'
import { pushError, pushSuccess } from '../../../lib/toast'
import { Btn } from '../../../ui/kit'
import { success, tap } from '../../../ui/haptics'
import { ProjectIcon } from '../../chat/ThreadIcon'
import { Loading, Row, Section } from '../ui'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function day(ts: number) {
  const d = new Date(ts)
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })
}

function archiveLine(p: ArchivedProject): string {
  const parts = [p.parentId ? `Folder in ${p.parentName || 'a project'}` : 'Project']
  if (p.folders.length) parts.push(`${plural(p.folders.length, 'folder')} (${p.folders.map((f) => f.name).join(', ')})`)
  parts.push(plural(p.chatCount, 'chat'))
  if (p.fileCount) parts.push(plural(p.fileCount, 'file'))
  parts.push(`archived ${day(p.archivedAt)}`)
  return parts.join(' · ')
}

export default function ArchivePane() {
  const [items, setItems] = useState<ArchivedProject[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const load = useCallback(() => {
    listArchivedProjects()
      .then((r) => { setItems(r.projects); setError('') })
      .catch((e) => { if (!(e instanceof AuthError)) setError(e instanceof ApiError ? e.message : String(e)) })
  }, [])
  useEffect(() => { load() }, [load])

  async function restore(p: ArchivedProject) {
    tap()
    setBusy(p.id)
    try {
      await restoreProject(p.id)
      setItems((list) => (list || []).filter((x) => x.id !== p.id))
      success()
      pushSuccess(`Restored ${p.name}`)
    } catch (e: any) {
      if (!(e instanceof AuthError)) pushError(`Couldn't restore it: ${e.message}`)
    } finally {
      setBusy(null)
      load()
    }
  }

  return (
    <Section
      id="archived-folders"
      title="Archived folders"
      description="Projects and folders you archived, with their chats, files and memory. Restoring one puts it back where it was."
    >
      {!items ? <Loading error={error} /> : !items.length ? (
        <Row title="Nothing archived" description="Archive a project or folder from the settings on its card on the web." />
      ) : items.map((p) => (
        <Row
          key={p.id}
          icon={<ProjectIcon p={p} size={18} />}
          title={p.name}
          description={archiveLine(p)}
          control={<Btn title={busy === p.id ? 'Restoring…' : 'Restore'} disabled={busy === p.id} onPress={() => void restore(p)} />}
        />
      ))}
    </Section>
  )
}
