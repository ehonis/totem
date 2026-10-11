// "Fix the transcript" as its own sheet: on the web it is a textarea inside the
// card; on a phone a long transcript wants the whole screen and the keyboard.
// Loads the entry fresh so an edit never starts from a stale copy.
import React, { useEffect, useState } from 'react'
import { router, useLocalSearchParams } from 'expo-router'
import { Btn, Spinner } from '../../ui/kit'
import { success } from '../../ui/haptics'
import { AuthError, getJournalEntry, updateJournalEntry } from '../../lib/api'
import { clearSecretStored } from '../../lib/connection'
import { pushError, pushSuccess } from '../../lib/toast'
import { entryTitle } from '../../lib/journal/format'
import type { JournalEntry } from '../../lib/journal/types'
import { FieldInput, SheetFrame, actionStyle } from '../productivity/SheetFrame'
import { emitEntryChanged } from './store'

const fail = (e: unknown, fallback: string) => {
  if (e instanceof AuthError) { void clearSecretStored(); return }
  pushError(e instanceof Error ? e.message : fallback)
}

export default function TranscriptSheet() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const [entry, setEntry] = useState<JournalEntry | null>(null)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!id) return
    getJournalEntry(id)
      .then(({ entry: e }) => { setEntry(e); setText(e.transcript?.text || '') })
      .catch((e) => fail(e, 'The entry could not load.'))
  }, [id])

  const save = async () => {
    if (!entry) return
    setSaving(true)
    try {
      const { entry: next } = await updateJournalEntry(entry.id, { transcript: text })
      emitEntryChanged(next)
      success()
      pushSuccess('Transcript saved.')
      router.back()
    } catch (e) {
      fail(e, 'The transcript could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const close = () => router.back()
  return (
    <SheetFrame
      kicker="Fix the transcript"
      title={entry ? entryTitle(entry) : 'Journal entry'}
      onClose={close}
      actions={entry ? (
        <>
          <Btn title="Cancel" onPress={close} disabled={saving} style={actionStyle} />
          <Btn title={saving ? 'Saving…' : 'Save transcript'} kind="primary" disabled={saving || !text.trim()} onPress={save} style={actionStyle} />
        </>
      ) : undefined}
    >
      {/* No autofocus: a long transcript under a raised keyboard shows a few lines;
          tapping the word to fix puts the caret there. */}
      {!entry ? <Spinner /> : (
        <FieldInput value={text} onChangeText={setText} multiline scrollEnabled={false} style={{ minHeight: 220, lineHeight: 24 }} />
      )}
    </SheetFrame>
  )
}
