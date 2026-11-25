import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AuthError } from '../../api'
import { listArchivedProjects } from '../../chat/api'
import ProjectIcon from '../../chat/ProjectIcon'
import { restoreProject } from '../../chat/store'
import type { ArchivedProject } from '../../chat/types'
import { when } from '../../chat/ui'
import { pushError, pushSuccess } from '../../toast'
import { SettingsPage, SettingsRow, SettingsSection } from './ui'

// Settings → Archive: what was put away, and the way back. Only chat projects and
// folders for now (chat/projects.mjs `archivedAt`); nothing in Totem deletes one.
// An archived project carries its folders; a folder archived on its own is listed
// by itself, under its project's name.

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function archiveLine(p: ArchivedProject): string {
  const parts = [p.parentId ? `Folder in ${p.parentName || 'a project'}` : 'Project']
  if (p.folders.length) parts.push(`${plural(p.folders.length, 'folder')} (${p.folders.map((f) => f.name).join(', ')})`)
  parts.push(plural(p.chatCount, 'chat'))
  if (p.fileCount) parts.push(plural(p.fileCount, 'file'))
  parts.push(`archived ${when(p.archivedAt)}`)
  return parts.join(' · ')
}

export default function ArchivePane({ onAuthError }: { onAuthError: () => void }) {
  const [items, setItems] = useState<ArchivedProject[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  // The parent's callback changes identity on every render.
  const authError = useRef(onAuthError)
  authError.current = onAuthError
  const load = useCallback(() => {
    listArchivedProjects()
      .then((r) => { setItems(r.projects); setError('') })
      .catch((e) => { if (e instanceof AuthError) authError.current(); else setError(e instanceof Error ? e.message : String(e)) })
  }, [])
  useEffect(() => { load() }, [load])

  async function restore(p: ArchivedProject) {
    setBusy(p.id)
    try {
      await restoreProject(p.id)
      setItems((list) => (list || []).filter((x) => x.id !== p.id))
      pushSuccess(`Restored ${p.name}`)
    } catch (e: any) {
      if (e instanceof AuthError) authError.current()
      else pushError(`Couldn't restore it: ${e.message}`)
    } finally {
      setBusy(null)
      load()
    }
  }

  return (
    <SettingsPage>
      <SettingsSection
        id="archived-folders"
        title="Archived folders"
        description="Projects and folders you archived, with their chats, files and memory. Restoring one puts it back where it was."
      >
        {!items ? (
          <SettingsRow title={error ? 'Couldn’t load the archive' : 'Loading…'} description={error || undefined} />
        ) : !items.length ? (
          <SettingsRow title="Nothing archived" description="Archive a project or folder from the settings on its card." />
        ) : items.map((p) => (
          <SettingsRow
            key={p.id}
            title={<span className="stg-archive-name"><ProjectIcon p={p} size={16} />{p.name}</span>}
            description={archiveLine(p)}
            control={<button type="button" className="btn compact" disabled={busy === p.id} onClick={() => void restore(p)}>{busy === p.id ? 'Restoring…' : 'Restore'}</button>}
          />
        ))}
      </SettingsSection>
    </SettingsPage>
  )
}
