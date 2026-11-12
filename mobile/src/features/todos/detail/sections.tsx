// The task page below its fields: notes (append-only), related tasks, the linked
// GitHub issue, and the task's history.
import React, { useState } from 'react'
import { StyleSheet, TextInput, View, type LayoutChangeEvent } from 'react-native'
import { MenuView, type MenuAction } from '@react-native-menu/menu'
import { colors, fonts, radius } from '../../../theme'
import { T } from '../../../ui/Text'
import IconBrandGithub from '@tabler/icons-react-native/dist/esm/icons/IconBrandGithub.mjs'
import { Btn, IconBtn, Press } from '../../../ui/kit'
import { tap } from '../../../ui/haptics'
import {
  Hi, ArrowTopRightOnSquareIcon, ArrowUpSolidIcon, LinkIcon, PlusIcon, XMarkIcon,
} from '../../../lib/icons'
import type { IssueState, Todo, TodoIssueLink } from '../../../lib/todos/types'
import { openUrl } from '../../../lib/siblingApps'
import { historyRows } from './model'
import { SectionTitle, whenLabel } from './bits'
import { StatusDot } from './CompleteCircle'
import { ISSUE_COLOR, readIssueLink } from '../issueLink'

export function NotesSection({ notes, draft, onDraft, onSend, sending, inputRef, onLayout, feedback }: {
  notes: Todo['notes']
  draft: string
  onDraft: (value: string) => void
  onSend: () => void
  sending: boolean
  inputRef: React.Ref<TextInput>
  onLayout?: (event: LayoutChangeEvent) => void
  feedback: React.ReactNode
}) {
  const canSend = Boolean(draft.trim()) && !sending
  return (
    <View style={st.section} onLayout={onLayout}>
      <SectionTitle title="Notes" aside={notes.length ? 'Append-only' : undefined} />
      {notes.length ? (
        <View style={st.timeline}>
          {notes.map((item, index) => (
            <View key={item.id} style={st.note}>
              <View style={st.rail}>
                <View style={st.railDot} />
                {index < notes.length - 1 ? <View style={st.railLine} /> : null}
              </View>
              <View style={{ flex: 1, gap: 3, paddingBottom: index < notes.length - 1 ? 14 : 0 }}>
                <T size={15} lineHeight={21} selectable>{item.body}</T>
                <T size={12} muted>{whenLabel(item.createdAt)}</T>
              </View>
            </View>
          ))}
        </View>
      ) : <T size={14} muted>Notes are kept in order and never rewritten. Add the first below.</T>}
      <View style={st.compose}>
        <TextInput
          ref={inputRef}
          value={draft}
          onChangeText={onDraft}
          placeholder="Add a note"
          placeholderTextColor={colors.muted}
          selectionColor={colors.accent}
          keyboardAppearance="dark"
          accessibilityLabel="New note"
          // A note may run to several lines; the arrow sends it.
          multiline
          style={st.composeInput}
        />
        <Press
          haptic
          onPress={onSend}
          disabled={!canSend}
          hitSlop={6}
          style={[st.send, canSend && { backgroundColor: colors.accent }]}
          accessibilityRole="button"
          accessibilityLabel="Append note"
        >
          <Hi icon={ArrowUpSolidIcon} size={16} color={canSend ? colors.white : colors.muted} />
        </Press>
      </View>
      {feedback}
    </View>
  )
}

export function RelatedSection({ relations, relatable, onOpen, onRelate, onUnlink, busy, feedback }: {
  relations: Todo['relations']
  relatable: Todo[]
  onOpen: (id: string) => void
  onRelate: (id: string) => void
  onUnlink: (id: string) => void
  busy: boolean
  feedback: React.ReactNode
}) {
  const actions: MenuAction[] = relatable.length
    ? relatable.map((item) => ({ id: item.id, title: item.title }))
    : [{ id: '', title: 'No other tasks to relate', attributes: { disabled: true } }]
  return (
    <View style={st.section}>
      <SectionTitle title="Related tasks" aside={relations.length || undefined} />
      {relations.map((relation) => (
        <View key={relation.id} style={st.relation}>
          <Press onPress={() => onOpen(relation.id)} style={st.relationBody} accessibilityRole="button" accessibilityLabel={`Open ${relation.title}`}>
            <StatusDot status={relation.status} />
            <T size={15} numberOfLines={2} style={{ flex: 1 }} color={relation.status === 'done' ? colors.muted : colors.text}>{relation.title}</T>
          </Press>
          <IconBtn icon={XMarkIcon} size={16} box={44} color={colors.muted} label={`Remove relation to ${relation.title}`} disabled={busy} onPress={() => onUnlink(relation.id)} />
        </View>
      ))}
      <MenuView title="Relate a task" actions={actions} themeVariant="dark" onPressAction={({ nativeEvent }) => { if (nativeEvent.event) { tap(); onRelate(nativeEvent.event) } }}>
        <View style={[st.addRow, busy && { opacity: 0.5 }]} accessibilityRole="button" accessibilityLabel="Relate a task">
          <Hi icon={PlusIcon} size={16} color={colors.accent} />
          <T size={15} color={colors.accent}>Relate a task</T>
        </View>
      </MenuView>
      {feedback}
    </View>
  )
}

/**
 * The task's GitHub issue: a plain link (no sync; the issue does not decide when the
 * task is done) with its live open/closed state once read, set or cleared here.
 */
export function IssueLinkSection({ link, state, onSave, busy, feedback, disabled }: {
  link: TodoIssueLink | null
  state: IssueState | undefined
  /** A link to set, or null to clear it. Resolves true once the bridge took it. */
  onSave: (url: string | null) => Promise<boolean>
  busy: boolean
  feedback: React.ReactNode
  disabled?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [problem, setProblem] = useState('')
  const start = () => { tap(); setText(link?.url ?? ''); setProblem(''); setEditing(true) }
  async function save() {
    const read = readIssueLink(text)
    if ('error' in read) { setProblem(read.error); return }
    setProblem('')
    if (await onSave(read.url)) setEditing(false)
  }
  return (
    <View style={st.section}>
      <SectionTitle title="GitHub issue" />
      {link && !editing ? (
        <View style={st.relation}>
          <Press onPress={() => void openUrl(link.url)} style={st.relationBody} accessibilityRole="link"
            accessibilityLabel={`Open issue ${link.repo}#${link.number}${state ? `, ${state.state}` : ''}${state?.title ? `: ${state.title}` : ''}`}>
            <IconBrandGithub size={18} color={colors.text} strokeWidth={1.8} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <T size={15} numberOfLines={1}>
                {`${link.repo}#${link.number}`}
                {state ? <T size={15} color={ISSUE_COLOR[state.state]}>{`  ${state.state === 'open' ? 'Open' : 'Closed'}`}</T> : null}
              </T>
              {state?.title ? <T size={13} muted numberOfLines={2}>{state.title}</T> : null}
            </View>
            <Hi icon={ArrowTopRightOnSquareIcon} size={14} color={colors.accent} />
          </Press>
        </View>
      ) : null}
      {editing ? (
        <View style={{ gap: 8 }}>
          <TextInput
            value={text}
            onChangeText={(value) => { setText(value); if (problem) setProblem('') }}
            placeholder="https://github.com/owner/repo/issues/12"
            placeholderTextColor={colors.muted}
            selectionColor={colors.accent}
            keyboardAppearance="dark"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
            autoFocus
            onSubmitEditing={() => void save()}
            accessibilityLabel="GitHub issue link"
            style={st.linkInput}
          />
          {problem ? <T size={13} color="#ff9caf">{problem}</T> : null}
          <View style={st.btnRow}>
            <Btn title="Cancel" onPress={() => { setEditing(false); setProblem('') }} disabled={busy} style={[st.btn, { flex: 1 }]} />
            <Btn kind="primary" title="Save link" loading={busy} disabled={!text.trim()} onPress={() => void save()} style={[st.btn, { flex: 1 }]} />
          </View>
        </View>
      ) : disabled ? null : (
        <View style={st.btnRow}>
          <Press onPress={start} style={[st.addRow, { flex: 1 }]} accessibilityRole="button" accessibilityLabel={link ? 'Change the issue link' : 'Link a GitHub issue'}>
            <Hi icon={link ? LinkIcon : PlusIcon} size={16} color={colors.accent} />
            <T size={15} color={colors.accent}>{link ? 'Change link' : 'Link a GitHub issue'}</T>
          </Press>
          {link ? (
            <Press onPress={() => { tap(); void onSave(null) }} disabled={busy} style={st.addRow} accessibilityRole="button" accessibilityLabel="Remove the issue link. The issue is unchanged">
              <T size={15} color="#f0879e">{busy ? 'Removing…' : 'Remove'}</T>
            </Press>
          ) : null}
        </View>
      )}
      {feedback}
    </View>
  )
}

export function HistorySection({ todo }: { todo: Todo }) {
  const rows = historyRows(todo)
  return (
    <View style={st.section}>
      <SectionTitle title="History" />
      {rows.map((row) => (
        <View key={row.key} style={st.history}>
          <T size={14} muted style={{ flex: 1 }}>{row.label}</T>
          <T size={14} muted>{whenLabel(row.at)}</T>
        </View>
      ))}
      {todo.lists.length ? (
        <View style={st.history}>
          <T size={14} muted style={{ flex: 1 }}>{todo.lists.length === 1 ? 'In the list' : 'In the lists'}</T>
          <T size={14} muted numberOfLines={2} style={{ flexShrink: 1, textAlign: 'right' }}>{todo.lists.map((list) => list.title).join(', ')}</T>
        </View>
      ) : null}
    </View>
  )
}

const st = StyleSheet.create({
  section: { gap: 10, paddingTop: 18, marginTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  timeline: { paddingTop: 2 },
  note: { flexDirection: 'row', gap: 10 },
  rail: { width: 10, alignItems: 'center', paddingTop: 7 },
  railDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  railLine: { flex: 1, width: 1, marginTop: 4, backgroundColor: colors.line },
  compose: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 6, paddingLeft: 12, paddingRight: 5, paddingVertical: 5,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line, borderRadius: 22,
  },
  composeInput: {
    flex: 1, minHeight: 34, maxHeight: 140, paddingTop: 8, paddingBottom: 8, color: colors.text, fontFamily: fonts[400], fontSize: 16,
  },
  send: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg3 },
  relation: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  relationBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  btn: { minHeight: 44 },
  linkInput: {
    minHeight: 44, paddingHorizontal: 12, color: colors.text, fontFamily: fonts[400], fontSize: 16,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md,
  },
  btnRow: { flexDirection: 'row', gap: 8 },
  history: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
})
