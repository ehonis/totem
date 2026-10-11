// The chips under the board (web/src/todos/TodoLifecyclePanels.tsx, plus the Done
// column's archive, whose header a phone never shows) as one sheet per panel:
// snoozed tasks, the recycle bin, the archive by day/week/month/year, retention.
import React, { useEffect, useState } from 'react'
import { SectionList, StyleSheet, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors, alpha } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press, Spinner } from '../../ui/kit'
import { confirm } from '../../ui/menu'
import { success } from '../../ui/haptics'
import { Hi, ClockIcon } from '../../lib/icons'
import { purgeDeletedTodos, restoreBoardTodo, updateTodoPreferences } from '../../lib/api'
import { groupArchive, type ArchivePeriod } from '../../lib/todos/archive'
import type { TodoPreferences } from '../../lib/todos/types'
import TodoCard from './TodoCard'
import { archiveHourLabel } from './format'
import { loadBoard, showArchive, useBoard } from './store'
import { DateField, Field, FieldInput, InlineError, InlineNotice, SheetFrame, SheetHead } from './ui'
import { openTodo } from './nav'

type Panel = 'snoozed' | 'deleted' | 'archive' | 'retention'
const TITLES: Record<Panel, string> = { snoozed: 'Snoozed', deleted: 'Recycle bin', archive: 'Archive', retention: 'Retention' }
const ARCHIVE_PERIODS: readonly { value: ArchivePeriod; label: string }[] = [
  { value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'year', label: 'Year' },
]

export default function TodoLifecycleScreen() {
  const { panel: raw } = useLocalSearchParams<{ panel?: string }>()
  const panel: Panel = raw === 'deleted' || raw === 'archive' || raw === 'retention' ? raw : 'snoozed'
  const { loaded } = useBoard()
  // Normally opened from the board, which has loaded; a deep link has not.
  useEffect(() => { if (!loaded) void loadBoard() }, [loaded])
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg2 }}>
      {panel === 'archive' ? <ArchivePanel /> : <Panels panel={panel} />}
    </View>
  )
}

function Panels({ panel }: { panel: Exclude<Panel, 'archive'> }) {
  const board = useBoard()
  const [prefs, setPrefs] = useState<TodoPreferences>(board.preferences)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { setPrefs(board.preferences) }, [board.preferences])

  async function restore(id: string) {
    try { await restoreBoardTodo(id); success(); void loadBoard() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Task could not be restored.') }
  }
  async function purge() {
    const days = prefs.recyclePurgeDays ?? 30
    if (!(await confirm('Purge eligible deleted tasks?', { message: `Tasks in the recycle bin for more than ${days} days are removed for good. The task database is backed up first.`, confirmLabel: 'Purge' }))) return
    try {
      const olderThan = new Date(Date.now() - days * 86_400_000).toISOString()
      const result = await purgeDeletedTodos(olderThan)
      setNotice(`Backed up the task database and purged ${result.purged.toLocaleString()} task${result.purged === 1 ? '' : 's'}.`)
      void loadBoard()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Recycle bin could not be purged.') }
  }
  async function saveRetention() {
    setError(''); setNotice('')
    try { await updateTodoPreferences(prefs); setNotice('Retention settings saved.'); success(); void loadBoard() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Retention settings could not be saved.') }
  }
  const days = (value: number | null) => (value === null ? '' : String(value))
  const parseDays = (text: string) => (text.trim() ? Math.max(1, Number(text.replace(/\D/g, '')) || 1) : null)

  return (
    <SheetFrame kicker="Todos" title={TITLES[panel]} onClose={() => router.back()}>
      <InlineError>{error}</InlineError>
      <InlineNotice>{notice}</InlineNotice>
      {panel === 'snoozed' ? (
        board.snoozed.length ? (
          <View style={st.rows}>
            {board.snoozed.map((todo, index) => (
              <Press key={todo.id} onPress={() => openTodo(todo)} style={[st.row, index === 0 && st.first]} accessibilityRole="button">
                <T size={14} lineHeight={19} style={{ flex: 1 }} numberOfLines={2}>{todo.title}</T>
                <T size={12} muted style={{ flexShrink: 0 }}>{todo.snoozedUntil ? new Date(todo.snoozedUntil).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}</T>
              </Press>
            ))}
          </View>
        ) : <T size={13} muted>No snoozed tasks.</T>
      ) : null}
      {panel === 'deleted' ? (
        <>
          {board.deleted.length ? (
            <View style={st.rows}>
              {board.deleted.map((todo, index) => (
                <View key={todo.id} style={[st.row, index === 0 && st.first]}>
                  <T size={14} lineHeight={19} style={{ flex: 1 }} numberOfLines={2}>{todo.title}</T>
                  <Btn compact title="Restore" onPress={() => void restore(todo.id)} />
                </View>
              ))}
            </View>
          ) : null}
          {!board.deleted.length ? <T size={13} muted>The recycle bin is empty.</T> : null}
          {board.deleted.length > 0 ? <Btn kind="danger" title="Purge eligible deleted tasks" onPress={() => void purge()} style={{ minHeight: 44 }} /> : null}
        </>
      ) : null}
      {panel === 'retention' ? (
        <View style={{ gap: 13 }}>
          <Field label="Archive completed tasks daily at">
            <DateField mode="time" value={prefs.autoArchiveAt ?? ''} onChange={(v) => setPrefs((current) => ({ ...current, autoArchiveAt: v || null }))}
              defaultValue={() => { const at = new Date(); at.setHours(18, 0, 0, 0); return at }} emptyLabel="Off" />
          </Field>
          <Field label="Archive completed after days">
            <FieldInput keyboardType="number-pad" value={days(prefs.autoArchiveDays)} onChangeText={(v) => setPrefs((current) => ({ ...current, autoArchiveDays: parseDays(v) }))} placeholder="Off" />
          </Field>
          <Field label="Purge recycle bin after days">
            <FieldInput keyboardType="number-pad" value={days(prefs.recyclePurgeDays)} onChangeText={(v) => setPrefs((current) => ({ ...current, recyclePurgeDays: parseDays(v) }))} placeholder="Off" />
          </Field>
          <Btn title="Save retention" onPress={() => void saveRetention()} style={{ minHeight: 44 }} />
        </View>
      ) : null}
    </SheetFrame>
  )
}

function ArchivePanel() {
  const insets = useSafeAreaInsets()
  const board = useBoard()
  const [period, setPeriod] = useState<ArchivePeriod>('day')
  useEffect(() => { void showArchive() }, [])
  const groups = groupArchive(board.archive ?? [], period, new Date())
  const hour = board.preferences.autoArchiveAt

  const header = (
    <View style={{ gap: 12, marginBottom: 4 }}>
      {hour ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Hi icon={ClockIcon} size={12} color={colors.muted} />
          <T size={12} muted>{`Completed tasks are archived at ${archiveHourLabel(hour)}`}</T>
        </View>
      ) : null}
      <View style={st.periods} accessibilityLabel="Group the archive by">
        {ARCHIVE_PERIODS.map((option) => {
          const on = period === option.value
          return (
            <Press key={option.value} haptic onPress={() => setPeriod(option.value)} style={[st.period, on && st.periodOn]} accessibilityState={{ selected: on }}>
              <T size={12} color={on ? colors.text : colors.muted}>{option.label}</T>
            </Press>
          )
        })}
      </View>
      {board.archiveError ? <InlineError>{board.archiveError}</InlineError> : null}
      {board.archiveLoading && !board.archive ? <Spinner label="Loading the archive…" /> : null}
    </View>
  )

  return (
    <>
    <SheetHead kicker={`${board.archiveCount.toLocaleString()} archived`} title="Archive" onClose={() => router.back()} />
    <SectionList
      sections={groups.map((group) => ({ key: group.key, title: group.label, data: group.todos }))}
      keyExtractor={(todo) => todo.id}
      style={{ flex: 1 }}
      contentContainerStyle={[st.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 20 }]}
      ListHeaderComponent={header}
      stickySectionHeadersEnabled={false}
      ListEmptyComponent={board.archive ? <T size={12} muted align="center" style={{ paddingVertical: 24 }}>Nothing archived yet.</T> : null}
      renderSectionHeader={({ section }) => (
        <View style={st.groupHead}>
          <T size={11.5} weight={600} muted>{section.title}</T>
          <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
          <T size={11.5} muted>{section.data.length.toLocaleString()}</T>
        </View>
      )}
      ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
      renderItem={({ item }) => <TodoCard todo={item} dim onOpen={(todo) => openTodo(todo)} />}
    />
    </>
  )
}

const st = StyleSheet.create({
  sheet: { paddingHorizontal: 16, paddingTop: 14 },
  rows: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, backgroundColor: colors.bg, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingVertical: 8, paddingHorizontal: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  first: { borderTopWidth: 0 },
  periods: { flexDirection: 'row', gap: 4 },
  period: { flex: 1, minHeight: 34, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line, borderRadius: 7, backgroundColor: colors.bg2 },
  periodOn: { borderColor: alpha(colors.accent, 0.55), backgroundColor: alpha(colors.accent, 0.12) },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, marginBottom: 8 },
})
