// The bar above the board (web/src/todos/TodoToolbar.tsx) at its phone size:
// search, then Filter / Sort / Select as 44pt icon buttons. The web's popovers
// are native menus — each filter a submenu with its options checked, the sort a
// stack of "Sort by / then by" submenus — and what is on still shows as chips.
import React from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { MenuView, type MenuAction } from '@react-native-menu/menu'
import { colors, alpha } from '../../theme'
import { T } from '../../ui/Text'
import { Input, Press } from '../../ui/kit'
import { confirm, prompt, showMenu } from '../../ui/menu'
import { tap } from '../../ui/haptics'
import {
  Hi, AdjustmentsHorizontalIcon, BarsArrowDownIcon, CheckCircleIcon, MagnifyingGlassIcon, XMarkIcon,
} from '../../lib/icons'
import { useVentureTags } from '../../lib/todos/ventureTags'
import type { TodoQuery, TodoSort, TodoSortOrder } from '../../lib/todos/types'

const SORT_OPTIONS: readonly { value: Exclude<TodoSort, 'manual'>; label: string }[] = [
  { value: 'due', label: 'Due date' },
  { value: 'priority', label: 'Priority' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'created', label: 'Recently created' },
]

type FilterKey = 'area' | 'ventureTag' | 'priority' | 'due' | 'source'

// One description of each filter, shared by the menu and the chips, so a filter
// can never read one way when you set it and another way once it is on.
const BASE_FILTERS: readonly { key: FilterKey; label: string; all: string; options: readonly { value: string; label: string }[] }[] = [
  { key: 'area', label: 'Area', all: 'All areas', options: [{ value: 'Personal', label: 'Personal' }, { value: 'Ventures', label: 'Ventures' }] },
  // Filled from the install's venture tags; see filtersFor().
  { key: 'ventureTag', label: 'Venture', all: 'All ventures', options: [] },
  { key: 'priority', label: 'Priority', all: 'All priorities', options: [{ value: '4', label: 'P1' }, { value: '3', label: 'P2' }, { value: '2', label: 'P3' }, { value: '1', label: 'P4' }] },
  { key: 'due', label: 'Due', all: 'Any due date', options: [{ value: 'overdue', label: 'Overdue' }, { value: 'today', label: 'Today' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'none', label: 'No date' }] },
  { key: 'source', label: 'Source', all: 'All sources', options: [{ value: 'local', label: 'Private' }, { value: 'github', label: 'GitHub' }, { value: 'sheet', label: 'Action Items' }] },
]

// The venture filter lists the configured tags, and disappears (along with the
// Ventures area option) when there are none.
function filtersFor(tags: { name: string }[]) {
  if (!tags.length) {
    return BASE_FILTERS
      .filter((filter) => filter.key !== 'ventureTag')
      .map((filter) => (filter.key === 'area' ? { ...filter, options: filter.options.filter((option) => option.value !== 'Ventures') } : filter))
  }
  return BASE_FILTERS.map((filter) => (filter.key === 'ventureTag' ? { ...filter, options: tags.map((tag) => ({ value: tag.name, label: tag.name })) } : filter))
}

interface Props {
  query: TodoQuery
  sort: TodoSortOrder
  groupBySource: boolean
  bulkMode: boolean
  selectedCount: number
  onQuery: (query: TodoQuery) => void
  onSort: (sort: TodoSort[]) => void
  onGroupBySource: (value: boolean) => void
  onBulkMode: (value: boolean) => void
  onBulk: (operation: string, value?: unknown) => void
}

export default function TodoToolbar({ query, sort, groupBySource, bulkMode, selectedCount, onQuery, onSort, onGroupBySource, onBulkMode, onBulk }: Props) {
  const FILTERS = filtersFor(useVentureTags())

  // Priority is the one filter the query holds as a number; everything else is the
  // option value as typed, so the menu and the chips can treat all five as strings.
  const valueOf = (key: FilterKey) => {
    const raw = query[key]
    return raw === null || raw === undefined ? '' : String(raw)
  }
  const set = (key: FilterKey, value: string) =>
    onQuery({ ...query, [key]: key === 'priority' ? (value ? Number(value) : null) : value })
  const active = FILTERS.filter((filter) => valueOf(filter.key))
  const clearAll = () => onQuery(FILTERS.reduce((next, filter) => ({ ...next, [filter.key]: filter.key === 'priority' ? null : '' }), { ...query }))

  const manual = sort[0] === 'manual'
  const availableSorts = SORT_OPTIONS.filter((option) => !sort.includes(option.value))
  const sortLabel = (criterion: TodoSort) => criterion === 'manual' ? 'Manual order' : SORT_OPTIONS.find((option) => option.value === criterion)?.label ?? criterion
  const setCriterion = (index: number, value: TodoSort) => {
    if (index === 0 && value === 'manual') return onSort(['manual'])
    const next = manual ? [] : [...sort]
    next[index] = value
    onSort(next)
  }
  const removeCriterion = (index: number) => {
    const next = sort.filter((_, criterionIndex) => criterionIndex !== index)
    onSort(next.length ? [...next] : ['manual'])
  }

  const filterActions: MenuAction[] = [
    ...FILTERS.map((filter): MenuAction => {
      const value = valueOf(filter.key)
      return {
        id: filter.key, title: filter.label,
        subtitle: filter.options.find((option) => option.value === value)?.label ?? filter.all,
        subactions: [{ value: '', label: filter.all }, ...filter.options].map((option) => ({
          id: `f:${filter.key}:${option.value}`, title: option.label, state: value === option.value ? 'on' : 'off',
        })),
      }
    }),
    {
      id: 'filter-more', title: '', displayInline: true, subactions: [
        { id: 'group', title: 'Group by source', image: 'rectangle.split.3x1', state: groupBySource ? 'on' : 'off' },
        { id: 'clear', title: 'Clear filters', attributes: active.length ? undefined : { disabled: true } },
      ],
    },
  ]

  const sortActions: MenuAction[] = [
    ...sort.map((criterion, index): MenuAction => ({
      id: `sort-${index}`, title: index === 0 ? 'Sort by' : 'Then by', subtitle: sortLabel(criterion),
      subactions: [
        ...(index === 0 ? [{ id: `s:${index}:manual`, title: 'Manual order', state: manual ? 'on' as const : 'off' as const }] : []),
        ...SORT_OPTIONS.map((option) => ({
          id: `s:${index}:${option.value}`, title: option.label, state: criterion === option.value ? 'on' as const : 'off' as const,
          attributes: sort.includes(option.value) && option.value !== criterion ? { disabled: true } : undefined,
        })),
        ...(index > 0 ? [{ id: `s:${index}:remove`, title: 'Remove', attributes: { destructive: true } }] : []),
      ],
    })),
    ...(!manual && availableSorts.length ? [{ id: 'then', title: 'Then by', image: 'plus' }] : []),
  ]

  function pressFilter(id: string) {
    tap()
    if (id === 'group') return onGroupBySource(!groupBySource)
    if (id === 'clear') return clearAll()
    const [, key, ...rest] = id.split(':')
    set(key as FilterKey, rest.join(':'))
  }

  function pressSort(id: string) {
    tap()
    if (id === 'then') return onSort([...sort, availableSorts[0].value])
    const [, index, value] = id.split(':')
    if (value === 'remove') return removeCriterion(Number(index))
    setCriterion(Number(index), value as TodoSort)
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
        <MenuView title="Filter and group tasks" actions={filterActions} themeVariant="dark" onPressAction={({ nativeEvent }) => pressFilter(nativeEvent.event)}>
          <View style={[st.tool, active.length ? st.toolOn : null]} accessibilityRole="button" accessibilityLabel="Filter">
            <Hi icon={AdjustmentsHorizontalIcon} size={17} color={active.length ? colors.text : colors.muted} />
            {active.length ? <View style={st.count}><T size={10} weight={700} lineHeight={13} color="#0b0d12">{active.length}</T></View> : null}
          </View>
        </MenuView>
        <MenuView
          title="Manual order keeps the positions you put cards in. Any other order is a view — it never moves a card."
          actions={sortActions}
          themeVariant="dark"
          onPressAction={({ nativeEvent }) => pressSort(nativeEvent.event)}
        >
          <View style={[st.tool, manual ? null : st.toolOn]} accessibilityRole="button" accessibilityLabel={manual ? 'Manual order' : sort.map(sortLabel).join(' → ')}>
            <Hi icon={BarsArrowDownIcon} size={17} color={manual ? colors.muted : colors.text} />
          </View>
        </MenuView>
        <Press haptic onPress={() => onBulkMode(!bulkMode)} style={[st.tool, bulkMode && st.toolOn]} accessibilityRole="button" accessibilityLabel="Select" accessibilityState={{ selected: bulkMode }}>
          <Hi icon={CheckCircleIcon} size={17} color={bulkMode ? colors.text : colors.muted} />
        </Press>
      </View>

      {active.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, alignItems: 'center' }}>
          {active.map((filter) => (
            <Press haptic key={filter.key} style={st.chip} onPress={() => set(filter.key, '')} accessibilityLabel={`Clear ${filter.label} filter`}>
              <T size={12} muted>{filter.label}</T>
              <T size={12}>{filter.options.find((option) => option.value === valueOf(filter.key))?.label ?? valueOf(filter.key)}</T>
              <Hi icon={XMarkIcon} size={12} color={colors.text} />
            </Press>
          ))}
          <Press haptic onPress={clearAll} style={{ minHeight: 30, justifyContent: 'center', paddingHorizontal: 6 }}>
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
    <Press haptic disabled={disabled} onPress={onPress} style={st.bulkBtn}>
      <T size={12} color={danger ? '#ff7f95' : colors.text}>{label}</T>
    </Press>
  )
}

const st = StyleSheet.create({
  toolbar: { gap: 6, paddingBottom: 8, marginBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.line },
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
  bulkBtn: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 9, borderWidth: 1, borderColor: colors.line, borderRadius: 7, backgroundColor: colors.bg2 },
})
