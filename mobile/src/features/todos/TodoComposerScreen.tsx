// New task (web/src/todos/TodoComposer.tsx in its "Private by default" modal), as
// a form sheet. The half-typed draft survives closing the sheet, as on the web.
import React, { useEffect, useRef, useState } from 'react'
import { StyleSheet, View, type TextInput } from 'react-native'
import { router } from 'expo-router'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Toggle } from '../../ui/kit'
import { success } from '../../ui/haptics'
import { createBoardTodo, getTodo } from '../../lib/api'
import type { SyncTarget, Todo, TodoArea, VentureTag } from '../../lib/todos/types'
import { useVentureTags } from '../../lib/todos/ventureTags'
import { loadBoard, prependTodo } from './store'
import { DateField, Field, FieldInput, InlineError, SelectField, SheetFrame } from './ui'

const DRAFT_KEY = 'totem.todo-draft.new'
type TodoDraft = Partial<{ title: string; description: string; area: TodoArea; ventureTag: VentureTag | ''; priority: Todo['priority']; dueDate: string; syncTarget: SyncTarget; repo: string }>
export const todoDraftStore = {
  get(): TodoDraft {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') }
    catch { return {} }
  },
  set(value: TodoDraft) { localStorage.setItem(DRAFT_KEY, JSON.stringify(value)) },
  clear() { localStorage.removeItem(DRAFT_KEY) },
}

const PRIORITIES: { value: Todo['priority']; label: string }[] = [
  { value: 4, label: 'P1 · Urgent ❗❗❗' }, { value: 3, label: 'P2 · High ❗❗' }, { value: 2, label: 'P3 · Medium ❗' }, { value: 1, label: 'P4 · None' },
]

export default function TodoComposerScreen() {
  // Ventures appears only once the install has venture tags (Settings -> Tasks).
  const ventureTags = useVentureTags()
  const [draft] = useState(() => todoDraftStore.get())
  const [title, setTitle] = useState(draft.title || '')
  const [description, setDescription] = useState(draft.description || '')
  const [area, setArea] = useState<TodoArea>(draft.area || 'Personal')
  const [ventureTag, setVentureTag] = useState<VentureTag | ''>(draft.ventureTag || '')
  const [priority, setPriority] = useState<Todo['priority']>(draft.priority || 1)
  const [dueDate, setDueDate] = useState(draft.dueDate || '')
  const [syncTarget, setSyncTarget] = useState<SyncTarget>(draft.syncTarget || 'local')
  const [repo, setRepo] = useState(draft.repo || '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const titleInput = useRef<TextInput>(null)
  const showVentures = ventureTags.length > 0 || area === 'Ventures'

  useEffect(() => {
    if (!title && !description && !dueDate && area === 'Personal' && syncTarget === 'local') todoDraftStore.clear()
    else todoDraftStore.set({ title, description, area, ventureTag, priority, dueDate, syncTarget, repo })
  }, [title, description, area, ventureTag, priority, dueDate, syncTarget, repo])

  // Focus once the sheet has finished rising: autoFocus fires mid-presentation, and
  // the keyboard arriving then makes the form sheet jump and re-lay itself out.
  useEffect(() => {
    const timer = setTimeout(() => titleInput.current?.focus(), 450)
    return () => clearTimeout(timer)
  }, [])

  async function submit() {
    setError('')
    if (!title.trim()) return setError('Enter a task title.')
    if (syncTarget === 'sheet' && (area !== 'Ventures' || !ventureTag)) return setError('Choose Ventures and a venture tag before syncing with Action Items.')
    if (syncTarget === 'github' && !/^[^/\s]+\/[^/\s]+$/.test(repo.trim())) return setError('Choose a GitHub repository as owner/name.')
    if (area === 'Ventures' && !ventureTag) return setError('Choose a venture tag for Ventures.')
    setBusy(true)
    try {
      const { todo: created } = await createBoardTodo({ title: title.trim(), description, area, ventureTag: area === 'Ventures' ? ventureTag as VentureTag : null, priority, dueDate: dueDate || null, syncTarget, ...(syncTarget === 'github' ? { repo: repo.trim() } : {}) })
      todoDraftStore.clear()
      success()
      router.back()
      // POST /api/todos answers in the old Todoist shape (content, due, labels), not
      // a board task; putting that on the board crashed it. Read the task back.
      try { prependTodo((await getTodo(created.id)).todo) }
      catch { void loadBoard() }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Task could not be created.'); setBusy(false) }
  }

  return (
    <SheetFrame kicker="Private by default" title="New task" onClose={() => router.back()}>
      <Field label="Task"><FieldInput ref={titleInput} value={title} onChangeText={setTitle} placeholder="What needs doing?" returnKeyType="done" onSubmitEditing={() => void submit()} /></Field>
      <Field label="Notes"><FieldInput multiline value={description} onChangeText={setDescription} placeholder="Optional context" /></Field>
      {/* One control per row, as the web's phone layout: two leave each too narrow to read. */}
      <Field label="Area">
        <SelectField label="Area" value={area}
          options={[{ value: 'Personal' as TodoArea, label: 'Personal' }, ...(showVentures ? [{ value: 'Ventures' as TodoArea, label: 'Ventures' }] : [])]}
          onChange={(v) => { setArea(v); if (v === 'Personal') setVentureTag('') }} />
      </Field>
      {showVentures ? (
        <Field label="Venture tag">
          <SelectField label="Venture tag" disabled={area !== 'Ventures'} value={ventureTag} placeholder="Choose tag"
            options={ventureTags.map((tag) => ({ value: tag.name, label: tag.name }))} onChange={setVentureTag} />
        </Field>
      ) : null}
      <Field label="Priority"><SelectField label="Priority" value={priority} options={PRIORITIES} onChange={setPriority} /></Field>
      <Field label="Due date"><DateField mode="date" value={dueDate} onChange={setDueDate} /></Field>
      <View style={st.share}>
        <T size={11.5} weight={700} muted>Sharing</T>
        <View style={st.toggleRow}>
          <T size={14} style={{ flex: 1 }}>Sync with Action Items</T>
          <Toggle value={syncTarget === 'sheet'} onChange={(on) => setSyncTarget(on ? 'sheet' : 'local')} />
        </View>
        <View style={st.toggleRow}>
          <T size={14} style={{ flex: 1 }}>Create a GitHub issue</T>
          <Toggle value={syncTarget === 'github'} onChange={(on) => setSyncTarget(on ? 'github' : 'local')} />
        </View>
        <T size={12} muted>{syncTarget === 'local' ? 'Private in Totem.' : syncTarget === 'sheet' ? 'Creates and syncs an Action Items row.' : 'Publishing is explicit; Totem will ask for the repository.'}</T>
      </View>
      {syncTarget === 'github' ? (
        <Field label="GitHub repository"><FieldInput value={repo} onChangeText={setRepo} placeholder="owner/repository" autoCapitalize="none" autoCorrect={false} /></Field>
      ) : null}
      <InlineError>{error}</InlineError>
      <View style={st.actions}>
        <Btn title="Cancel" onPress={() => router.back()} disabled={busy} style={st.action} />
        <Btn kind="primary" title={busy ? 'Creating…' : 'Create task'} onPress={() => void submit()} disabled={busy} style={st.action} />
      </View>
    </SheetFrame>
  )
}

const st = StyleSheet.create({
  share: { gap: 8, paddingVertical: 11, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 8 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 2 },
  action: { flex: 1, minHeight: 44 },
})
