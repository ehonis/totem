// Sheet detents: [0.75, 1] (formSheet, grabber, corner radius 22; registered in src/app/_layout.tsx).
//
// Which task a chat works toward (web work/pickers.tsx TaskPicker): the open tasks,
// due first, then the shared sheet's rows, searchable; Unlink when it has one, and
// "New task …" from what was typed, filed in the chat's project. Opened from a
// chat's menu (Link to task…) and from the link on its task strip.
import React, { useMemo, useState } from 'react'
import { ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import IconTable from '@tabler/icons-react-native/dist/esm/icons/IconTable.mjs'
import IconLinkOff from '@tabler/icons-react-native/dist/esm/icons/IconLinkOff.mjs'
import IconCircle from '@tabler/icons-react-native/dist/esm/icons/IconCircle.mjs'
import { linkTask, threadTitle, useChat } from '../../lib/chat/store'
import { byDue, resolveRef, type WorkTask } from '../../lib/work/groups'
import { dueLook } from './look'
import { colors, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { IconBtn, Press } from '../../ui/kit'
import { success, tap } from '../../ui/haptics'
import { XMarkIcon } from '../../lib/icons'
import { useBoard } from '../todos/store'
import { TI } from '../chat/ui'
import { IconCheck, IconPlus, IconSearch } from '../chat/icons'
import { createTask, sheetTitle, useWorkLoaded, useWorkTasks } from './state'


export default function LinkTaskSheet() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const insets = useSafeAreaInsets()
  const thread = useChat((s) => s.threads.find((t) => t.id === id))
  const tasks = useWorkTasks()
  const board = useBoard()
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  useWorkLoaded()
  const value = thread?.taskId ? resolveRef(thread.taskId, tasks) : null
  const q = query.trim().toLowerCase()

  const { local, sheet } = useMemo(() => {
    const keep = (t: WorkTask) => ((!t.done && !t.hidden) || t.ref === value)
      && (!q || t.title.toLowerCase().includes(q) || t.status.toLowerCase().includes(q))
    const rows = (kind: WorkTask['kind']) => tasks.filter((t) => t.kind === kind && keep(t))
      .sort(byDue)
    return { local: rows('local'), sheet: rows('sheet') }
  }, [tasks, value, q])

  const pick = (ref: string | null) => {
    if (!thread) return
    tap()
    linkTask(thread.id, ref)
    router.back()
  }
  const addAndLink = async () => {
    if (!thread || !query.trim() || adding) return
    setAdding(true)
    const task = await createTask({ title: query.trim() }, thread.projectId ?? null)
    setAdding(false)
    if (task) { success(); pick(task.ref) }
  }

  const row = (task: WorkTask) => {
    const due = dueLook(task.dueDate, new Date())
    const on = task.ref === value
    return (
      <Press key={task.ref} style={[st.row, on && st.rowOn]} onPress={() => pick(task.ref)} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={`${task.title}${due ? `, ${due.text}` : ''}`}>
        <TI icon={task.kind === 'sheet' ? IconTable : IconCircle} size={17} color={task.kind === 'sheet' ? '#79cf91' : textAlpha(50)} />
        <T size={15} numberOfLines={2} style={{ flex: 1 }}>{task.title}</T>
        {due ? <T size={12} weight={due.strong ? 600 : 400} color={due.color}>{due.text}</T> : null}
        {on ? <TI icon={IconCheck} size={17} color={colors.accent} /> : null}
      </Press>
    )
  }

  return (
    <View style={st.sheet}>
      <View style={st.head}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={17} weight={600} accessibilityRole="header">Link to a task</T>
          {thread ? <T size={13} muted numberOfLines={1}>{threadTitle(thread)}</T> : null}
        </View>
        <IconBtn icon={XMarkIcon} size={20} box={44} label="Close" onPress={() => router.back()} />
      </View>
      <View style={st.search}>
        <TI icon={IconSearch} size={16} color={colors.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search tasks, or name a new one"
          placeholderTextColor={colors.muted}
          style={st.searchInput}
          returnKeyType="done"
          onSubmitEditing={() => { if (!local.length && !sheet.length) void addAndLink() }}
          keyboardAppearance="dark"
          accessibilityLabel="Search tasks"
        />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: insets.bottom + 20 }}>
        {value ? (
          <Press style={st.row} onPress={() => pick(null)} accessibilityRole="button">
            <TI icon={IconLinkOff} size={17} color={colors.red} />
            <T size={15} color={colors.red}>Unlink task</T>
          </Press>
        ) : null}
        {query.trim() ? (
          <Press style={st.row} disabled={adding} onPress={() => void addAndLink()} accessibilityRole="button">
            <TI icon={IconPlus} size={17} color={colors.accent} />
            <T size={15} color={colors.accent} numberOfLines={2} style={{ flex: 1 }}>{`New task “${query.trim()}”`}</T>
          </Press>
        ) : null}
        {local.length ? <T size={12.5} weight={600} color={colors.muted} style={st.section}>Tasks</T> : null}
        {local.map(row)}
        {sheet.length ? <T size={12.5} weight={600} color={colors.muted} style={st.section}>{sheetTitle(board) || 'Shared sheet'}</T> : null}
        {sheet.map(row)}
        {!local.length && !sheet.length ? (
          <T size={14} muted style={st.empty}>{!board.loaded ? 'Reading your tasks…' : q ? 'No matching tasks.' : 'No open tasks.'}</T>
        ) : null}
      </ScrollView>
    </View>
  )
}

const st = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.bg2 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 18, paddingBottom: 8, paddingLeft: 20, paddingRight: 8 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, marginHorizontal: 16, marginBottom: 6, paddingHorizontal: 12, borderRadius: 12, backgroundColor: colors.bg3 },
  searchInput: { flex: 1, minWidth: 0, color: colors.text, fontSize: 15, fontFamily: 'Inter_400Regular', paddingVertical: 0 },
  section: { paddingTop: 14, paddingBottom: 4, paddingHorizontal: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingVertical: 8, paddingHorizontal: 8, borderRadius: 10 },
  rowOn: { backgroundColor: colors.drawerOn },
  empty: { paddingVertical: 28, textAlign: 'center' },
})
