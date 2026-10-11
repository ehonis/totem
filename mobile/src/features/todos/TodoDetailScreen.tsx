// Task details (web/src/todos/TodoDetailSheet.tsx) as a form sheet: the edit form,
// the append-only notes, related tasks, and sharing / source controls. Opened from
// a card with ?focus=notes it lands on the note field, as "+ Add a note" does on the web.
import React, { useEffect, useRef, useState } from 'react'
import { StyleSheet, View, type TextInput } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import type { KeyboardAwareScrollViewRef } from 'react-native-keyboard-controller'
import * as WebBrowser from 'expo-web-browser'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press, Spinner } from '../../ui/kit'
import { success } from '../../ui/haptics'
import { Hi, ArrowPathIcon, ArrowTopRightOnSquareIcon } from '../../lib/icons'
import {
  addTodoNote, detachTodoExternalLink, getTodo, linkRelatedTodo, publishTodoFirstNote,
  refreshBoardTodo, shareBoardTodo, unlinkRelatedTodo, updateBoardTodo,
} from '../../lib/api'
import { priorityLabel, priorityMarks, todoSource, type Todo, type TodoArea, type VentureTag } from '../../lib/todos/types'
import { useVentureTags } from '../../lib/todos/ventureTags'
import { acceptTodo, findTodo, loadBoard, useBoard } from './store'
import { localDateTimeKey } from './format'
import { DateField, Field, FieldInput, InlineError, InlineNotice, SectionHead, SelectField, SheetFrame, SheetHead, st as ui } from './ui'

const REPEAT_OPTIONS = [
  { value: '', label: 'Does not repeat' }, { value: 'daily', label: 'Daily' }, { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }, { value: 'yearly', label: 'Yearly' },
]

export default function TodoDetailScreen() {
  const { id, focus } = useLocalSearchParams<{ id: string; focus?: string }>()
  const board = useBoard()
  const [todo, setTodo] = useState<Todo | null>(() => findTodo(id) ?? null)
  const [loadError, setLoadError] = useState('')

  // Opened from somewhere the board has not loaded (a deep link, the archive after a reload).
  useEffect(() => {
    if (todo) return
    getTodo(id).then((r) => setTodo(r.todo)).catch((cause) => setLoadError(cause instanceof Error ? cause.message : 'This task could not load.'))
  }, [id, todo])

  if (todo) return <DetailForm original={todo} allTodos={board.todos} initialFocus={focus === 'notes' ? 'notes' : 'details'} />
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg2 }}>
      <SheetHead kicker="Task" title="Task details" onClose={() => router.back()} />
      {loadError ? <View style={{ padding: 16 }}><InlineError>{loadError}</InlineError></View> : <Spinner />}
    </View>
  )
}

function DetailForm({ original, allTodos, initialFocus }: { original: Todo; allTodos: Todo[]; initialFocus: 'details' | 'notes' }) {
  const [todo, setTodo] = useState(original)
  const [form, setForm] = useState(() => ({
    title: original.title, description: original.description, area: original.area, ventureTag: original.ventureTag || '',
    priority: original.priority, dueDate: original.dueDate || '', recurrence: original.recurrence || '',
    snoozedUntil: original.snoozedUntil ? localDateTimeKey(new Date(original.snoozedUntil)) : '',
  }))
  const ventureTags = useVentureTags()
  // A task may carry a tag that has since left the list; keep it selectable.
  const ventureTagOptions = [...ventureTags.map((tag) => tag.name), ...(original.ventureTag && !ventureTags.some((tag) => tag.name === original.ventureTag) ? [original.ventureTag] : [])]
  const [note, setNote] = useState('')
  const [relatedId, setRelatedId] = useState('')
  const [repo, setRepo] = useState('')
  const [busy, setBusy] = useState('')
  // Which action the error or notice belongs to: it shows beside that action's button,
  // since a message at the top of a long sheet is out of sight.
  const [at, setAt] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const scroll = useRef<KeyboardAwareScrollViewRef>(null)
  const noteInput = useRef<TextInput>(null)
  const focusedNotes = useRef(initialFocus !== 'notes')
  const source = todoSource(todo)
  const link = todo.externalLinks.find((item) => item.connector === source)
  const set = <K extends keyof typeof form>(field: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [field]: value }))
  const showVentures = ventureTags.length > 0 || form.area === 'Ventures'

  function accept(next: Todo) { setTodo(next); acceptTodo(next) }
  async function run(name: string, action: () => Promise<void>) {
    setBusy(name); setAt(name); setError(''); setNotice('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : 'The task could not be updated.') }
    finally { setBusy('') }
  }

  const save = () => void run('save', async () => {
    const { todo: next } = await updateBoardTodo(todo.id, {
      title: form.title, description: form.description, area: form.area as TodoArea,
      ventureTag: form.area === 'Ventures' ? form.ventureTag as VentureTag : null,
      priority: Number(form.priority) as Todo['priority'], dueDate: form.dueDate || null,
      recurrence: form.recurrence || null,
      snoozedUntil: form.snoozedUntil ? new Date(form.snoozedUntil).toISOString() : null,
    })
    accept(next); setNotice('Saved.'); success()
    // A snooze set or cleared here moves the task between the board and the snoozed panel.
    if ((next.snoozedUntil || null) !== (original.snoozedUntil || null)) void loadBoard()
  })

  async function stopSync() {
    if (source === 'local') return
    await run('unshare', async () => {
      accept((await detachTodoExternalLink(todo.id, source)).todo)
      setNotice(source === 'sheet' ? 'Sync stopped. The row stays in Action Items.' : 'Sync stopped. The GitHub issue remains open.')
    })
  }

  async function share(target: 'github' | 'sheet', options: Record<string, unknown> = {}) {
    await run(`share-${target}`, async () => {
      accept((await shareBoardTodo(todo.id, target, options)).todo)
      setNotice(target === 'sheet' ? 'Syncing with Action Items.' : 'GitHub issue queued for creation.')
    })
  }

  const feedback = (...names: string[]) => (names.includes(at) && (error || notice)
    ? <><InlineError>{error}</InlineError><InlineNotice>{notice}</InlineNotice></>
    : null)

  const relatable = allTodos.filter((item) => item.id !== todo.id && !todo.relations.some((relation) => relation.id === item.id))
  const repoValid = /^[^/\s]+\/[^/\s]+$/.test(repo.trim())

  return (
    <SheetFrame ref={scroll} kicker={source === 'local' ? 'Private task' : source === 'sheet' ? 'Action Items task' : 'GitHub task'} title="Task details" onClose={() => router.back()}>

      <View style={st.form}>
        <Field label="Task"><FieldInput value={form.title} onChangeText={(v) => set('title', v)} /></Field>
        <Field label="Description"><FieldInput multiline value={form.description} onChangeText={(v) => set('description', v)} /></Field>
        <Field label="Area">
          <SelectField
            label="Area" value={form.area}
            options={[{ value: 'Personal', label: 'Personal' }, ...(showVentures ? [{ value: 'Ventures' as TodoArea, label: 'Ventures' }] : [])]}
            onChange={(v) => { set('area', v); if (v === 'Personal') set('ventureTag', '') }}
          />
        </Field>
        {showVentures ? (
          <Field label="Venture tag">
            <SelectField label="Venture tag" disabled={form.area !== 'Ventures'} value={form.ventureTag} placeholder="Choose tag"
              options={ventureTagOptions.map((name) => ({ value: name, label: name }))} onChange={(v) => set('ventureTag', v)} />
          </Field>
        ) : null}
        <Field label="Priority">
          <SelectField label="Priority" value={form.priority}
            options={([4, 3, 2, 1] as Todo['priority'][]).map((value) => ({ value, label: `${priorityLabel(value)} ${priorityMarks(value)}`.trim() }))}
            onChange={(v) => set('priority', v)} />
        </Field>
        <Field label="Due date"><DateField mode="date" value={form.dueDate} onChange={(v) => set('dueDate', v)} /></Field>
        <Field label="Repeat"><SelectField label="Repeat" value={form.recurrence} options={REPEAT_OPTIONS} onChange={(v) => set('recurrence', v)} /></Field>
        <Field label="Snooze until">
          <DateField mode="datetime" value={form.snoozedUntil} onChange={(v) => set('snoozedUntil', v)}
            defaultValue={() => { const at = new Date(); at.setDate(at.getDate() + 1); at.setHours(9, 0, 0, 0); return at }} />
        </Field>
        <Btn kind="primary" title={busy === 'save' ? 'Saving…' : 'Save changes'} disabled={Boolean(busy)} onPress={save} style={st.primary} />
        {feedback('save')}
      </View>

      <View style={ui.section} onLayout={(e) => {
        if (focusedNotes.current) return
        focusedNotes.current = true
        const y = e.nativeEvent.layout.y - 12
        // Wait for the sheet to finish rising before scrolling and raising the keyboard.
        setTimeout(() => { scroll.current?.scrollTo({ y, animated: true }); noteInput.current?.focus() }, 450)
      }}>
        <SectionHead title="Notes" aside="Append-only" />
        {todo.notes.length ? todo.notes.map((item) => (
          <View key={item.id} style={st.note}>
            <T size={14} style={{ marginBottom: 5 }} selectable>{item.body}</T>
            <T size={10} muted>{new Date(item.createdAt).toLocaleString()}</T>
          </View>
        )) : <T size={13} muted>No notes yet.</T>}
        <FieldInput ref={noteInput} value={note} onChangeText={setNote} placeholder="Add context without rewriting history" accessibilityLabel="New note"
          returnKeyType="send" onSubmitEditing={() => addNote()} />
        <Btn title="Append note" disabled={busy === 'note' || !note.trim()} onPress={() => addNote()} />
        {feedback('note')}
      </View>

      <View style={ui.section}>
        <SectionHead title="Related tasks" aside={todo.relations.length} />
        {todo.relations.map((relation) => (
          <View key={relation.id} style={st.relation}>
            <T size={14} style={{ flex: 1 }}>{relation.title}</T>
            <Press haptic onPress={() => void run('relation', async () => accept((await unlinkRelatedTodo(todo.id, relation.id)).todo))}>
              <T size={13} muted style={{ textDecorationLine: 'underline' }}>Remove relation</T>
            </Press>
          </View>
        ))}
        <SelectField label="Related task" value={relatedId} placeholder="Choose task"
          options={relatable.map((item) => ({ value: item.id, label: item.title }))} onChange={setRelatedId} />
        <Btn title="Relate" disabled={!relatedId || busy === 'relation'} onPress={() => void run('relation', async () => { accept((await linkRelatedTodo(todo.id, relatedId)).todo); setRelatedId('') })} />
        {feedback('relation')}
      </View>

      {source === 'local' ? (
        <View style={ui.section}>
          <SectionHead title="Share" aside="Optional" />
          <T size={13} muted>This task stays private until you choose one destination.</T>
          <Btn title="Sync with Action Items" disabled={todo.area !== 'Ventures' || !todo.ventureTag || Boolean(busy)} onPress={() => void share('sheet')} />
          <FieldInput value={repo} onChangeText={setRepo} placeholder="owner/repository" autoCapitalize="none" autoCorrect={false} accessibilityLabel="GitHub repository for sharing" />
          <Btn title="Create GitHub issue" disabled={!repoValid || Boolean(busy)} onPress={() => void share('github', { repo: repo.trim() })} />
          {todo.area !== 'Ventures' ? <T size={13} muted>Action Items sharing requires a Ventures task with a venture tag.</T> : null}
          {feedback('share-sheet', 'share-github')}
        </View>
      ) : (
        <View style={ui.section}>
          <SectionHead title="Source" aside={todo.syncState.status} />
          {link?.externalUrl ? (
            <Press onPress={() => void WebBrowser.openBrowserAsync(link.externalUrl!)} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }} accessibilityRole="link">
              <T size={14} color={colors.accent}>{`Open ${source === 'sheet' ? 'Action Items row' : 'GitHub issue'}`}</T>
              <Hi icon={ArrowTopRightOnSquareIcon} size={13} color={colors.accent} />
            </Press>
          ) : null}
          <View style={st.actions}>
            <Btn icon={ArrowPathIcon} title="Refresh" loading={busy === 'refresh'} onPress={() => void run('refresh', async () => accept((await refreshBoardTodo(todo.id)).todo))} />
            {source === 'github' && todo.notes.length > 0
              ? <Btn title="Publish first note as issue description" onPress={() => void run('publish', async () => accept((await publishTodoFirstNote(todo.id)).todo))} />
              : null}
            <Btn kind="danger" title="Stop syncing" disabled={busy === 'unshare'} onPress={() => void stopSync()} />
          </View>
          {feedback('refresh', 'publish', 'unshare')}
        </View>
      )}
    </SheetFrame>
  )

  function addNote() {
    if (!note.trim()) return
    void run('note', async () => {
      const { note: saved } = await addTodoNote(todo.id, note.trim())
      accept({ ...todo, notes: [...todo.notes, saved] }); setNote('')
    })
  }
}

const st = StyleSheet.create({
  form: { gap: 13 },
  primary: { minHeight: 44, marginTop: 2 },
  note: { paddingVertical: 9, paddingHorizontal: 10, borderWidth: 1, borderColor: colors.line, borderRadius: 7, backgroundColor: colors.bg },
  relation: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36 },
  actions: { gap: 7 },
})
