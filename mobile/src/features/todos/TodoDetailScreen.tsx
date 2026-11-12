// A task's page (web/src/todos/TodoDetailSheet.tsx), rebuilt for the phone (#179):
// the title and description edit in place and save on blur, a large circle
// completes the task, and every other field is one row that opens a native menu and
// saves that field at once. Nothing waits for a Save button. Below: notes, related
// tasks, the linked GitHub issue, and the task's history.
// Opened from a card with ?focus=notes it lands on the note field, as "+ Add a note"
// does on the web. A "sheet:…" id is a row of the shared task sheet, which opens the
// read-only SheetItemPage instead.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { MenuView, type MenuAction } from '@react-native-menu/menu'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { KeyboardAwareScrollView, type KeyboardAwareScrollViewRef } from 'react-native-keyboard-controller'
import IconProgress from '@tabler/icons-react-native/dist/esm/icons/IconProgress.mjs'
import IconRepeat from '@tabler/icons-react-native/dist/esm/icons/IconRepeat.mjs'
import { colors, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, IconBtn, Spinner } from '../../ui/kit'
import { success, tap, warn } from '../../ui/haptics'
import { confirm } from '../../ui/menu'
import { CHAT_ABOUT_ACTION, chatAbout } from '../../ui/chatAbout'
import { pushError } from '../../lib/toast'
import { todoContext } from '../../lib/chat/about/context'
import {
  Hi, BriefcaseIcon, CalendarDaysIcon, ClockIcon, EllipsisHorizontalIcon, FlagIcon, XMarkIcon,
} from '../../lib/icons'
import {
  addTodoNote, getTodo, linkRelatedTodo, moveBoardTodo, setIssueLink, unlinkRelatedTodo, updateBoardTodo,
} from '../../lib/api'
import {
  priorityLabel, priorityMarks, type IssueState, type Todo, type TodoOutcome, type TodoPatch, type TodoStatus,
} from '../../lib/todos/types'
import { useVentureTags } from '../../lib/todos/ventureTags'
import { acceptTodo, findTodo, getBoard, loadBoard, loadIssueStates, loadSheet, removeTodo, useBoard } from './store'
import { afterDone, rollsOnCompletion } from './board'
import { undoText } from './undo'
import { dateKey, dueDateChoices, dueText, dueTone, snoozeTimes } from './format'
import { InlineError, InlineNotice, PickWhenSheet, tone } from './ui'
import { openTodo } from './nav'
import { CompleteCircle } from './detail/CompleteCircle'
import { PropertyGroup, PropertyRow } from './detail/PropertyRow'
import { SavedMark, UndoLine, whenLabel, type UndoState } from './detail/bits'
import { HistorySection, IssueLinkSection, NotesSection, RelatedSection } from './detail/sections'
import { serialQueue, textPatch, undoMove } from './detail/model'
import { PRIORITY_COLOR, PRIORITY_WORD } from './compose/labels'
import { issueKey, issueLinkOf, sheetName } from './list'
import SheetItemPage, { isSheetId } from './SheetItemPage'
import { askOncePerKey, shouldAskIssueState } from './issueLink'

const REPEAT_OPTIONS = [
  { value: '', label: 'Does not repeat' }, { value: 'daily', label: 'Daily' }, { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }, { value: 'yearly', label: 'Yearly' },
]

// A half-written note outlives the sheet: notes are append-only, so sending one on a
// swipe-down would be a step too far, and dropping it would lose the words.
const noteDraftKey = (id: string) => `totem.todo-note-draft.${id}`
const noteDraft = {
  get(id: string) { try { return localStorage.getItem(noteDraftKey(id)) || '' } catch { return '' } },
  set(id: string, value: string) {
    try { if (value) localStorage.setItem(noteDraftKey(id), value); else localStorage.removeItem(noteDraftKey(id)) } catch { /* not kept */ }
  },
}

const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback)

export default function TodoDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  if (isSheetId(id)) return <SheetRow id={id} />
  return <TaskScreen />
}

/** A row of the task sheet: read from the feed the list drew it from (read again when opened from a link). */
function SheetRow({ id }: { id: string }) {
  const { sheet, sheetError } = useBoard()
  useEffect(() => { if (!sheet) void loadSheet() }, [sheet])
  if (!sheet) {
    // Opened cold (a link) with the bridge out of reach: say so, with Try again; the header's X is the way back.
    return (
      <View style={st.frame}>
        <View style={st.head}>
          <View style={{ flex: 1 }} />
          <IconBtn icon={XMarkIcon} size={20} box={44} label="Close" onPress={() => router.back()} />
        </View>
        {sheetError ? (
          <View style={{ padding: 16, gap: 12 }}>
            <InlineError>{`The task sheet could not load: ${sheetError}`}</InlineError>
            <Btn kind="primary" title="Try again" onPress={() => void loadSheet({ refresh: true })} style={{ minHeight: 44 }} />
          </View>
        ) : <Spinner />}
      </View>
    )
  }
  const item = sheet.items.find((entry) => entry.id === id) ?? null
  return <SheetItemPage item={item} source={sheetName(sheet)} fetchedAt={sheet.configured ? sheet.fetchedAt : null} />
}

function TaskScreen() {
  const { id, focus } = useLocalSearchParams<{ id: string; focus?: string }>()
  const board = useBoard()
  const [todo, setTodo] = useState<Todo | null>(() => findTodo(id) ?? null)
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)

  // Opened from somewhere the board has not loaded (a deep link, the archive after a reload).
  useEffect(() => {
    if (todo) return
    setLoadError('')
    getTodo(id).then((r) => setTodo(r.todo)).catch((cause) => setLoadError(cause instanceof Error ? cause.message : 'This task could not load.'))
  }, [id, todo, attempt])

  if (todo) return <TaskPage key={todo.id} original={todo} allTodos={board.todos} issueStates={board.issueStates} initialFocus={focus === 'notes' ? 'notes' : 'details'} />
  return (
    <View style={st.frame}>
      <View style={st.head}>
        <View style={{ flex: 1 }} />
        <IconBtn icon={XMarkIcon} size={20} box={44} label="Close" onPress={() => router.back()} />
      </View>
      {loadError ? (
        <View style={{ padding: 16, gap: 12 }}>
          <InlineError>{loadError}</InlineError>
          <Btn title="Try again" onPress={() => setAttempt((n) => n + 1)} style={{ minHeight: 44 }} />
        </View>
      ) : <Spinner />}
    </View>
  )
}

function TaskPage({ original, allTodos, issueStates, initialFocus }: {
  original: Todo; allTodos: Todo[]; issueStates: Record<string, IssueState>; initialFocus: 'details' | 'notes'
}) {
  const insets = useSafeAreaInsets()
  const ventureTags = useVentureTags()
  const [todo, setTodoState] = useState(original)
  const todoRef = useRef(original)
  const [title, setTitle] = useState(original.title)
  const [description, setDescription] = useState(original.description)
  // What the two text fields hold. Beside the saved task it tells an untouched field,
  // which follows a newer saved value (a save from another device), from an edit, which keeps its words.
  const drafts = useRef({ title: original.title, description: original.description })
  const [note, setNoteState] = useState(() => noteDraft.get(original.id))
  const noteRef = useRef(note)
  const setNote = (value: string) => { noteRef.current = value; setNoteState(value) }
  const [pending, setPending] = useState(0)
  const [savedAt, setSavedAt] = useState(0)
  const [busy, setBusy] = useState('')
  // Which action an error or notice belongs to: it shows beside that action, since a
  // message at the top of a long page is out of sight.
  const [at, setAt] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [undo, setUndo] = useState<UndoState | null>(null)
  const clearUndo = useCallback(() => setUndo(null), [])
  const [pick, setPick] = useState<'due' | 'snooze' | null>(null)
  const enqueue = useMemo(() => serialQueue(), [])
  // Saves still queued or out. Only the last one's answer is drawn: an earlier answer
  // predates the later optimistic change and would flick it back for a moment.
  const inFlight = useRef(0)
  const scroll = useRef<KeyboardAwareScrollViewRef>(null)
  const noteInput = useRef<TextInput>(null)
  const focusedNotes = useRef(initialFocus !== 'notes')
  const now = new Date()

  const issue = issueLinkOf(todo)
  const issueState = issue ? issueStates[issueKey(issue)] : undefined
  // Opened straight from a link or a notification, before the list read any states.
  const issueStateKey = issue ? issueKey(issue) : ''
  // At most once per issue on this page (shouldAskIssueState).
  const [askOnce] = useState(askOncePerKey)
  useEffect(() => {
    if (shouldAskIssueState(issueStateKey, issueStates, askOnce)) void loadIssueStates()
  }, [issueStateKey, issueStates, askOnce])
  const done = todo.status === 'done'
  const notDoing = todo.outcome === 'not_doing'
  const binned = Boolean(todo.deletedAt)
  // A binned or archived task is restored from its panel first; moving it here would skip that.
  const parked = binned || Boolean(todo.archivedAt)
  const showVentures = ventureTags.length > 0 || todo.area === 'Ventures'
  // A task may carry a tag that has since left the list; keep it selectable.
  const ventureTagNames = [...ventureTags.map((tag) => tag.name), ...(todo.ventureTag && !ventureTags.some((tag) => tag.name === todo.ventureTag) ? [todo.ventureTag] : [])]
  const ventureColor = todo.area === 'Ventures' ? ventureTags.find((tag) => tag.name === todo.ventureTag)?.color ?? null : null

  /** Show a newer version of the task, here and on the board. */
  function accept(next: Todo, { keepDrafts = false } = {}) {
    const before = todoRef.current
    if (!keepDrafts) {
      if (drafts.current.title === before.title && next.title !== before.title) { drafts.current.title = next.title; setTitle(next.title) }
      if (drafts.current.description === before.description && next.description !== before.description) { drafts.current.description = next.description; setDescription(next.description) }
    }
    todoRef.current = next
    setTodoState(next)
    acceptTodo(next)
  }

  /** One save on the queue: shows "Saving…", then "Saved", or the error beside `where`. */
  async function save(where: string, job: () => Promise<Todo | void>, fallback: string) {
    setPending((n) => n + 1)
    inFlight.current += 1
    try {
      const next = await enqueue(job)
      if (next && inFlight.current === 1) accept(next)
      setSavedAt(Date.now())
      if (at === where) setError('')
      return true
    } catch (cause) {
      warn()
      setAt(where); setNotice(''); setError(errorText(cause, fallback))
      return false
    } finally {
      inFlight.current -= 1
      setPending((n) => n - 1)
    }
  }

  /** Change some fields now and tell the bridge; put them back if it refuses. */
  async function patch(fields: TodoPatch, where = 'fields', fallback = 'The task could not be updated.') {
    const before = todoRef.current
    accept({ ...before, ...fields } as Todo)
    const ok = await save(where, async () => (await updateBoardTodo(before.id, fields)).todo, fallback)
    // A refused text edit keeps the words in the field; leaving the page tries them again.
    if (!ok) accept({ ...todoRef.current, ...pickFields(before, fields) }, { keepDrafts: where === 'text' })
    return ok
  }

  async function move(status: TodoStatus, outcome?: TodoOutcome) {
    const before = todoRef.current
    accept({ ...before, status, outcome: status === 'done' ? (outcome ?? 'completed') : null })
    const ok = await save('status', async () => (await moveBoardTodo(before.id, status, outcome)).todo, 'The task could not be moved.')
    if (!ok) accept({ ...todoRef.current, status: before.status, outcome: before.outcome })
    // Finishing a repeating task makes its next occurrence on the bridge; fetch it onto the board.
    else if (status === 'done' && outcome !== 'not_doing' && rollsOnCompletion(before)) await loadBoard()
    return ok
  }

  async function complete() {
    if (done) { tap(); await move('todo'); return }
    const before = todoRef.current
    const ids = new Set(getBoard().todos.map((item) => item.id))
    success()
    if (!(await move('done'))) return
    // The list's words and rule (afterDone): a repeat that rolled names its next date and
    // offers no Undo, since reopening it would leave the next occurrence beside it.
    const line = undoText('done', before, { followUp: afterDone(before, ids, getBoard().todos) })
    const back = undoMove(before)
    setUndo({ id: Date.now(), text: line.text, action: line.undoable ? { label: 'Undo', run: () => void move(back.status, back.outcome) } : undefined })
  }

  async function setNotDoing() {
    const before = todoRef.current
    if (!(await move('done', 'not_doing'))) return
    const back = undoMove(before)
    setUndo({ id: Date.now(), text: 'Marked not doing', action: { label: 'Undo', run: () => void move(back.status, back.outcome) } })
  }

  async function snooze(until: string | null) {
    const previous = todoRef.current.snoozedUntil
    const ok = await patch({ snoozedUntil: until }, 'fields', 'Snooze could not be saved.')
    if (!ok) return
    // A snooze set or cleared here moves the task between the board and the snoozed panel.
    void loadBoard()
    if (until) setUndo({ id: Date.now(), text: `Snoozed until ${whenLabel(until)}`, action: { label: 'Undo', run: () => void patch({ snoozedUntil: previous }).then(() => loadBoard()) } })
  }

  // Title and description save when the field lets go of the keyboard.
  const commitText = () => {
    const changes = textPatch(drafts.current, todoRef.current)
    if (!drafts.current.title.trim()) { drafts.current.title = todoRef.current.title; setTitle(todoRef.current.title) }
    if (changes) void patch(changes, 'text', 'Your edit could not be saved.')
  }

  // Leaving with an edit still in a field (a swipe-down mid-sentence) saves it, behind
  // any save still queued so an older one cannot land on top.
  useEffect(() => () => {
    const changes = textPatch(drafts.current, todoRef.current)
    if (!changes) return
    const id = todoRef.current.id
    enqueue(() => updateBoardTodo(id, changes)).then(
      ({ todo: next }) => acceptTodo(next),
      (cause) => pushError(errorText(cause, 'Your last edit to the task could not be saved.')),
    )
  }, [enqueue])

  useEffect(() => { noteDraft.set(original.id, note) }, [original.id, note])

  async function run(name: string, action: () => Promise<void>) {
    setBusy(name); setAt(name); setError(''); setNotice('')
    try { await action() } catch (cause) { warn(); setError(errorText(cause, 'The task could not be updated.')) }
    finally { setBusy('') }
  }

  function addNote() {
    const body = note.trim()
    if (!body) return
    const id = todoRef.current.id
    void run('note', async () => {
      const { note: saved } = await addTodoNote(id, body)
      accept({ ...todoRef.current, notes: [...todoRef.current.notes, saved] })
      if (noteRef.current.trim() === body) setNote('')
      // Storage too, as this page may have closed while the note was sending; but only if it
      // still holds this note, not a newer one typed on a page opened since.
      if (noteDraft.get(id).trim() === body) noteDraft.set(id, '')
      success()
    })
  }

  const feedback = (...names: string[]) => (names.includes(at) && (error || notice)
    ? <><InlineError>{error}</InlineError><InlineNotice>{notice}</InlineNotice></>
    : null)

  // --- the rows' menus ---------------------------------------------------------

  // A task is open or done; "not doing" is the other way to be done.
  const statusActions: MenuAction[] = [
    { id: 'status:todo', title: 'Open', state: !done ? 'on' : 'off', attributes: !done ? { disabled: true } : undefined },
    { id: 'status:done', title: 'Done', state: done && !notDoing ? 'on' : 'off', attributes: done && !notDoing ? { disabled: true } : undefined },
    { id: 'status-more', title: '', displayInline: true, subactions: [{ id: 'status:notdoing', title: 'Not doing', image: 'nosign', state: notDoing ? 'on' as const : 'off' as const, attributes: notDoing ? { disabled: true } : undefined }] },
  ]
  const priorityActions: MenuAction[] = ([4, 3, 2, 1] as Todo['priority'][]).map((value) => ({
    id: `priority:${value}`, title: `${priorityLabel(value)} · ${PRIORITY_WORD[priorityLabel(value)]}`, subtitle: priorityMarks(value) || undefined,
    state: todo.priority === value ? 'on' : 'off',
  }))
  const dueActions: MenuAction[] = [
    ...dueDateChoices(now).map((option): MenuAction => ({
      id: `due:${option.key}`, title: option.label, subtitle: option.detail, state: todo.dueDate === option.key ? 'on' : 'off',
    })),
    {
      id: 'due-more', title: '', displayInline: true, subactions: [
        { id: 'due:pick', title: 'Pick a date', image: 'calendar' },
        // A repeat hangs off the due date, so the two go together.
        ...(todo.dueDate ? [{ id: 'due:none', title: todo.recurrence ? 'Remove due date and repeat' : 'Remove due date', image: 'xmark', attributes: { destructive: true } }] : []),
      ],
    },
  ]
  const repeatActions: MenuAction[] = REPEAT_OPTIONS.map((option) => ({
    id: `repeat:${option.value || 'none'}`, title: option.label, state: (todo.recurrence || '') === option.value ? 'on' : 'off',
    subtitle: option.value && !todo.dueDate ? 'Starts today' : undefined,
  }))
  const snoozedUntil = todo.snoozedUntil && new Date(todo.snoozedUntil) > now ? todo.snoozedUntil : null
  // Rows are named, not timed: the time is worked out when one is picked, so a page left
  // open for an hour does not snooze "in 20 minutes" into the past.
  const snoozeActions: MenuAction[] = [
    ...snoozeTimes(now, todo.dueDate).map((option): MenuAction => ({ id: `snooze:at:${option.label}`, title: option.label, subtitle: option.detail })),
    {
      id: 'snooze-more', title: '', displayInline: true, subactions: [
        { id: 'snooze:pick', title: 'Pick a date and time', image: 'calendar' },
        ...(todo.snoozedUntil ? [{ id: 'snooze:none', title: 'Wake it now', image: 'sun.max' }] : []),
      ],
    },
  ]
  const areaActions: MenuAction[] = [
    { id: 'area:Personal', title: 'Personal', state: todo.area === 'Personal' ? 'on' : 'off' },
    ...(showVentures ? [{
      id: 'area-ventures', title: 'Ventures', subtitle: todo.area === 'Ventures' ? todo.ventureTag ?? undefined : undefined,
      state: todo.area === 'Ventures' ? 'on' as const : 'off' as const,
      subactions: ventureTagNames.length
        ? ventureTagNames.map((name): MenuAction => ({ id: `venture:${name}`, title: name, state: todo.area === 'Ventures' && todo.ventureTag === name ? 'on' : 'off' }))
        : [{ id: 'venture-none', title: 'Add venture tags in Settings → Tasks', attributes: { disabled: true } }],
    }] : []),
  ]
  const moreActions: MenuAction[] = [
    CHAT_ABOUT_ACTION,
    ...(!done && !parked ? [{ id: 'notdoing', title: 'Not doing this', image: 'nosign' }] : []),
    ...(!binned ? [{ id: 'delete', title: 'Move to recycle bin', image: 'trash', attributes: { destructive: true } }] : []),
  ]

  function onRow(id: string) {
    // A completion buzzes on its own; everything else gets the light tick.
    if (id !== 'status:done') tap()
    if (id === 'status:notdoing') return void setNotDoing()
    if (id.startsWith('status:')) {
      const status = id.slice(7) as TodoStatus
      // From "not doing" to done is a change of outcome, not a reopen; the bridge keeps
      // the old outcome unless it is named.
      if (status === 'done') {
        if (!notDoing) return void complete()
        success()
        return void move('done', 'completed')
      }
      return void move(status)
    }
    if (id.startsWith('priority:')) return void patch({ priority: Number(id.slice(9)) as Todo['priority'] })
    // The calendar sheet waits for the menu to finish closing: iOS refuses to present
    // a modal while another presentation is still animating.
    if (id === 'due:pick') return void setTimeout(() => setPick('due'), 400)
    if (id === 'due:none') return void patch(todo.recurrence ? { dueDate: null, recurrence: null } : { dueDate: null })
    if (id.startsWith('due:')) return void patch({ dueDate: id.slice(4) })
    if (id.startsWith('repeat:')) {
      const recurrence = id === 'repeat:none' ? null : id.slice(7)
      // The bridge counts a repeat from the due date; an undated task starts today.
      return void patch(recurrence && !todo.dueDate ? { recurrence, dueDate: dateKey(new Date()) } : { recurrence })
    }
    if (id === 'snooze:pick') return void setTimeout(() => setPick('snooze'), 400)
    if (id === 'snooze:none') return void snooze(null)
    if (id.startsWith('snooze:at:')) {
      const option = snoozeTimes(new Date(), todoRef.current.dueDate).find((item) => item.label === id.slice(10))
      if (option) void snooze(option.value.toISOString())
      return
    }
    if (id === 'area:Personal') return void patch({ area: 'Personal', ventureTag: null })
    if (id.startsWith('venture:')) return void patch({ area: 'Ventures', ventureTag: id.slice(8) })
  }

  async function onMore(id: string) {
    tap()
    if (id === CHAT_ABOUT_ACTION.id) return chatAbout(() => todoContext(todoRef.current))
    if (id === 'notdoing') return void setNotDoing()
    if (id === 'delete') {
      const ok = await confirm('Move to the recycle bin?', { message: todoRef.current.title, confirmLabel: 'Move to recycle bin' })
      if (!ok) return
      try { await removeTodo(todoRef.current.id); noteDraft.set(todoRef.current.id, ''); router.back() }
      catch (cause) { setAt('fields'); setError(errorText(cause, 'Task could not be moved to the recycle bin.')) }
    }
  }

  const label = priorityLabel(todo.priority)
  const due = dueTone(todo.dueDate, now, todo.status)
  const dueColor = due === 'overdue' ? tone.red.color : due === 'today' ? tone.amber.color : todo.dueDate ? colors.text : undefined
  const dueValue = !todo.dueDate ? 'None' : dueText(todo.dueDate, now, todo.status)
  const statusValue = done ? (notDoing ? 'Not doing' : 'Done') : 'Open'
  const relatable = allTodos.filter((item) => item.id !== todo.id && !todo.relations.some((relation) => relation.id === item.id))

  return (
    <View style={st.frame}>
      <View style={st.head}>
        <View style={st.headLeft}>
          {binned ? <View style={st.pill}><T size={12} weight={600} muted>In the recycle bin</T></View>
            : todo.archivedAt ? <View style={st.pill}><T size={12} weight={600} muted>Archived</T></View> : null}
        </View>
        <SavedMark pending={pending > 0} savedAt={savedAt} />
        <MenuView actions={moreActions} themeVariant="dark" onPressAction={({ nativeEvent }) => void onMore(nativeEvent.event)}>
          <View style={st.headBtn} accessibilityRole="button" accessibilityLabel="More actions">
            <Hi icon={EllipsisHorizontalIcon} size={20} color={colors.muted} />
          </View>
        </MenuView>
        <IconBtn icon={XMarkIcon} size={20} box={44} label="Close" onPress={() => router.back()} />
      </View>

      <KeyboardAwareScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={[st.body, { paddingBottom: Math.max(insets.bottom, 16) + 28 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        bottomOffset={28}
      >
        <View style={st.titleRow}>
          <CompleteCircle done={done} notDoing={notDoing} disabled={parked} onPress={() => void complete()}
            label={done ? `Reopen ${todo.title}` : `Complete ${todo.title}`} />
          <TextInput
            value={title}
            onChangeText={(value) => { drafts.current.title = value; setTitle(value) }}
            onBlur={commitText}
            multiline
            scrollEnabled={false}
            submitBehavior="blurAndSubmit"
            returnKeyType="done"
            placeholder="Task title"
            placeholderTextColor={colors.muted}
            selectionColor={colors.accent}
            keyboardAppearance="dark"
            accessibilityLabel="Task title"
            style={[st.title, done && { color: colors.muted }, notDoing && { textDecorationLine: 'line-through' }]}
          />
        </View>
        <TextInput
          value={description}
          onChangeText={(value) => { drafts.current.description = value; setDescription(value) }}
          onBlur={commitText}
          multiline
          scrollEnabled={false}
          placeholder="Add details"
          placeholderTextColor={colors.muted}
          selectionColor={colors.accent}
          keyboardAppearance="dark"
          accessibilityLabel="Description"
          style={st.description}
        />
        {todo.tags.length ? (
          <View style={st.tags}>
            {todo.tags.map((tag) => <View key={tag.id} style={st.pill}><T size={12} muted>#{tag.name}</T></View>)}
          </View>
        ) : null}
        {feedback('text')}
        <UndoLine undo={undo} onDone={clearUndo} />

        <PropertyGroup>
          <PropertyRow icon={IconProgress} iconStroke={1.6} label="Status" value={statusValue}
            valueColor={done ? (notDoing ? colors.muted : colors.green) : colors.text}
            actions={statusActions} onAction={onRow} menuTitle="Status" disabled={parked}
            hint={parked ? `Restore it from the ${binned ? 'recycle bin' : 'archive'} to change its status` : undefined} />
          <PropertyRow icon={FlagIcon} label="Priority" value={label === 'P4' ? 'None' : `${label} · ${PRIORITY_WORD[label]}`}
            valueColor={PRIORITY_COLOR[label]} actions={priorityActions} onAction={onRow} menuTitle="Priority" />
          <PropertyRow icon={CalendarDaysIcon} label="Due" value={dueValue} valueColor={dueColor} actions={dueActions} onAction={onRow} menuTitle="Due date" />
          <PropertyRow icon={IconRepeat} iconStroke={1.6} label="Repeat" value={REPEAT_OPTIONS.find((option) => option.value === (todo.recurrence || ''))?.label ?? todo.recurrence ?? 'Does not repeat'}
            valueColor={todo.recurrence ? colors.text : undefined} actions={repeatActions} onAction={onRow} menuTitle="Repeat" />
          {!done || snoozedUntil ? (
            <PropertyRow icon={ClockIcon} label="Snooze" value={snoozedUntil ? `Until ${whenLabel(snoozedUntil)}` : 'Not snoozed'}
              valueColor={snoozedUntil ? tone.amber.color : undefined} actions={snoozeActions} onAction={onRow} menuTitle="Snooze until" />
          ) : null}
          <PropertyRow icon={BriefcaseIcon} label="Area" value={todo.area === 'Ventures' ? todo.ventureTag || 'Ventures' : 'Personal'}
            swatch={ventureColor} valueColor={todo.area === 'Ventures' ? ventureColor || colors.text : colors.text}
            actions={areaActions} onAction={onRow} menuTitle="Area" />
        </PropertyGroup>
        {feedback('fields', 'status')}

        <NotesSection
          notes={todo.notes}
          draft={note}
          onDraft={setNote}
          onSend={addNote}
          sending={busy === 'note'}
          inputRef={noteInput}
          feedback={feedback('note')}
          onLayout={(e) => {
            if (focusedNotes.current) return
            focusedNotes.current = true
            const y = e.nativeEvent.layout.y - 12
            // Wait for the sheet to finish rising before scrolling and raising the keyboard.
            setTimeout(() => { scroll.current?.scrollTo({ y, animated: true }); noteInput.current?.focus() }, 450)
          }}
        />

        <RelatedSection
          relations={todo.relations}
          relatable={relatable}
          busy={busy === 'relation'}
          onOpen={(relatedId) => openTodo({ id: relatedId })}
          onRelate={(relatedId) => void run('relation', async () => { accept((await linkRelatedTodo(todoRef.current.id, relatedId)).todo); tap() })}
          onUnlink={(relatedId) => void run('relation', async () => accept((await unlinkRelatedTodo(todoRef.current.id, relatedId)).todo))}
          feedback={feedback('relation')}
        />

        <IssueLinkSection
          link={issue}
          state={issueState}
          busy={busy === 'issue'}
          disabled={binned}
          onSave={async (url) => {
            let ok = false
            await run('issue', async () => {
              accept((await setIssueLink(todoRef.current.id, url)).todo)
              ok = true
              if (url) void loadIssueStates()
              else setNotice('Issue link removed. The issue on GitHub is unchanged.')
            })
            return ok
          }}
          feedback={feedback('issue')}
        />

        <HistorySection todo={todo} />
      </KeyboardAwareScrollView>

      <PickWhenSheet
        visible={pick !== null}
        title={pick === 'snooze' ? 'Snooze until' : 'Due date'}
        mode={pick === 'snooze' ? 'datetime' : 'date'}
        submitLabel={pick === 'snooze' ? 'Snooze until selected time' : 'Set due date'}
        initial={pick === 'snooze' ? new Date(Date.now() + 60 * 60_000) : todo.dueDate ? new Date(`${todo.dueDate}T12:00:00`) : new Date()}
        minimum={pick === 'snooze' ? new Date() : undefined}
        onClose={() => setPick(null)}
        onSubmit={(value) => {
          const which = pick
          setPick(null)
          tap()
          if (which === 'snooze') void snooze(value.toISOString())
          else void patch({ dueDate: dateKey(value) })
        }}
      />
    </View>
  )
}

/** The saved values of just the fields a failed patch touched, to put them back. */
function pickFields(todo: Todo, fields: TodoPatch): Partial<Todo> {
  const names = (Object.keys(fields) as (keyof TodoPatch)[]).filter((name): name is Exclude<keyof TodoPatch, 'tags'> => name !== 'tags')
  return Object.fromEntries(names.map((name) => [name, todo[name]]))
}

const st = StyleSheet.create({
  frame: { flex: 1, backgroundColor: colors.bg2 },
  // Room above for the grabber.
  head: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingTop: 14, paddingLeft: 16, paddingRight: 8 },
  headLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  headBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 2, paddingHorizontal: 8,
    borderWidth: 1, borderColor: colors.line, borderRadius: 999, backgroundColor: colors.bg3,
  },
  body: { paddingHorizontal: 16, paddingTop: 6, gap: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 4 },
  title: {
    flex: 1, color: colors.text, fontFamily: fonts[600], fontSize: 22, lineHeight: 28, paddingTop: 7, paddingBottom: 4,
  },
  description: {
    color: colors.text, fontFamily: fonts[400], fontSize: 16, lineHeight: 22, minHeight: 30, paddingVertical: 4, marginLeft: 41,
  },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginLeft: 41 },
})
