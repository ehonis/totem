// One row of the shared task sheet, opened from the list (the task route, todo/[id],
// with the row's "sheet:…" id). Totem never writes to the sheet (a partner shares it),
// so everything here is the sheet's own words, and Open in sheet opens that row in the
// browser or the Sheets app. What is kept in Totem, for the owner only: where the row
// is filed (a chat project or folder, or Personal; PUT /api/chat/task-folders/<row id>),
// and whether it is done or snoozed for the owner (POST /api/todos/sheet/mark, store.ts
// markSheet), which takes it off the owner's list and leaves the sheet unchanged.
import React, { useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import IconTable from '@tabler/icons-react-native/dist/esm/icons/IconTable.mjs'
import IconProgress from '@tabler/icons-react-native/dist/esm/icons/IconProgress.mjs'
import IconUser from '@tabler/icons-react-native/dist/esm/icons/IconUser.mjs'
import { colors, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, IconBtn } from '../../ui/kit'
import { Hi, ArrowTopRightOnSquareIcon, ArrowUturnLeftIcon, CalendarDaysIcon, CheckIcon, FlagIcon, FolderIcon, UserIcon, XMarkIcon, type IconType } from '../../lib/icons'
import { openUrl } from '../../lib/siblingApps'
import type { SheetHiddenItem, SheetItem } from '../../lib/todos/types'
import { dueText, dueTone } from './format'
import { SHEET_PRIORITY_WORD, linkParts } from './list'
import { PropertyGroup, PropertyRow } from './detail/PropertyRow'
import { SHEET_GREEN } from './SheetCard'
import { sheetPriorityColor } from './compose/labels'
import { InlineError, tone } from './ui'
import { folderActions, folderFor, folderLabel, folderPicked } from './folders'
import { useFolders } from './useFolders'
import { fileSheet, markSheet } from './store'
import { snoozeTimes } from './format'
import { sheetMarkOf, wakeLabel } from './board'
import { PickWhenSheet } from './ui'
import { showMenu } from '../../ui/menu'
import { ProjectIcon } from '../chat/ThreadIcon'
import { success, tap, warn } from '../../ui/haptics'
import TaskChats from '../work/TaskChats'

/** A task route's id that names a sheet row rather than a task. */
export const isSheetId = (id: string | undefined) => typeof id === 'string' && id.startsWith('sheet:')

export default function SheetItemPage({ item, source, fetchedAt }: { item: SheetItem | SheetHiddenItem | null; source: string; fetchedAt: string | null }) {
  const insets = useSafeAreaInsets()
  const { projects } = useFolders()
  const [fileError, setFileError] = useState('')
  const [markError, setMarkError] = useState('')
  const [pick, setPick] = useState(false)
  const now = new Date()
  const mark = sheetMarkOf(item, now)
  const snoozedUntil = mark?.state === 'snoozed' && mark.until && new Date(mark.until) > now ? mark.until : null
  const head = (
    <View style={st.head}>
      <View style={st.headLeft}>
        <View style={[st.pill, { borderColor: tone.sheet.borderColor, backgroundColor: tone.sheet.backgroundColor }]}>
          <IconTable size={12} color={SHEET_GREEN} strokeWidth={2} />
          <T size={12} weight={600} color={SHEET_GREEN} numberOfLines={1}>{source}</T>
        </View>
        <View style={st.pill}><T size={12} weight={600} muted numberOfLines={1}>{mark?.state === 'done' ? 'Done for you' : snoozedUntil ? `Snoozed until ${wakeLabel(new Date(snoozedUntil), now)}` : 'Read-only'}</T></View>
      </View>
      <IconBtn icon={XMarkIcon} size={20} box={44} label="Close" onPress={() => router.back()} />
    </View>
  )
  if (!item) {
    // Gone from the feed since the list was drawn: done in the sheet, reassigned, or renamed.
    return (
      <View style={st.frame}>
        {head}
        <View style={{ padding: 16, gap: 8 }}>
          <T size={16} weight={600}>This row is no longer in your list</T>
          <T size={14} muted lineHeight={20}>{`It was marked done in ${source}, assigned to someone else, or renamed since the list was drawn.`}</T>
        </View>
      </View>
    )
  }
  const filedIn = folderFor(item.folderId, projects)
  const onFolder = (id: string) => {
    const folder = folderPicked(id)
    if (folder === undefined) return
    tap()
    setFileError('')
    fileSheet(item.id, folder).catch((cause) => { warn(); setFileError(cause instanceof Error && cause.message ? cause.message : 'The row could not be filed there.') })
  }
  const id = item.id
  const setMark = (next: 'done' | 'snoozed' | null, until: Date | null = null) => {
    tap()
    setMarkError('')
    markSheet(id, next, until).then(() => { success(); if (next) router.back() })
      .catch((cause) => { warn(); setMarkError(cause instanceof Error && cause.message ? cause.message : 'The row could not be marked.') })
  }
  const snoozeMenu = () => showMenu([
    ...snoozeTimes(now).map((option) => ({ label: `${option.label} (${option.detail})`, onPress: () => setMark('snoozed', option.value) })),
    // The picker waits for the action sheet to finish closing: iOS refuses a second presentation mid-animation.
    { label: 'Pick a date and time', onPress: () => void setTimeout(() => setPick(true), 400) },
  ], { title: 'Snooze', message: `For you only; ${source} is unchanged.` })
  const due = item.dueDate ? dueTone(item.dueDate, now, 'todo') : ''
  const dueColor = due === 'overdue' ? tone.red.color : due === 'today' ? tone.amber.color : colors.text
  return (
    <View style={st.frame}>
      {head}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={[st.body, { paddingBottom: Math.max(insets.bottom, 16) + 28 }]}>
        <T size={22} lineHeight={28} weight={600} selectable style={{ fontFamily: fonts[600] }}>{item.title}</T>
        <PropertyGroup>
          <Info icon={IconProgress} stroke={1.6} label="Status" value={item.status || 'Not started'} />
          <Info icon={FlagIcon} label="Priority" value={item.priority ? SHEET_PRIORITY_WORD[item.priority] : 'None'} color={item.priority ? sheetPriorityColor(item.priority) : undefined} />
          <Info icon={CalendarDaysIcon} label="Due" value={item.dueDate ? dueText(item.dueDate, now) : 'None'} color={item.dueDate ? dueColor : undefined} />
          <Info icon={IconUser} stroke={1.6} label="Who" value={item.who || '—'} />
          <PropertyRow icon={FolderIcon} label="Folder" value={folderLabel(filedIn?.id, projects)}
            adornment={filedIn ? <ProjectIcon p={filedIn} size={15} /> : <Hi icon={UserIcon} size={14} color={colors.muted} />}
            valueColor={filedIn ? colors.text : undefined}
            actions={folderActions(projects, filedIn?.id ?? null)} onAction={onFolder} menuTitle="File under"
            hint="Files the row in Totem; the sheet is unchanged" />
        </PropertyGroup>
        {item.folderDefault && filedIn ? (
          <T size={12.5} muted lineHeight={18}>{`Where ${source}’s rows go until you file them (Settings → Tasks).`}</T>
        ) : null}
        {fileError ? <InlineError>{fileError}</InlineError> : null}
        {/* Done and snooze are the owner's alone, kept in Totem; the sheet is never written. */}
        {mark ? (
          <Btn icon={ArrowUturnLeftIcon} title="Put back on my list" onPress={() => setMark(null)} style={{ minHeight: 48 }} />
        ) : (
          <View style={st.actions}>
            <Btn icon={CheckIcon} title="Done for me" onPress={() => setMark('done')} style={{ flex: 1, minHeight: 48 }} />
            <Btn title="Snooze…" onPress={snoozeMenu} style={{ flex: 1, minHeight: 48 }} />
          </View>
        )}
        {mark?.state === 'snoozed' ? <Btn title="Snooze until another time…" onPress={snoozeMenu} style={{ minHeight: 44 }} /> : null}
        {markError ? <InlineError>{markError}</InlineError> : null}
        {item.notes ? (
          <View style={st.notes}>
            <T size={15} weight={600}>Notes & links</T>
            {/* One selectable block; its links open in the browser. */}
            <T size={15} lineHeight={21} selectable>
              {linkParts(item.notes).map(({ text, url }, index) => (url ? (
                <T key={index} size={15} lineHeight={21} color={colors.accent} style={st.link}
                  onPress={() => void openUrl(url)} accessibilityRole="link" accessibilityHint="Opens the link">{text}</T>
              ) : text))}
            </T>
          </View>
        ) : null}
        <Btn
          icon={ArrowTopRightOnSquareIcon}
          title={`Open in ${source}`}
          kind="primary"
          onPress={() => void openUrl(item.url)}
          style={{ minHeight: 48 }}
        />
        <T size={12.5} muted lineHeight={18}>
          {`Row ${item.row}. Change it in the sheet; Totem only reads it${fetchedAt ? `, last read ${new Date(fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}. Done and snooze here are yours alone: the sheet is unchanged.`}
        </T>
        <TaskChats taskRef={item.id} />
      </ScrollView>
      <PickWhenSheet
        visible={pick}
        title="Custom snooze time"
        mode="datetime"
        submitLabel="Snooze until selected time"
        initial={new Date(now.getTime() + 60 * 60_000)}
        minimum={now}
        onClose={() => setPick(false)}
        onSubmit={(value) => { setPick(false); setMark('snoozed', value) }}
      />
    </View>
  )
}

function Info({ icon, stroke, label, value, color }: { icon: IconType; stroke?: number; label: string; value: string; color?: string }) {
  return (
    <View style={st.row} accessible accessibilityLabel={`${label}: ${value}`}>
      <Hi icon={icon} size={18} color={colors.muted} strokeWidth={stroke} />
      <T size={15} style={{ width: 78 }}>{label}</T>
      <T size={15} numberOfLines={2} color={color ?? colors.muted} style={{ flex: 1, textAlign: 'right' }}>{value}</T>
    </View>
  )
}

const st = StyleSheet.create({
  frame: { flex: 1, backgroundColor: colors.bg2 },
  // Room above for the grabber.
  head: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingTop: 14, paddingLeft: 16, paddingRight: 8 },
  headLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 2, paddingHorizontal: 8, flexShrink: 1,
    borderWidth: 1, borderColor: colors.line, borderRadius: 999, backgroundColor: colors.bg3,
  },
  body: { paddingHorizontal: 16, paddingTop: 10, gap: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingHorizontal: 14 },
  notes: { gap: 6 },
  actions: { flexDirection: 'row', gap: 10 },
  link: { textDecorationLine: 'underline' },
})
