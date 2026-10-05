/**
 * The bar above the board: search, filters, sort, grouping, and bulk selection.
 *
 * Everything here used to be on show at once — five identical dropdowns reading
 * "All areas / All ventures / All priorities / Any due date / All sources" sat in a
 * second row whether or not anything was filtered, and none of them looked any
 * different when they were. That is two rows of chrome to say "nothing is filtered".
 *
 * So the controls collapse into buttons that state their own value, and the detail
 * lives in popovers. What is actually *on* is the only thing that takes space: an
 * active filter becomes a chip you can remove, and bulk mode swaps in its own row
 * instead of squeezing seven buttons onto the end of the filters.
 */
import React, { useEffect, useRef, useState } from 'react'
import {
  Hi, AdjustmentsHorizontalIcon, BarsArrowDownIcon, CheckCircleIcon, ChevronDownIcon,
  MagnifyingGlassIcon, PlusIcon, ViewColumnsIcon, XMarkIcon,
} from '../icons'
import { useVentureTags } from './ventureTags'
import type { TodoQuery, TodoSort, TodoSortOrder } from './types'

const SORT_OPTIONS: readonly { value: Exclude<TodoSort, 'manual'>; label: string }[] = [
  { value: 'due', label: 'Due date' },
  { value: 'priority', label: 'Priority' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'created', label: 'Recently created' },
]

type FilterKey = 'area' | 'ventureTag' | 'priority' | 'due' | 'source'

// One description of each filter, shared by the popover and the chips, so a filter
// can never read one way when you set it and another way once it is on.
const BASE_FILTERS: readonly {
  key: FilterKey
  label: string
  all: string
  options: readonly { value: string; label: string }[]
}[] = [
  {
    key: 'area', label: 'Area', all: 'All areas',
    options: [{ value: 'Personal', label: 'Personal' }, { value: 'Ventures', label: 'Ventures' }],
  },
  {
    key: 'ventureTag', label: 'Venture', all: 'All ventures',
    // Filled from the install's venture tags; see filtersFor().
    options: [],
  },
  {
    key: 'priority', label: 'Priority', all: 'All priorities',
    options: [{ value: '4', label: 'P1' }, { value: '3', label: 'P2' }, { value: '2', label: 'P3' }, { value: '1', label: 'P4' }],
  },
  {
    key: 'due', label: 'Due', all: 'Any due date',
    options: [{ value: 'overdue', label: 'Overdue' }, { value: 'today', label: 'Today' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'none', label: 'No date' }],
  },
  {
    key: 'source', label: 'Source', all: 'All sources',
    options: [{ value: 'local', label: 'Private' }, { value: 'github', label: 'GitHub' }, { value: 'sheet', label: 'Action Items' }],
  },
]

// The venture filter lists the configured tags, and disappears (along with the
// Ventures area option) when there are none.
function filtersFor(tags: { name: string }[]) {
  if (!tags.length) {
    return BASE_FILTERS
      .filter(filter => filter.key !== 'ventureTag')
      .map(filter => filter.key === 'area' ? { ...filter, options: filter.options.filter(option => option.value !== 'Ventures') } : filter)
  }
  return BASE_FILTERS.map(filter => filter.key === 'ventureTag'
    ? { ...filter, options: tags.map(tag => ({ value: tag.name, label: tag.name })) }
    : filter)
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

/** True on phone widths, so the bar can drop text a phone has no room to read. */
function useNarrow() {
  const query = '(max-width: 720px)'
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && Boolean(window.matchMedia?.(query).matches))
  useEffect(() => {
    const media = window.matchMedia?.(query)
    if (!media) return
    const update = () => setNarrow(media.matches)
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])
  return narrow
}

export default function TodoToolbar({ query, sort, groupBySource, bulkMode, selectedCount, onQuery, onSort, onGroupBySource, onBulkMode, onBulk }: Props) {
  const FILTERS = filtersFor(useVentureTags())
  const [tag, setTag] = useState('')
  const [panel, setPanel] = useState<'filters' | 'sort' | null>(null)
  const narrow = useNarrow()
  const toolbar = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!panel) return
    function keydown(event: KeyboardEvent) { if (event.key === 'Escape') setPanel(null) }
    function pointerdown(event: PointerEvent) {
      if (!toolbar.current?.contains(event.target as Node)) setPanel(null)
    }
    document.addEventListener('keydown', keydown)
    document.addEventListener('pointerdown', pointerdown)
    return () => { document.removeEventListener('keydown', keydown); document.removeEventListener('pointerdown', pointerdown) }
  }, [panel])

  // Priority is the one filter the query holds as a number; everything else is the
  // option value as typed, so the panel and the chips can treat all five as strings.
  const valueOf = (key: FilterKey) => {
    const raw = query[key]
    return raw === null || raw === undefined ? '' : String(raw)
  }
  const set = (key: FilterKey, value: string) =>
    onQuery({ ...query, [key]: key === 'priority' ? (value ? Number(value) : null) : value })
  const active = FILTERS.filter(filter => valueOf(filter.key))
  const clearAll = () => onQuery(
    FILTERS.reduce((next, filter) => ({ ...next, [filter.key]: filter.key === 'priority' ? null : '' }), { ...query }),
  )

  const manual = sort[0] === 'manual'
  const availableSorts = SORT_OPTIONS.filter(option => !sort.includes(option.value))
  const sortSummary = manual
    ? 'Manual order'
    : sort.map(criterion => SORT_OPTIONS.find(option => option.value === criterion)?.label ?? criterion).join(' → ')
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

  const toggle = (next: 'filters' | 'sort') => setPanel(current => current === next ? null : next)

  return (
    <div className="todo-toolbar" ref={toolbar}>
      <div className="todo-toolbar-row">
        <label className="todo-search">
          <Hi icon={MagnifyingGlassIcon} size={15} />
          <span className="sr-only">Search tasks</span>
          <input aria-label="Search tasks" value={query.search || ''} onChange={event => onQuery({ ...query, search: event.target.value })} placeholder={narrow ? 'Search tasks' : 'Search tasks or GitHub references'} />
          {query.search && <button type="button" className="todo-search-clear" aria-label="Clear search" onClick={() => onQuery({ ...query, search: '' })}><Hi icon={XMarkIcon} size={14} /></button>}
        </label>

        <div className="todo-popover-anchor">
          <button type="button" className={`todo-tool-btn ${active.length ? 'on' : ''}`} aria-haspopup="dialog" aria-expanded={panel === 'filters'} onClick={() => toggle('filters')}>
            <Hi icon={AdjustmentsHorizontalIcon} size={15} />
            <span className="todo-tool-label">Filter</span>
            {active.length > 0 && <span className="todo-tool-count">{active.length}</span>}
            <Hi icon={ChevronDownIcon} size={13} className="todo-tool-caret" />
          </button>
          {panel === 'filters' && (
            <div className="todo-popover" role="dialog" aria-label="Filter and group tasks">
              {FILTERS.map(filter => (
                <label className="todo-popover-field" key={filter.key}>
                  <span>{filter.label}</span>
                  <select aria-label={filter.label} value={valueOf(filter.key)} onChange={event => set(filter.key, event.target.value)}>
                    <option value="">{filter.all}</option>
                    {filter.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
              ))}
              <label className="todo-popover-toggle">
                <input type="checkbox" checked={groupBySource} onChange={event => onGroupBySource(event.target.checked)} />
                <Hi icon={ViewColumnsIcon} size={15} />
                <span>Group by source</span>
              </label>
              <div className="todo-popover-foot">
                <button type="button" disabled={!active.length} onClick={clearAll}>Clear filters</button>
              </div>
            </div>
          )}
        </div>

        <div className="todo-popover-anchor">
          <button type="button" className={`todo-tool-btn ${manual ? '' : 'on'}`} aria-haspopup="dialog" aria-expanded={panel === 'sort'} onClick={() => toggle('sort')}>
            <Hi icon={BarsArrowDownIcon} size={15} />
            <span className="todo-tool-label todo-tool-value">{sortSummary}</span>
            <Hi icon={ChevronDownIcon} size={13} className="todo-tool-caret" />
          </button>
          {panel === 'sort' && (
            <div className="todo-popover" role="dialog" aria-label="Sort tasks">
              <div className="todo-sort-stack">
                {sort.map((criterion, index) => (
                  <div className="todo-sort-criterion" key={`${criterion}-${index}`}>
                    <span aria-hidden="true">{index === 0 ? 'Sort by' : 'then'}</span>
                    <select aria-label={index === 0 ? 'Sort tasks by' : `Then sort tasks by ${index + 1}`} value={criterion} onChange={event => setCriterion(index, event.target.value as TodoSort)}>
                      {index === 0 && <option value="manual">Manual order</option>}
                      {SORT_OPTIONS.map(option => <option key={option.value} value={option.value} disabled={sort.includes(option.value) && option.value !== criterion}>{option.label}</option>)}
                    </select>
                    {index > 0 && <button type="button" onClick={() => removeCriterion(index)} aria-label={`Remove ${SORT_OPTIONS.find(option => option.value === criterion)?.label ?? criterion} sort`}><Hi icon={XMarkIcon} size={13} /></button>}
                  </div>
                ))}
              </div>
              {!manual && availableSorts.length > 0 && <button type="button" className="todo-sort-add" onClick={() => onSort([...sort, availableSorts[0].value])}><Hi icon={PlusIcon} size={13} /> Then by</button>}
              <p className="todo-popover-hint">Manual order keeps the positions you drag cards into. Any other order is a view — it never moves a card.</p>
            </div>
          )}
        </div>

        <button type="button" className={`todo-tool-btn ${bulkMode ? 'on' : ''}`} aria-pressed={bulkMode} onClick={() => onBulkMode(!bulkMode)}>
          <Hi icon={CheckCircleIcon} size={15} /><span className="todo-tool-label">Select</span>
        </button>
      </div>

      {active.length > 0 && (
        <div className="todo-filter-chips" aria-label="Active filters">
          {active.map(filter => (
            <button type="button" key={filter.key} className="todo-filter-chip" aria-label={`Clear ${filter.label} filter`} onClick={() => set(filter.key, '')}>
              <span className="todo-chip-label">{filter.label}</span>
              {filter.options.find(option => option.value === valueOf(filter.key))?.label ?? valueOf(filter.key)}
              <Hi icon={XMarkIcon} size={12} />
            </button>
          ))}
          <button type="button" className="todo-filter-clear" onClick={clearAll}>Clear all</button>
        </div>
      )}

      {bulkMode && (
        <div className="todo-bulk-actions" aria-label="Bulk actions">
          <span className="todo-bulk-count">{selectedCount.toLocaleString()} selected</span>
          <button disabled={!selectedCount} onClick={() => onBulk('complete')}>Mark done</button>
          <button disabled={!selectedCount} onClick={() => onBulk('priority', 4)}>Set P1</button>
          <button disabled={!selectedCount} onClick={() => onBulk('archive')}>Archive done</button>
          <span className="todo-bulk-tag">
            <input aria-label="Bulk tag" value={tag} onChange={event => setTag(event.target.value)} placeholder="Tag" />
            <button disabled={!selectedCount || !tag.trim()} onClick={() => onBulk('addTag', tag.trim())}>Add</button>
            <button disabled={!selectedCount || !tag.trim()} onClick={() => onBulk('removeTag', tag.trim())}>Remove</button>
          </span>
          <button className="danger" disabled={!selectedCount} onClick={() => onBulk('delete')}>Delete</button>
          <button className="todo-bulk-done" onClick={() => onBulkMode(false)}>Done</button>
        </div>
      )}
    </div>
  )
}
