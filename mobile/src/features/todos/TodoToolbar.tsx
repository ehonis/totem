// The bar above the list (web/src/todos/TodoToolbar.tsx) at its phone size: search,
// then Filter and "…" as 44pt icon buttons. The web's popovers are native menus, each
// filter a submenu with its options checked, and what is on still shows as chips.
// There is no sort: the list's order is the shared one (due day, priority, tasks
// before sheet rows, then the order you put them in). "Show" narrows to an area or to
// the task sheet alone. The "…" holds Select (bulk actions) and the lifecycle panels
// (snoozed, archive, recycle bin, retention), each with its count.
import React from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { MenuView, type MenuAction } from '@react-native-menu/menu'
import { colors, alpha } from '../../theme'
import { T } from '../../ui/Text'
import { Input, Press } from '../../ui/kit'
import { confirm, prompt, showMenu } from '../../ui/menu'
import { tap } from '../../ui/haptics'
import { Hi, AdjustmentsHorizontalIcon, EllipsisHorizontalIcon, MagnifyingGlassIcon, XMarkIcon } from '../../lib/icons'
import { useVentureTags } from '../../lib/todos/ventureTags'
import type { ListQuery } from './list'

export type LifecyclePanel = 'snoozed' | 'deleted' | 'archive' | 'retention'

type FilterKey = 'scope' | 'ventureTag' | 'priority' | 'due'
type FilterOption = { value: string; label: string; note?: string; disabled?: boolean }
type Filter = { key: FilterKey; label: string; all: string; options: readonly FilterOption[] }

// One description of each filter, shared by the menu and the chips, so a filter
// can never read one way when you set it and another way once it is on.
const BASE_FILTERS: readonly Filter[] = [
  // Filled with the areas and the task sheet; see filtersFor().
  { key: 'scope', label: 'Show', all: 'Everything', options: [] },
  // Filled from the install's venture tags; see filtersFor().
  { key: 'ventureTag', label: 'Venture', all: 'All ventures', options: [] },
  { key: 'priority', label: 'Priority', all: 'All priorities', options: [{ value: '4', label: 'P1' }, { value: '3', label: 'P2' }, { value: '2', label: 'P3' }, { value: '1', label: 'P4' }] },
  { key: 'due', label: 'Due', all: 'Any due date', options: [{ value: 'overdue', label: 'Overdue' }, { value: 'today', label: 'Today' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'none', label: 'No date' }] },
]

/**
 * The venture filter lists the configured tags, and disappears (along with the
 * Ventures option) when there are none. Show offers the task sheet by its own name;
 * one that is not set up is listed greyed, saying so.
 */
function filtersFor(tags: { name: string }[], sheet: { name: string; configured: boolean | null }): Filter[] {
  const scope: FilterOption[] = [
    { value: 'Personal', label: 'Personal tasks' },
    ...(tags.length ? [{ value: 'Ventures', label: 'Ventures tasks' }] : []),
    sheet.configured === false
      ? { value: 'sheet', label: sheet.name, note: 'Not set up · Settings → Tasks', disabled: true }
      : { value: 'sheet', label: sheet.name },
  ]
  return BASE_FILTERS
    .filter((filter) => filter.key !== 'ventureTag' || tags.length > 0)
    .map((filter) => filter.key === 'scope' ? { ...filter, options: scope }
      : filter.key === 'ventureTag' ? { ...filter, options: tags.map((tag) => ({ value: tag.name, label: tag.name })) }
        : filter)
}

interface Props {
  query: ListQuery
  /** The task sheet, by the feed's name; `configured` is null until it has been read. */
  sheet: { name: string; configured: boolean | null }
  bulkMode: boolean
  selectedCount: number
  /** Counts for the "…" menu's lifecycle rows. */
  lifecycle: { snoozed: number; nextWake: string | null; deleted: number; archived: number }
  onQuery: (query: ListQuery) => void
  onBulkMode: (value: boolean) => void
  onBulk: (operation: string, value?: unknown) => void
  onLifecycle: (panel: LifecyclePanel) => void
}

export default function TodoToolbar({ query, sheet, bulkMode, selectedCount, lifecycle, onQuery, onBulkMode, onBulk, onLifecycle }: Props) {
  const FILTERS = filtersFor(useVentureTags(), sheet)

  // Priority is the one filter the query holds as a number; everything else is the
  // option value as typed, so the menu and the chips can treat all four as strings.
  const valueOf = (key: FilterKey) => {
    const raw = query[key]
    return raw === null || raw === undefined ? '' : String(raw)
  }
  const set = (key: FilterKey, value: string) =>
    onQuery({ ...query, [key]: key === 'priority' ? (value ? Number(value) : null) : value })
  const active = FILTERS.filter((filter) => valueOf(filter.key))
  const clearAll = () => onQuery(FILTERS.reduce((next, filter) => ({ ...next, [filter.key]: filter.key === 'priority' ? null : '' }), { ...query }))

  const filterActions: MenuAction[] = [
    ...FILTERS.map((filter): MenuAction => {
      const value = valueOf(filter.key)
      return {
        id: filter.key, title: filter.label,
        subtitle: filter.options.find((option) => option.value === value)?.label ?? filter.all,
        subactions: [{ value: '', label: filter.all } as FilterOption, ...filter.options].map((option): MenuAction => ({
          id: `f:${filter.key}:${option.value}`, title: option.label, subtitle: option.note, state: value === option.value ? 'on' : 'off',
          attributes: option.disabled ? { disabled: true } : undefined,
        })),
      }
    }),
    {
      id: 'filter-more', title: '', displayInline: true, subactions: [
        { id: 'clear', title: 'Clear filters', attributes: active.length ? undefined : { disabled: true } },
      ],
    },
  ]

  function pressFilter(id: string) {
    tap()
    if (id === 'clear') return clearAll()
    const [, key, ...rest] = id.split(':')
    set(key as FilterKey, rest.join(':'))
  }

  const count = (n: number) => n.toLocaleString()
  const moreActions: MenuAction[] = [
    { id: 'select', title: bulkMode ? 'Stop selecting' : 'Select tasks', image: 'checkmark.circle' },
    {
      id: 'panels', title: '', displayInline: true, subactions: [
        { id: 'snoozed', title: 'Snoozed', subtitle: lifecycle.snoozed ? `${count(lifecycle.snoozed)}${lifecycle.nextWake ? ` · next back ${lifecycle.nextWake}` : ''}` : 'None', image: 'moon.zzz' },
        { id: 'archive', title: 'Archive', subtitle: lifecycle.archived ? count(lifecycle.archived) : 'Empty', image: 'archivebox' },
        { id: 'deleted', title: 'Recycle bin', subtitle: lifecycle.deleted ? count(lifecycle.deleted) : 'Empty', image: 'trash' },
        { id: 'retention', title: 'Retention', subtitle: 'When finished tasks are archived and the bin emptied', image: 'clock.arrow.circlepath' },
      ],
    },
  ]

  function pressMore(id: string) {
    tap()
    if (id === 'select') return onBulkMode(!bulkMode)
    if (id === 'snoozed' || id === 'archive' || id === 'deleted' || id === 'retention') onLifecycle(id)
  }

  async function bulkTag() {
    // The prompt waits for the action sheet to close; iOS drops an alert presented mid-dismissal.
    const ask = (title: string, message: string, operation: string) => setTimeout(async () => {
      const tag = await prompt(title, { message })
      if (tag) onBulk(operation, tag)
    }, 400)
    showMenu([
      { label: 'Add a tag…', onPress: () => void ask('Add a tag', `To ${selectedCount} selected`, 'addTag') },
      { label: 'Remove a tag…', onPress: () => void ask('Remove a tag', `From ${selectedCount} selected`, 'removeTag') },
    ], { title: 'Tag' })
  }

  return (
    <View style={st.toolbar}>
      <View style={st.row}>
        <Input
          icon={MagnifyingGlassIcon}
          value={query.search || ''}
          onChangeText={(search) => onQuery({ ...query, search })}
          placeholder="Search tasks"
          accessibilityLabel="Search tasks"
          returnKeyType="search"
          clearButtonMode="while-editing"
          style={st.search}
        />
        <MenuView title="Filter tasks" actions={filterActions} themeVariant="dark" onPressAction={({ nativeEvent }) => pressFilter(nativeEvent.event)}>
          <View style={[st.tool, active.length ? st.toolOn : null]} accessibilityRole="button" accessibilityLabel="Filter">
            <Hi icon={AdjustmentsHorizontalIcon} size={17} color={active.length ? colors.text : colors.muted} />
            {active.length ? <View style={st.count}><T size={10} weight={700} lineHeight={13} color="#0b0d12">{active.length}</T></View> : null}
          </View>
        </MenuView>
        <MenuView title="Tasks" actions={moreActions} themeVariant="dark" onPressAction={({ nativeEvent }) => pressMore(nativeEvent.event)}>
          <View style={[st.tool, bulkMode && st.toolOn]} accessibilityRole="button" accessibilityLabel="More: select, snoozed, archive, recycle bin, retention" accessibilityState={{ selected: bulkMode }}>
            <Hi icon={EllipsisHorizontalIcon} size={19} color={bulkMode ? colors.text : colors.muted} />
          </View>
        </MenuView>
      </View>

      {active.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, alignItems: 'center', minHeight: 44 }}>
          {active.map((filter) => (
            <Press haptic key={filter.key} style={st.chip} hitSlop={7} onPress={() => set(filter.key, '')} accessibilityLabel={`Clear ${filter.label} filter`}>
              <T size={12} muted>{filter.label}</T>
              <T size={12}>{filter.options.find((option) => option.value === valueOf(filter.key))?.label ?? valueOf(filter.key)}</T>
              <Hi icon={XMarkIcon} size={12} color={colors.text} />
            </Press>
          ))}
          <Press haptic onPress={clearAll} hitSlop={7} style={{ minHeight: 30, justifyContent: 'center', paddingHorizontal: 6 }}>
            <T size={12} muted style={{ textDecorationLine: 'underline' }}>Clear all</T>
          </Press>
        </ScrollView>
      ) : null}

      {bulkMode ? (
        <View style={st.bulk}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, alignItems: 'center', paddingHorizontal: 8 }}>
            <T size={12} weight={600} style={{ marginRight: 2 }}>{`${selectedCount.toLocaleString()} selected`}</T>
            <BulkBtn label="Mark done" disabled={!selectedCount} onPress={() => onBulk('complete')} />
            <BulkBtn label="Set P1" disabled={!selectedCount} onPress={() => onBulk('priority', 4)} />
            <BulkBtn label="Archive done" disabled={!selectedCount} onPress={() => onBulk('archive')} />
            <BulkBtn label="Tag…" disabled={!selectedCount} onPress={() => void bulkTag()} />
            <BulkBtn label="Delete" danger disabled={!selectedCount} onPress={async () => {
              if (await confirm(`Move ${selectedCount} task${selectedCount === 1 ? '' : 's'} to the recycle bin?`, { confirmLabel: 'Delete' })) onBulk('delete')
            }} />
            <BulkBtn label="Done" onPress={() => onBulkMode(false)} />
          </ScrollView>
        </View>
      ) : null}
    </View>
  )
}

function BulkBtn({ label, onPress, disabled, danger }: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <Press haptic disabled={disabled} onPress={onPress} style={st.bulkBtn} hitSlop={4} accessibilityRole="button">
      <T size={12} color={danger ? '#ff7f95' : colors.text}>{label}</T>
    </Press>
  )
}

const st = StyleSheet.create({
  toolbar: { gap: 8, paddingBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  search: { flex: 1, minHeight: 44, borderRadius: 8, paddingHorizontal: 10, gap: 7 },
  tool: {
    width: 44, height: 44, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.line, borderRadius: 8, backgroundColor: colors.bg2,
  },
  toolOn: { borderColor: alpha(colors.accent, 0.55), backgroundColor: alpha(colors.accent, 0.12) },
  count: {
    position: 'absolute', top: -3, right: -3, minWidth: 17, height: 17, paddingHorizontal: 4, borderRadius: 999,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#4d77d9',
  },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 30, paddingHorizontal: 8,
    borderWidth: 1, borderColor: alpha(colors.accent, 0.45), borderRadius: 999, backgroundColor: alpha(colors.accent, 0.12),
  },
  bulk: {
    paddingVertical: 6, borderWidth: 1, borderColor: alpha(colors.accent, 0.35), borderRadius: 9, backgroundColor: '#172033',
  },
  bulkBtn: { minHeight: 38, justifyContent: 'center', paddingHorizontal: 9, borderWidth: 1, borderColor: colors.line, borderRadius: 7, backgroundColor: colors.bg2 },
})
