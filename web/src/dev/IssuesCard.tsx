import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import IconCircleDot from '@tabler/icons-react/dist/esm/icons/IconCircleDot.mjs'
import IconCircleCheck from '@tabler/icons-react/dist/esm/icons/IconCircleCheck.mjs'
import IconCircleX from '@tabler/icons-react/dist/esm/icons/IconCircleX.mjs'
import { getDevIssues, AuthError, type DevIssue, type DevIssues, type DevIssueScope, type DevIssueState } from '../api'
import { relTime } from '../usageMeta'
import { readDevCache, writeDevCache } from '../devCache'
import { Hi, ArrowPathIcon, ChatBubbleLeftIcon, MagnifyingGlassIcon, XMarkIcon, WarnIcon } from '../icons'
import ChatAbout from '../chat/about/ChatAbout'
import { devIssueContext } from '../chat/about/context'
import {
  NO_FILTERS, capNote, cardSurface, errorNotes, filterIssues, hasFilters, initials, labelLook, labelOptions, loginHue,
  repoMarks, repoOptions, rowDetails, rowName, shortAgo, stateText, summary, warningNote, type IssueFilters,
} from './issues'
import './issues.css'

// The Dev tab's Issues: GitHub issues (not PRs) in the watched repos and the ones
// assigned to the server's gh login, newest-updated first. State and scope are
// asked of the bridge (each its own cached read); repo, label and search filter
// what is already here. The title opens the issue on GitHub; right-click, long
// press or the menu key on a row starts a chat about it. docs/dev-tab.md → Issues.

const STATES: { id: DevIssueState; label: string }[] = [
  { id: 'open', label: 'Open' }, { id: 'closed', label: 'Closed' }, { id: 'all', label: 'All' },
]
const SCOPES: { id: DevIssueScope; label: string; title: string }[] = [
  { id: 'mine', label: 'Mine', title: 'Assigned to the server’s gh login, in any repo' },
  { id: 'watched', label: 'Watched', title: 'Every issue in the repos watched below' },
  { id: 'all', label: 'All', title: 'Both' },
]
const PAGE = 50
const SHOWN_LABELS = 3
// A big list is not kept for paint: localStorage is small and shared.
const CACHE_MAX_ISSUES = 500
const tablerStroke = { strokeWidth: 1.75 }

const cacheKey = (state: DevIssueState, scope: DevIssueScope) => `issues:${state}:${scope}`
const viewKey = 'issuesView'
type SavedView = { state: DevIssueState; scope: DevIssueScope }

/** Ask the bridge again: `n` changes on each ask; `refresh` re-reads GitHub. */
export interface IssuesReload { n: number; refresh: boolean }

/** The card's surface colour, read again when Settings › Appearance repaints <html>. */
function useCardSurface(): string {
  const [surface, setSurface] = useState(() => cardSurface())
  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setSurface(cardSurface()))
    observer.observe(root, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
    return () => observer.disconnect()
  }, [])
  return surface
}

export default function IssuesCard({ onAuthError, reload }: { onAuthError: () => void; reload?: IssuesReload }) {
  const [state, setState] = useState<DevIssueState>(() => readDevCache<SavedView>(viewKey)?.state || 'open')
  const [scope, setScope] = useState<DevIssueScope>(() => readDevCache<SavedView>(viewKey)?.scope || 'all')
  const [data, setData] = useState<DevIssues | null>(() => readDevCache<DevIssues>(cacheKey(state, scope)))
  const [filters, setFilters] = useState<IssueFilters>(NO_FILTERS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(PAGE)
  const search = useRef<HTMLInputElement>(null)
  const asked = useRef(0)
  const surface = useCardSurface()
  // A parent's new callback is not a reason to ask GitHub again.
  const authError = useRef(onAuthError)
  authError.current = onAuthError

  const load = useCallback(async (refresh = false) => {
    const ticket = ++asked.current
    setLoading(true)
    setError(null)
    try {
      const res = await getDevIssues(state, scope, refresh)
      if (ticket !== asked.current) return
      setData(res)
      if (res.issues.length <= CACHE_MAX_ISSUES) writeDevCache(cacheKey(state, scope), res)
    } catch (e: any) {
      if (ticket !== asked.current) return
      if (e instanceof AuthError) authError.current(); else setError(e.message)
    } finally {
      if (ticket === asked.current) setLoading(false)
    }
  }, [state, scope])

  useEffect(() => {
    // Another view paints its own last answer, or nothing, while the bridge is
    // asked; never the previous view's rows under the new view's name.
    setData(readDevCache<DevIssues>(cacheKey(state, scope)))
    writeDevCache(viewKey, { state, scope })
    setShown(PAGE)
    load()
  }, [state, scope, load])

  // The page's Refresh, or a repo watched or unwatched.
  const lastReload = useRef(reload?.n)
  useEffect(() => {
    if (!reload || reload.n === lastReload.current) return
    lastReload.current = reload.n
    load(reload.refresh)
  }, [reload, load])

  // Only an answer to the view on screen is drawn.
  const current = data && data.state === state && data.scope === scope ? data : null
  const issues = current?.issues || []
  const visible = useMemo(() => filterIssues(issues, filters), [issues, filters])
  const repos = useMemo(() => repoOptions(issues, current?.repos), [issues, current?.repos])
  const labels = useMemo(() => labelOptions(filters.repo ? filterIssues(issues, { ...NO_FILTERS, repo: filters.repo }) : issues), [issues, filters.repo])
  const marks = useMemo(() => repoMarks(repos.map((r) => r.value)), [repos])
  const filtered = hasFilters(filters)
  const set = useCallback((patch: Partial<IssueFilters>) => { setFilters((f) => ({ ...f, ...patch })); setShown(PAGE) }, [])
  const pickLabel = useCallback((label: string) => set({ label }), [set])
  const notes = errorNotes(current?.errors || [])

  // One tab stop for the whole list: the active row. ↑/↓, Home and End move
  // between rows; Tab goes on to that row's labels, then out of the list.
  const list = useRef<HTMLUListElement>(null)
  const [active, setActive] = useState(0)
  const rendered = Math.min(shown, visible.length)
  const activeRow = Math.min(active, Math.max(0, rendered - 1))
  const onListFocus = (e: React.FocusEvent) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('li.dev-issue')
    if (row?.dataset.index) setActive(Number(row.dataset.index))
  }
  const onListKey = (e: React.KeyboardEvent) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('li.dev-issue')
    if (!row || !list.current) return
    const at = Number(row.dataset.index)
    const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rendered - 1 : null
    if (to == null) return
    e.preventDefault()
    list.current.querySelectorAll<HTMLElement>('li.dev-issue')[Math.max(0, Math.min(rendered - 1, to))]?.focus()
  }

  // `/` jumps to the search box, as on GitHub, unless something else has the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      if (!search.current?.offsetParent) return
      e.preventDefault()
      search.current.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const off = current && !current.enabled
  const fetched = current?.fetchedAt ? relTime(new Date(current.fetchedAt).getTime()) : null
  const missingOption = (value: string, options: { value: string }[]) =>
    value && !options.some((o) => o.value.toLowerCase() === value.toLowerCase()) ? <option value={value}>{value} (0)</option> : null

  return (
    <section className="card dev-card dev-issues">
      <div className="dev-card-head">
        <div>
          <h2 style={{ margin: 0 }}>Issues</h2>
          <div className="muted shipped-sub">
            {current?.enabled
              ? <>{summary(issues, state, current.login)}{fetched && <> · checked {fetched}</>}</>
              : 'GitHub issues in your watched repos and assigned to you'}
          </div>
        </div>
        <span className="dev-card-actions">
          <span className="cal-viewswitch" role="group" aria-label="Issue state">
            {STATES.map((s) => (
              <button key={s.id} type="button" className={`seg${s.id === state ? ' active' : ''}`} aria-pressed={s.id === state} onClick={() => setState(s.id)}>{s.label}</button>
            ))}
          </span>
          <span className="cal-viewswitch" role="group" aria-label="Whose issues">
            {SCOPES.map((s) => (
              <button key={s.id} type="button" className={`seg${s.id === scope ? ' active' : ''}`} aria-pressed={s.id === scope} title={s.title} onClick={() => setScope(s.id)}>{s.label}</button>
            ))}
          </span>
          <button type="button" className="btn compact" onClick={() => load(true)} disabled={loading}
            title={fetched ? `Fetched ${fetched}. GitHub is asked again at most once a minute.` : undefined}>
            <Hi icon={ArrowPathIcon} size={13} className={loading ? 'spin' : ''} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </span>
      </div>

      {!off && (
        <div className="dev-issues-tools">
          <label className="gh-search dev-issues-search">
            <Hi icon={MagnifyingGlassIcon} size={15} />
            <input
              ref={search}
              type="search"
              placeholder="Search title, label, person, #number…"
              value={filters.search}
              onChange={(e) => set({ search: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Escape' && filters.search) { e.stopPropagation(); set({ search: '' }) } }}
              aria-label="Search issues"
            />
            <kbd className="dev-issues-kbd" aria-hidden="true">/</kbd>
          </label>
          <select className="model-select" value={filters.repo} onChange={(e) => set({ repo: e.target.value, label: '' })} aria-label="Repository">
            <option value="">All repos</option>
            {missingOption(filters.repo, repos)}
            {repos.map((r) => <option key={r.value} value={r.value}>{r.value} ({r.count})</option>)}
          </select>
          <select className="model-select" value={filters.label} onChange={(e) => set({ label: e.target.value })} aria-label="Label" disabled={!labels.length && !filters.label}>
            <option value="">{labels.length ? 'Any label' : 'No labels'}</option>
            {missingOption(filters.label, labels)}
            {labels.map((l) => <option key={l.value} value={l.value}>{l.value} ({l.count})</option>)}
          </select>
          {filtered && (
            <button type="button" className="btn compact" onClick={() => set(NO_FILTERS)}>
              <Hi icon={XMarkIcon} size={13} /> Clear
            </button>
          )}
        </div>
      )}

      {error && <div className="muted inline-warn dev-issues-warn" role="alert"><WarnIcon /> {current ? `Could not refresh: ${error}` : error}</div>}
      {notes.unread && <div className="muted inline-warn dev-issues-warn"><WarnIcon /> {notes.unread}</div>}
      {notes.stale && <div className="muted inline-warn dev-issues-warn"><WarnIcon /> {notes.stale}</div>}
      {current?.warnings?.map((w) => <div key={w.source} className="muted inline-warn dev-issues-warn"><WarnIcon /> {warningNote(w)}</div>)}

      {off ? (
        <div className="dev-issues-empty">
          <p>{current.reason}</p>
        </div>
      ) : !current ? (
        error ? null : <div className="spinner">Asking GitHub…</div>
      ) : visible.length === 0 ? (
        <div className="dev-issues-empty">
          {filtered ? (
            <>
              <p>No issues match these filters.</p>
              <button type="button" className="btn compact" onClick={() => set(NO_FILTERS)}>Clear filters</button>
            </>
          ) : notes.unread ? (
            <p>Nothing to show until GitHub answers.</p>
          ) : (
            <p>{emptyText(state, scope, current.repos.length)}</p>
          )}
        </div>
      ) : (
        <>
          {filtered && <div className="muted dev-issues-count">{visible.length} of {issues.length}</div>}
          <ul className="dev-issues-list" ref={list} onFocus={onListFocus} onKeyDown={onListKey} aria-label="Issues">
            {visible.slice(0, shown).map((i, n) => (
              <IssueRow key={`${i.repo}#${i.number}`} issue={i} index={n} active={n === activeRow} mark={marks.get(i.repo) || i.repo}
                me={current.login} surface={surface} onLabel={pickLabel} />
            ))}
          </ul>
          {visible.length > shown && (
            <button type="button" className="btn compact dev-issues-more" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, visible.length - shown)} more of {visible.length - shown}
            </button>
          )}
        </>
      )}
      {current?.capped?.map((c) => <div key={c.source} className="muted dev-issues-note">{capNote(c, state)}</div>)}
    </section>
  )
}

function emptyText(state: DevIssueState, scope: DevIssueScope, watched: number): string {
  const what = state === 'all' ? 'issues' : `${state} issues`
  if (scope === 'watched' && !watched) return 'No repos are watched yet. Pick some from All repositories below.'
  if (scope === 'mine') return `No ${what} assigned to you.`
  if (scope === 'watched') return `No ${what} in the watched repos.`
  return `No ${what} in the watched repos or assigned to you.`
}

function StateIcon({ issue }: { issue: DevIssue }) {
  const label = stateText(issue)
  const props = { size: 16, ...tablerStroke, role: 'img', 'aria-label': label[0].toUpperCase() + label.slice(1) }
  if (issue.state === 'open') return <IconCircleDot {...props} className="dev-issue-state open" />
  if (issue.stateReason === 'not_planned') return <IconCircleX {...props} className="dev-issue-state not-planned" />
  return <IconCircleCheck {...props} className="dev-issue-state closed" />
}

const IssueRow = React.memo(function IssueRow({ issue: i, index, active, mark, me, surface, onLabel }: {
  issue: DevIssue
  index: number
  /** The list's one tab stop. */
  active: boolean
  mark: string
  me: string | null
  surface: string
  onLabel: (label: string) => void
}) {
  const link = useRef<HTMLAnchorElement>(null)
  const details = useId()
  const updated = new Date(i.updatedAt)
  const shownLabels = i.labels.slice(0, SHOWN_LABELS)
  const moreLabels = i.labels.slice(SHOWN_LABELS)
  // The row takes focus so the keyboard can reach Chat about this (menu key,
  // Shift+F10); Enter on it opens the issue, as the title link does. Its name
  // is short; the rest of what it shows is its description.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); link.current?.click() }
  }
  return (
    <li className="dev-issue" data-index={index} tabIndex={active ? 0 : -1} aria-label={rowName(i)} aria-describedby={details} onKeyDown={onKey}>
      <ChatAbout of={() => devIssueContext(i)} host=".dev-issue" />
      <span id={details} className="sr-only">{rowDetails(i, me)}</span>
      <StateIcon issue={i} />
      <span className="dev-issue-main">
        <span className="dev-issue-repo" title={i.repo}>{mark}</span>
        <span className="dev-issue-num">#{i.number}</span>
        <a ref={link} className="dev-issue-title" href={i.url} target="_blank" rel="noreferrer" tabIndex={-1} title={`Open ${i.repo}#${i.number} on GitHub`}>{i.title}</a>
      </span>
      {i.labels.length > 0 && (
        <span className="dev-issue-labels">
          {shownLabels.map((l) => (
            <button key={l.name} type="button" className="dev-label" tabIndex={active ? 0 : -1} style={labelLook(l.color, surface) || undefined}
              onClick={() => onLabel(l.name)} title={`Show only “${l.name}”`}>{l.name}</button>
          ))}
          {moreLabels.length > 0 && (
            <span className="dev-label dev-label-more" title={moreLabels.map((l) => l.name).join(', ')}>+{moreLabels.length}</span>
          )}
        </span>
      )}
      <span className="dev-issue-meta">
        {i.assignees.length > 0 && (
          <span className="dev-avatars" title={`Assigned to ${i.assignees.join(', ')}`}>
            {i.assignees.slice(0, 3).map((a) => (
              <span key={a} className={`dev-avatar${me && a.toLowerCase() === me.toLowerCase() ? ' me' : ''}`}
                style={{ ['--avatar-hue' as string]: loginHue(a) } as React.CSSProperties}>{initials(a)}</span>
            ))}
            {i.assignees.length > 3 && <span className="dev-avatar more">+{i.assignees.length - 3}</span>}
          </span>
        )}
        <span className={`dev-issue-comments${i.comments ? '' : ' none'}`} title={`${i.comments} comment${i.comments === 1 ? '' : 's'}`}>
          <Hi icon={ChatBubbleLeftIcon} size={13} />{i.comments || ''}
        </span>
        <time className="dev-issue-time" dateTime={i.updatedAt} title={`Updated ${updated.toLocaleString()}`}>{shortAgo(i.updatedAt)}</time>
      </span>
    </li>
  )
})
