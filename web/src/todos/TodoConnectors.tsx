import React, { useEffect, useState } from 'react'
import {
  getGithubTodoConnector, getSheetTodoConnector, linkGithubTodoIssue,
  refreshGithubTodoConnector, refreshSheetTodoConnector, searchGithubTodoIssues,
  updateGithubTodoSettings, type GithubTodoIssue,
} from '../api'
import { Hi, RadioIcon, TableCellsIcon, XMarkIcon } from '../icons'
import { siGithub } from 'simple-icons'

export type TodoTrackingSource = 'sheet' | 'github'

interface GithubSettings {
  trackAssigned: boolean
  watchedRepos: string[]
  watermark: string | null
}

interface Props {
  source: TodoTrackingSource
  githubHealth?: any
  sheetHealth?: any
  githubSettings?: GithubSettings
  onGithubSearch?: (query: string) => Promise<GithubTodoIssue[]>
  onGithubLink?: (id: string) => Promise<unknown> | unknown
  onSheetRefresh?: () => Promise<unknown>
  onViewSource?: (source: TodoTrackingSource) => void
  onClose?: () => void
  onChanged?: () => void
}

interface LauncherProps {
  source: TodoTrackingSource | null
  onSelect: (source: TodoTrackingSource | null) => void
}

/** GitHub's own mark, from simple-icons, drawn in the current text colour. */
function GithubGlyph({ size = 15 }: { size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true"><path d={siGithub.path} /></svg>
}

export function TodoTrackingLaunchers({ source, onSelect }: LauncherProps) {
  // Each launcher carries its source's own glyph rather than a shared radar dish:
  // on a phone the label is clipped away, and two identical icons would be a coin
  // flip over which panel opens.
  function launcher(target: TodoTrackingSource, label: string, ariaLabel: string, glyph: React.ReactNode) {
    const active = source === target
    return <button className={`btn compact todo-tracker-launcher${active ? ' active' : ''}`} aria-label={ariaLabel} aria-pressed={active} onClick={() => onSelect(active ? null : target)}>{glyph} <span className="todo-tracker-label">{label}</span></button>
  }
  return <div className="todo-tracking-launchers" aria-label="Todo source tracking">
    {launcher('sheet', 'Action Items', 'Track Action Items', <Hi icon={TableCellsIcon} size={15} />)}
    {launcher('github', 'GitHub', 'Track GitHub issues', <GithubGlyph />)}
  </div>
}

function relative(value?: string | null) {
  if (!value) return 'not yet'
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

export default function TodoConnectors({ source, githubHealth: suppliedGithub, sheetHealth: suppliedSheet, githubSettings: suppliedSettings, onGithubSearch, onGithubLink, onSheetRefresh, onViewSource, onClose, onChanged }: Props) {
  const [github, setGithub] = useState<any>(suppliedGithub)
  const [sheet, setSheet] = useState<any>(suppliedSheet)
  const [settings, setSettings] = useState<GithubSettings>(suppliedSettings ?? { trackAssigned: false, watchedRepos: [], watermark: null })
  const [query, setQuery] = useState('')
  const [repo, setRepo] = useState('')
  const [issues, setIssues] = useState<GithubTodoIssue[]>([])
  const [watchedRepos, setWatchedRepos] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [searched, setSearched] = useState(false)
  useEffect(() => {
    if (source === 'github') {
      if (suppliedSettings) setWatchedRepos(suppliedSettings.watchedRepos.join(', '))
      if (!suppliedGithub || !suppliedSettings) void getGithubTodoConnector().then(result => {
        if (!suppliedGithub) setGithub(result.health)
        if (!suppliedSettings) { setSettings(result.settings); setWatchedRepos(result.settings.watchedRepos.join(', ')) }
      }).catch(cause => setError(cause instanceof Error ? cause.message : 'GitHub tracking could not load.'))
    }
    if (source === 'sheet' && !suppliedSheet) void getSheetTodoConnector().then(result => setSheet(result.health)).catch(cause => setError(cause instanceof Error ? cause.message : 'Action Items tracking could not load.'))
  }, [source, suppliedGithub, suppliedSheet, suppliedSettings])
  async function run(name: string, action: () => Promise<void>) { setBusy(name); setError(''); try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Connector action failed.') } finally { setBusy('') } }
  async function search() { await run('search', async () => { setIssues(onGithubSearch ? await onGithubSearch(query) : (await searchGithubTodoIssues(query, repo)).issues); setSearched(true) }) }
  async function link(issue: GithubTodoIssue) { await run('link', async () => { await (onGithubLink ? onGithubLink(issue.id) : linkGithubTodoIssue(issue.id)); setIssues(current => current.filter(item => item.id !== issue.id)); onChanged?.() }) }
  const autoTracking = source === 'github'
    ? settings.trackAssigned || settings.watchedRepos.length > 0
    : Boolean(sheet && sheet.status !== 'unavailable' && sheet.status !== 'error')
  const loading = source === 'github' ? !github && !suppliedGithub : !sheet && !suppliedSheet
  const sourceLabel = source === 'github' ? 'GitHub issues' : 'Action Items'

  return <section className="todo-connectors" aria-label={`${sourceLabel} tracking`}>
    <header className="todo-tracker-head">
      <div className="todo-tracker-title"><Hi icon={RadioIcon} size={18} /><div><h2>{source === 'github' ? 'GitHub issue tracking' : 'Action Items tracking'}</h2><p>{source === 'github' ? 'Assigned issues and watched repositories' : 'shared Action Items sheet rows'}</p></div></div>
      <div className={`todo-tracker-state${autoTracking ? ' active' : ''}`}><span />{loading ? 'Checking tracking' : `Auto-tracking ${autoTracking ? 'on' : 'off'}`}</div>
      {onClose && <button className="icon-btn small" aria-label="Close tracking panel" onClick={onClose}><Hi icon={XMarkIcon} size={17} /></button>}
    </header>
    {error && <div className="todo-inline-error" role="alert">{error}</div>}
    {source === 'github' ? <div className="todo-tracker-body">
      <div className="todo-tracker-status"><span>Connector status</span><strong>{github?.status || 'checking'}</strong><span>Last synced {relative(github?.lastSuccessAt)}</span></div>
      <label className="checkbox-field"><input type="checkbox" checked={settings.trackAssigned} onChange={event => { const next = { ...settings, trackAssigned: event.target.checked }; setSettings(next); void run('github-settings', async () => { const result = await updateGithubTodoSettings({ trackAssigned: next.trackAssigned }); setSettings(current => ({ ...current, ...(result.settings as Partial<GithubSettings>) })) }) }} /> Auto-track new issues assigned to me</label>
      <div className="todo-inline-form"><input aria-label="Watched GitHub repositories" value={watchedRepos} onChange={event => setWatchedRepos(event.target.value)} placeholder="owner/repo, owner/another" /><button className="btn" onClick={() => void run('github-settings', async () => { const repos = watchedRepos.split(',').map(value => value.trim()).filter(Boolean); const result = await updateGithubTodoSettings({ watchedRepos: repos }); setSettings(current => ({ ...current, ...(result.settings as Partial<GithubSettings>), watchedRepos: repos })) })}>Save watched repos</button></div>
      <div className="todo-inline-form"><input aria-label="Search GitHub issues" value={query} onChange={event => setQuery(event.target.value)} placeholder="Issue number, title, or owner/repo#42" /><input aria-label="GitHub repository" value={repo} onChange={event => setRepo(event.target.value)} placeholder="owner/repo (optional)" /><button className="btn" onClick={() => void search()} disabled={busy === 'search'}>{busy === 'search' ? 'Searching…' : 'Search issues'}</button></div>
      {searched && issues.length === 0 && <p className="todo-tracker-empty">No matching untracked issues.</p>}
      {issues.map(issue => { const identifier = issue.identifier || (issue.repo && issue.number ? `${issue.repo}#${issue.number}` : issue.id); return <div className="todo-issue-result" key={issue.id}><span><strong>{issue.title}</strong><small>{identifier}</small></span><button className="btn" aria-label={`Link ${identifier}`} onClick={() => void link(issue)}>Link</button></div> })}
      <div className="todo-tracker-actions"><button className="btn" aria-label="View tracked GitHub issues" onClick={() => onViewSource?.('github')}>View tracked issues</button><button className="link-btn inline" onClick={() => void run('github-refresh', async () => { await refreshGithubTodoConnector(); setGithub((current: any) => ({ ...current, lastSuccessAt: new Date().toISOString(), status: 'ok' })); onChanged?.() })} disabled={busy === 'github-refresh'}>{busy === 'github-refresh' ? 'Pulling…' : 'Pull GitHub now'}</button></div>
    </div> : <div className="todo-tracker-body">
      <div className="todo-tracker-status"><span>Connector status</span><strong>{sheet?.status === 'unconfigured' && sheet?.missing?.length ? `needs ${sheet.missing.join(', ')}` : sheet?.status || 'checking'}</strong><span>Last synced {relative(sheet?.lastSuccessAt)}</span></div>
      {sheet?.status === 'unconfigured' && <p role="status">{sheet.lastError} {sheet.recovery}</p>}
      <p>New rows whose Who column is one of the configured assignees (TASK_SHEET_ASSIGNEES) are tracked automatically when tagged with one of your venture tags. Status remains Sheet-owned.</p>
      <div className="todo-tracker-actions"><button className="btn" aria-label="View tracked Action Items" onClick={() => onViewSource?.('sheet')}>View tracked Action Items</button><button className="btn" onClick={() => void run('sheet-refresh', async () => { if (onSheetRefresh) await onSheetRefresh(); else await refreshSheetTodoConnector(); setSheet((current: any) => ({ ...current, lastSuccessAt: new Date().toISOString(), status: 'healthy' })); onChanged?.() })} disabled={busy === 'sheet-refresh'}>{busy === 'sheet-refresh' ? 'Refreshing…' : 'Refresh Action Items'}</button></div>
    </div>}
  </section>
}
