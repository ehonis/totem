// New task (web/src/todos/TodoComposer.tsx), rebuilt as a quick-add sheet (#179):
// it opens on the title with the keyboard up, and the fields are chips docked above
// the keyboard. Return adds the task and keeps the sheet open for the next one;
// "Add & close" adds it and closes. Words like "tomorrow", "p1" or "#tag" in the
// title fill the chips (compose/parse.ts). The half-typed draft survives closing
// the sheet, as on the web.
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import Animated, { FadeInDown, LinearTransition, useReducedMotion } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller'
import { colors, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { IconBtn, Press } from '../../ui/kit'
import { success, warn } from '../../ui/haptics'
import { pushError } from '../../lib/toast'
import { Hi, BriefcaseIcon, CalendarDaysIcon, CheckIcon, ExclamationCircleIcon, FlagIcon, XMarkIcon } from '../../lib/icons'
import { createBoardTodo } from '../../lib/api'
import { priorityLabel, priorityMarks, type Todo, type TodoArea, type VentureTag } from '../../lib/todos/types'
import { useVentureTags } from '../../lib/todos/ventureTags'
import type { MenuAction } from '@react-native-menu/menu'
import { prependTodo } from './store'
import { dateKey, dueDateChoices, dueText } from './format'
import { PickWhenSheet } from './ui'
import { openTodo } from './nav'
import { hintKey, parseQuickAdd, type Hint } from './compose/parse'
import { MenuChip } from './compose/Chip'
import { PRIORITY_COLOR, PRIORITY_WORD } from './compose/labels'
import { createBody, createUnsentStore, type UnsentEntry } from './compose/unsent'

const DRAFT_KEY = 'totem.todo-draft.new'
// The web's draft fields, plus what only the phone has: the hints the owner
// chose to keep as text, and which of area and priority were picked by hand (a picked
// "Personal" or "None" outranks a #tag or p1 in the title).
type TodoDraft = Partial<{
  title: string; description: string; area: TodoArea; ventureTag: VentureTag | ''; priority: Todo['priority']; dueDate: string
  ignore: string[]; picked: { area?: boolean; priority?: boolean }
}>
export const todoDraftStore = {
  get(): TodoDraft {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') }
    catch { return {} }
  },
  set(value: TodoDraft) { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(value)) } catch { /* not kept */ } },
  clear() { try { localStorage.removeItem(DRAFT_KEY) } catch { /* nothing kept */ } },
}

interface Payload {
  title: string; description: string; area: TodoArea; ventureTag: VentureTag | null; priority: Todo['priority']
  dueDate: string | null
  // A payload kept by an older app version may still carry these: sharing, and "start now".
  syncTarget?: string; repo?: string; start?: boolean
}

// Tasks the bridge did not take yet: kept until each is added or discarded, through a
// closed sheet or a restarted app (compose/unsent.ts).
const unsent = createUnsentStore<Payload>(() => { try { return localStorage } catch { return null } }, 'totem.todo-draft.unsent')
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** A task added in this sheet: on its way, or on the board. */
interface Added { key: string; title: string; state: 'saving' | 'saved'; id?: string }

export default function TodoComposerScreen() {
  const insets = useSafeAreaInsets()
  // The chip bar sits on the keyboard while it is up, and clear of the home indicator once it is down.
  const keyboardUp = useKeyboardState((state) => state.isVisible)
  const reduced = useReducedMotion()
  // Ventures appears only once the install has venture tags (Settings -> Tasks).
  const ventureTags = useVentureTags()
  const tagNames = useMemo(() => ventureTags.map((tag) => tag.name), [ventureTags])
  const [draft] = useState(() => todoDraftStore.get())
  const [title, setTitle] = useState(draft.title || '')
  const [description, setDescription] = useState(draft.description || '')
  // What the owner set with a chip. Unset fields can be filled by hints in the title.
  const [area, setArea] = useState<TodoArea | null>(draft.picked?.area ? draft.area || 'Personal' : draft.area === 'Ventures' ? 'Ventures' : null)
  const [ventureTag, setVentureTag] = useState<VentureTag | ''>(draft.ventureTag || '')
  const [priority, setPriority] = useState<Todo['priority'] | null>(draft.picked?.priority ? draft.priority || 1 : draft.priority && draft.priority !== 1 ? draft.priority : null)
  const [dueDate, setDueDate] = useState(draft.dueDate || '')
  const [ignore, setIgnore] = useState<string[]>(draft.ignore || [])
  const [added, setAdded] = useState<Added[]>([])
  const waiting = useSyncExternalStore(unsent.subscribe, unsent.list)
  // Kept tasks with a request out, from any sheet: one already sending is not offered again.
  const retrying = useSyncExternalStore(unsent.subscribe, unsent.sending)
  const [error, setError] = useState('')
  const [pickDue, setPickDue] = useState(false)
  const titleInput = useRef<TextInput>(null)
  const mounted = useRef(true)
  const leaving = useRef(false)

  // Only fields left to the title are read from it: a word whose chip was set by hand stays a word.
  const kinds = [...(dueDate ? [] : ['due' as const]), ...(priority === null ? ['priority' as const] : []), ...(area === null ? ['venture' as const] : [])]
  const parsed = parseQuickAdd(title, { now: new Date(), ventureTags: tagNames, ignore, kinds })
  // A chip you set beats a word in the title.
  const effective = {
    dueDate: dueDate || parsed.dueDate || '',
    priority: priority ?? parsed.priority ?? 1,
    area: area ?? (parsed.ventureTag ? 'Ventures' : 'Personal') as TodoArea,
    ventureTag: area ? ventureTag : parsed.ventureTag || '',
  }
  const showVentures = ventureTags.length > 0 || effective.area === 'Ventures'

  useEffect(() => {
    if (!title && !description && !dueDate && !area) todoDraftStore.clear()
    else todoDraftStore.set({ title, description, area: area ?? 'Personal', ventureTag, priority: priority ?? 1, dueDate, ignore, picked: { area: area !== null, priority: priority !== null } })
  }, [title, description, area, ventureTag, priority, dueDate, ignore])

  // Focus once the sheet has finished rising: autoFocus fires mid-presentation, and
  // the keyboard arriving then makes the form sheet jump and re-lay itself out.
  useEffect(() => {
    const timer = setTimeout(() => titleInput.current?.focus(), 450)
    return () => { clearTimeout(timer); mounted.current = false }
  }, [])

  const send = useCallback(async (key: string, payload: Payload) => {
    const settle = (row: Added | null) => {
      if (!mounted.current) return
      setAdded((list) => (row ? [row, ...list.filter((item) => item.key !== key)] : list.filter((item) => item.key !== key)))
    }
    try {
      const { todo: created } = await createBoardTodo(createBody(payload))
      // On the board now: it moves from the kept list to this sheet's list in one step.
      settle({ key, title: payload.title, state: 'saved', id: created.id })
      unsent.remove(key)
      unsent.release(key)
      // POST /api/todos/board answers with the board's own record, so it goes straight on.
      prependTodo(created)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Task could not be created.'
      warn()
      // Kept until it is added or discarded, whether or not this sheet is still open.
      unsent.put({ id: key, payload, error: message })
      unsent.release(key)
      settle(null)
      if (!mounted.current) pushError(`“${payload.title}” was not added (${message}). It is waiting in New task.`)
    }
  }, [])

  /** Add what is in the field. Returns the request, or null when the form is not ready. */
  function submit(): Promise<void> | null {
    setError('')
    const name = parsed.title.trim()
    if (!name) { setError('Enter a task title.'); return null }
    if (effective.area === 'Ventures' && !effective.ventureTag) { setError('Choose a venture tag for Ventures.'); return null }
    const payload: Payload = {
      title: name, description, area: effective.area,
      ventureTag: effective.area === 'Ventures' ? effective.ventureTag as VentureTag : null,
      priority: effective.priority, dueDate: effective.dueDate || null,
    }
    const key = newId()
    setAdded((list) => [{ key, title: name, state: 'saving' }, ...list])
    success()
    // Ready for the next one. The area stays: a batch usually shares one.
    setTitle(''); setDescription(''); setDueDate(''); setPriority(null); setIgnore([])
    return send(key, payload)
  }

  // Closing never waits on the bridge: a task still sending finishes on its own, and one
  // that fails is kept for next time (send). Only the first tap leaves.
  function close() {
    if (leaving.current) return
    leaving.current = true
    router.back()
  }

  function addAndClose() {
    if (title.trim() && !submit()) return
    close()
  }

  function retry(entry: UnsentEntry<Payload>) {
    // Claimed in the shared store, so a second tap or a second sheet cannot send it twice.
    if (!unsent.claim(entry.id)) return
    void send(entry.id, entry.payload)
  }

  // --- chips -------------------------------------------------------------------

  const dueFromText = !dueDate && Boolean(parsed.dueDate)
  const dueActions: MenuAction[] = [
    ...dueDateChoices(new Date()).map((option): MenuAction => ({
      id: `due:${option.key}`, title: option.label, subtitle: option.detail, state: effective.dueDate === option.key ? 'on' : 'off',
    })),
    {
      id: 'due-more', title: '', displayInline: true, subactions: [
        { id: 'due:pick', title: 'Pick a date', image: 'calendar' },
        ...(effective.dueDate ? [{ id: 'due:none', title: 'No due date', image: 'xmark' }] : []),
      ],
    },
  ]
  const label = priorityLabel(effective.priority)
  const priorityFromText = priority === null && parsed.priority !== null
  const priorityActions: MenuAction[] = ([4, 3, 2, 1] as Todo['priority'][]).map((value) => ({
    id: `priority:${value}`, title: `${priorityLabel(value)} · ${PRIORITY_WORD[priorityLabel(value)]}`, subtitle: priorityMarks(value) || undefined,
    state: effective.priority === value ? 'on' : 'off',
  }))
  const areaFromText = area === null && Boolean(parsed.ventureTag)
  const areaActions: MenuAction[] = [
    { id: 'area:Personal', title: 'Personal', state: effective.area === 'Personal' ? 'on' : 'off' },
    {
      id: 'area-ventures', title: 'Ventures', state: effective.area === 'Ventures' ? 'on' : 'off',
      subactions: tagNames.length
        ? tagNames.map((name): MenuAction => ({ id: `venture:${name}`, title: name, state: effective.ventureTag === name ? 'on' : 'off' }))
        : [{ id: 'venture-none', title: 'Add venture tags in Settings → Tasks', attributes: { disabled: true } }],
    },
  ]
  const ventureColor = effective.area === 'Ventures' ? ventureTags.find((tag) => tag.name === effective.ventureTag)?.color ?? undefined : undefined

  function onChip(id: string) {
    if (id === 'due:pick') return void setTimeout(() => setPickDue(true), 400)
    if (id === 'due:none') { setDueDate(''); if (parsed.dueDate) dismiss(parsed.hints.find((hint) => hint.kind === 'due')); return }
    if (id.startsWith('due:')) return setDueDate(id.slice(4))
    if (id.startsWith('priority:')) return setPriority(Number(id.slice(9)) as Todo['priority'])
    if (id === 'area:Personal') { setArea('Personal'); setVentureTag(''); return }
    if (id.startsWith('venture:')) { setArea('Ventures'); setVentureTag(id.slice(8)); return }
  }

  function dismiss(hint: Hint | undefined) {
    if (!hint) return
    setIgnore((list) => [...list, hintKey(hint)])
  }

  const layout = reduced ? undefined : LinearTransition.duration(200)
  const enter = reduced ? undefined : FadeInDown.duration(220)
  const savedCount = added.filter((item) => item.state === 'saved').length
  const hasTitle = Boolean(title.trim())

  return (
    <KeyboardAvoidingView behavior="padding" style={st.frame}>
      <View style={st.head}>
        <IconBtn icon={XMarkIcon} size={20} box={44} label="Close" onPress={close} style={{ marginLeft: -10 }} />
        <View style={{ flex: 1 }}>
          <T size={17} weight={600} align="center">New task</T>
          {savedCount ? <T size={12} muted align="center">{savedCount === 1 ? '1 added' : `${savedCount} added`}</T> : null}
        </View>
        <Press
          onPress={addAndClose}
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 8 }}
          style={[st.done, hasTitle && { backgroundColor: colors.accent }]}
          accessibilityRole="button"
          accessibilityLabel={hasTitle ? 'Add and close' : 'Done'}
        >
          <T size={15} weight={600} color={hasTitle ? colors.white : colors.accent}>{hasTitle ? 'Add & close' : 'Done'}</T>
        </Press>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={st.body} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
        <TextInput
          ref={titleInput}
          value={title}
          onChangeText={(value) => { setTitle(value.replace(/\s*\n\s*/g, ' ')); if (error) setError('') }}
          placeholder="What needs doing?"
          placeholderTextColor={colors.muted}
          selectionColor={colors.accent}
          keyboardAppearance="dark"
          returnKeyType="next"
          enablesReturnKeyAutomatically
          // Wraps like a note, but Return adds the task instead of a new line.
          multiline
          scrollEnabled={false}
          submitBehavior="submit"
          onSubmitEditing={() => void submit()}
          accessibilityLabel="Task title"
          accessibilityHint="Return adds the task and keeps this open for the next one"
          style={st.title}
        />
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="Notes"
          placeholderTextColor={colors.muted}
          selectionColor={colors.accent}
          keyboardAppearance="dark"
          multiline
          scrollEnabled={false}
          accessibilityLabel="Notes"
          style={st.notes}
        />

        {parsed.hints.length ? (
          <Animated.View entering={enter} style={st.hints}>
            {parsed.hints.map((hint) => (
              // A 44pt box round a 32pt pill: hitSlop past a parent's edge does not count on iOS.
              <Press key={`${hint.kind}:${hint.start}`} onPress={() => dismiss(hint)} style={st.hintHit}
                accessibilityRole="button" accessibilityLabel={`Keep “${hint.text}” as text`} accessibilityHint={`Stops reading it as the ${hint.kind === 'venture' ? 'venture tag' : hint.kind === 'due' ? 'due date' : 'priority'}`}>
                <View style={st.hint}>
                  <T size={13} color={colors.accent}>“{hint.text.trim()}”</T>
                  <T size={13} muted>{hintMeaning(hint)}</T>
                  <Hi icon={XMarkIcon} size={12} color={colors.muted} />
                </View>
              </Press>
            ))}
          </Animated.View>
        ) : null}


        {error ? (
          <View style={st.error} accessibilityRole="alert">
            <Hi icon={ExclamationCircleIcon} size={16} color="#ff9caf" />
            <T size={13.5} color="#ff9caf" style={{ flex: 1 }}>{error}</T>
          </View>
        ) : null}

        {waiting.length || added.length ? (
          <View style={st.added}>
            {waiting.map((entry) => {
              const sending = retrying.includes(entry.id)
              return (
                <Animated.View key={entry.id} entering={enter} layout={layout} style={st.addedRow}>
                  <Press
                    onPress={() => retry(entry)}
                    disabled={sending}
                    style={st.addedBody}
                    accessibilityRole="button"
                    accessibilityLabel={sending ? `Adding ${entry.payload.title}` : [`${entry.payload.title} was not added: ${entry.error}`, payloadSummary(entry.payload), 'Try again'].filter(Boolean).join('. ')}
                  >
                    <View style={[st.addedMark, { borderColor: colors.red }]} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T size={15} numberOfLines={1} color={sending ? colors.muted : colors.text}>{entry.payload.title}</T>
                      {payloadSummary(entry.payload) ? <T size={12.5} muted>{payloadSummary(entry.payload)}</T> : null}
                      <T size={12.5} color="#ff9caf" numberOfLines={2}>{`Not added: ${entry.error}`}</T>
                    </View>
                    <T size={13} color={sending ? colors.muted : colors.accent}>{sending ? 'Adding…' : 'Try again'}</T>
                  </Press>
                  {sending ? null : <IconBtn icon={XMarkIcon} size={15} box={44} color={colors.muted} label={`Discard ${entry.payload.title}`} onPress={() => unsent.remove(entry.id)} />}
                </Animated.View>
              )
            })}
            {added.map((item) => (
              <Animated.View key={item.key} entering={enter} layout={layout} style={st.addedRow}>
                <Press
                  onPress={() => { if (item.id) openTodo({ id: item.id }) }}
                  disabled={!item.id}
                  style={st.addedBody}
                  accessibilityRole="button"
                  accessibilityLabel={!item.id ? `Adding ${item.title}` : `Added ${item.title}. Open it`}
                >
                  <View style={[st.addedMark, item.state === 'saved' && { backgroundColor: colors.green, borderColor: colors.green }]}>
                    {item.state === 'saved' ? <Hi icon={CheckIcon} size={11} color={colors.white} strokeWidth={3} /> : null}
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T size={15} numberOfLines={1} color={item.state === 'saving' ? colors.muted : colors.text}>{item.title}</T>
                  </View>
                  <T size={13} muted>{item.state === 'saving' ? 'Adding…' : 'Open'}</T>
                </Press>
              </Animated.View>
            ))}
          </View>
        ) : (
          <T size={13} muted style={st.tip}>
            {`Return adds the task and keeps this open for the next. Words like “tomorrow”, “fri” or “p1”${tagNames.length ? ` and #${tagNames[0]}` : ''} set the chips below.`}
          </T>
        )}
      </ScrollView>

      <View style={[st.bar, { paddingBottom: keyboardUp ? 2 : Math.max(insets.bottom, 8) }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={st.chips}>
          <MenuChip
            icon={CalendarDaysIcon} title="Due date" actions={dueActions} onAction={onChip}
            text={effective.dueDate ? dueText(effective.dueDate, new Date()) : 'Due'} on={Boolean(effective.dueDate)} fromText={dueFromText}
            a11y={effective.dueDate ? `Due ${dueText(effective.dueDate, new Date())}. Change` : 'Set a due date'}
          />
          <MenuChip
            icon={FlagIcon} title="Priority" actions={priorityActions} onAction={onChip}
            text={label === 'P4' ? 'Priority' : `${label} · ${PRIORITY_WORD[label]}`} on={label !== 'P4'} fromText={priorityFromText}
            color={label !== 'P4' ? PRIORITY_COLOR[label] : undefined}
            a11y={label === 'P4' ? 'Set a priority' : `Priority ${label}, ${PRIORITY_WORD[label]}. Change`}
          />
          {showVentures ? (
            <MenuChip
              icon={BriefcaseIcon} title="Area" actions={areaActions} onAction={onChip}
              text={effective.area === 'Ventures' ? effective.ventureTag || 'Ventures' : 'Personal'} on={effective.area === 'Ventures'} fromText={areaFromText}
              color={ventureColor}
              a11y={`Area: ${effective.area === 'Ventures' ? `Ventures, ${effective.ventureTag || 'no tag yet'}` : 'Personal'}. Change`}
            />
          ) : null}
        </ScrollView>
      </View>

      <PickWhenSheet
        visible={pickDue}
        title="Due date"
        mode="date"
        submitLabel="Set due date"
        initial={effective.dueDate ? new Date(`${effective.dueDate}T12:00:00`) : new Date()}
        onClose={() => setPickDue(false)}
        onSubmit={(value) => { setPickDue(false); setDueDate(dateKey(value)) }}
      />
    </KeyboardAvoidingView>
  )
}

/** What a kept task will be sent with, so a retry days later sends nothing unseen. */
function payloadSummary(payload: Payload) {
  const label = priorityLabel(payload.priority)
  // Where it goes first: that is what a stale retry would get wrong.
  return [
    payload.dueDate ? `Due ${dueText(payload.dueDate, new Date())}` : '',
    label !== 'P4' ? `${label} · ${PRIORITY_WORD[label]}` : '',
    payload.area === 'Ventures' ? payload.ventureTag || 'Ventures' : '',
  ].filter(Boolean).join(' · ')
}

function hintMeaning(hint: Hint) {
  if (hint.kind === 'due') return `due ${dueText(hint.dueDate!, new Date())}`
  if (hint.kind === 'priority') { const p = priorityLabel(hint.priority!); return `${p} · ${PRIORITY_WORD[p]}` }
  return `Ventures · ${hint.ventureTag}`
}

const st = StyleSheet.create({
  frame: { flex: 1, backgroundColor: colors.bg2 },
  // Room above for the grabber.
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 14, paddingHorizontal: 16, paddingBottom: 4 },
  done: { minHeight: 36, minWidth: 64, paddingHorizontal: 14, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginVertical: 4 },
  body: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 16, gap: 10 },
  title: { color: colors.text, fontFamily: fonts[600], fontSize: 22, lineHeight: 28, paddingVertical: 6 },
  notes: { color: colors.text, fontFamily: fonts[400], fontSize: 16, lineHeight: 22, paddingVertical: 2, minHeight: 26 },
  hints: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 6 },
  hintHit: { minHeight: 44, justifyContent: 'center' },
  hint: {
    flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 32, paddingHorizontal: 10, borderRadius: 16,
    borderWidth: 1, borderStyle: 'dashed', borderColor: '#5b8cff66', backgroundColor: '#5b8cff12',
  },
  error: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#f0506e55', backgroundColor: '#f0506e0f' },
  tip: { marginTop: 6, lineHeight: 19 },
  added: { marginTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  addedRow: { flexDirection: 'row', alignItems: 'center', minHeight: 48, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  addedBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  addedMark: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: '#4a5162', alignItems: 'center', justifyContent: 'center' },
  bar: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, backgroundColor: colors.bg2 },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 2 },
})
