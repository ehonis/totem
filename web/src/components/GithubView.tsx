import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { getGithubRepos, AuthError } from '../api'
import { relTime } from '../usageMeta'
import {
  Hi,
  MagnifyingGlassIcon,
  StarIcon,
  LockClosedIcon,
  ArchiveBoxIcon,
  ArrowPathIcon,
  CommandLineIcon,
  ExclamationCircleIcon,
  ArrowsRightLeftIcon,
  WarnIcon,
} from '../icons'

// GitHub's linguist colors for the languages that actually show up here, so the
// language dot matches what you'd see on github.com. Anything unlisted falls back
// to a neutral grey.
const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  PowerShell: '#012456',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Go: '#00ADD8',
  Rust: '#dea584',
  Java: '#b07219',
  Kotlin: '#A97BFF',
  Swift: '#F05138',
  'C++': '#f34b7d',
  C: '#555555',
  'C#': '#178600',
  Ruby: '#701516',
  PHP: '#4F5D95',
  Dart: '#00B4AB',
  Vue: '#41b883',
  Svelte: '#ff3e00',
  Dockerfile: '#384d54',
  Makefile: '#427819',
  Nix: '#7e7eff',
}

interface Repo {
  name: string
  fullName: string
  owner: string
  ownerType: string
  private: boolean
  fork: boolean
  archived: boolean
  language: string | null
  description: string | null
  pushedAt: string
  updatedAt: string
  url: string
  stars: number
  openIssues: number
  defaultBranch: string
}

interface GithubViewProps {
  onAuthError: () => void
  // Optional: seed the search box (e.g. from a deep link). Unused for now.
  initialQuery?: string
}

export default function GithubView({ onAuthError, initialQuery = '' }: GithubViewProps) {
  const [data, setData] = useState<{ viewer: any; repos: Repo[]; generatedAt?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState(initialQuery)
  const [owner, setOwner] = useState<string>('all')

  const auth = useCallback((e: unknown) => {
    if (e instanceof AuthError) { onAuthError(); return true }
    return false
  }, [onAuthError])

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true); else setLoading(true)
    setError(null)
    try {
      setData(await getGithubRepos(refresh))
    } catch (e: any) {
      if (!auth(e)) setError(e.message)
    } finally {
      setLoading(false); setRefreshing(false)
    }
  }, [auth])

  useEffect(() => { load() }, [load])

  const repos = data?.repos || []

  // Owner facets, most-repos first, so orgs you live in float to the top.
  const owners = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of repos) counts.set(r.owner, (counts.get(r.owner) || 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [repos])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return repos.filter((r) => {
      if (owner !== 'all' && r.owner !== owner) return false
      if (!q) return true
      return (
        r.fullName.toLowerCase().includes(q) ||
        (r.language || '').toLowerCase().includes(q) ||
        (r.description || '').toLowerCase().includes(q)
      )
    })
  }, [repos, query, owner])

  return (
    <div className="view gh-view">
      <div className="view-head">
        <div>
          <h1 style={{ marginBottom: 2 }}>Code</h1>
          <div className="muted" style={{ fontSize: 13 }}>
            {data
              ? `${repos.length} repositories across ${owners.length} owner${owners.length === 1 ? '' : 's'}`
              : 'Your repositories, across every org'}
          </div>
        </div>
        <button className="btn" onClick={() => load(true)} disabled={refreshing || loading}>
          <Hi icon={ArrowPathIcon} size={14} className={refreshing ? 'spin' : ''} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error ? (
        <div className="muted inline-warn"><WarnIcon /> {error}</div>
      ) : loading ? (
        <div className="spinner">Loading repositories…</div>
      ) : (
        <>
          <div className="gh-controls">
            <label className="gh-search">
              <Hi icon={MagnifyingGlassIcon} size={15} />
              <input
                type="text"
                placeholder="Filter by name, org, or language…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
            </label>
          </div>

          <div className="gh-owner-chips">
            <button className={`gh-chip ${owner === 'all' ? 'active' : ''}`} onClick={() => setOwner('all')}>
              All <span className="gh-chip-n">{repos.length}</span>
            </button>
            {owners.map(([name, n]) => (
              <button key={name} className={`gh-chip ${owner === name ? 'active' : ''}`} onClick={() => setOwner(name)}>
                {name} <span className="gh-chip-n">{n}</span>
              </button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <div className="empty">No repositories match “{query}”.</div>
          ) : (
            <div className="gh-list">
              {filtered.map((r) => (
                <div className="gh-repo" key={r.fullName}>
                  <div className="gh-repo-main">
                    <div className="gh-repo-title">
                      <a href={r.url} target="_blank" rel="noreferrer" className="gh-repo-name">
                        <span className="gh-owner">{r.owner}/</span><b>{r.name}</b>
                      </a>
                      {r.private && (
                        <span className="pill gh-badge"><Hi icon={LockClosedIcon} size={10} /> Private</span>
                      )}
                      {r.fork && <span className="pill gh-badge">Fork</span>}
                      {r.archived && (
                        <span className="pill gh-badge gh-badge-archived"><Hi icon={ArchiveBoxIcon} size={10} /> Archived</span>
                      )}
                    </div>
                    {r.description && <div className="gh-repo-desc">{r.description}</div>}
                    <div className="gh-repo-meta">
                      {r.language && (
                        <span className="gh-lang">
                          <span className="gh-lang-dot" style={{ background: LANG_COLORS[r.language] || '#8a91a3' }} />
                          {r.language}
                        </span>
                      )}
                      {r.stars > 0 && (
                        <span className="gh-meta-item"><Hi icon={StarIcon} size={12} /> {r.stars}</span>
                      )}
                      <span className="gh-meta-item">Updated {relTime(new Date(r.pushedAt).getTime())}</span>
                    </div>
                  </div>
                  <div className="gh-repo-links">
                    <a href={r.url} target="_blank" rel="noreferrer" className="gh-quick" title="Open code">
                      <Hi icon={CommandLineIcon} size={13} /> Code
                    </a>
                    <a href={`${r.url}/issues`} target="_blank" rel="noreferrer" className="gh-quick" title="Open issues">
                      <Hi icon={ExclamationCircleIcon} size={13} /> Issues
                    </a>
                    <a href={`${r.url}/pulls`} target="_blank" rel="noreferrer" className="gh-quick" title="Open pull requests">
                      <Hi icon={ArrowsRightLeftIcon} size={13} /> PRs
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
