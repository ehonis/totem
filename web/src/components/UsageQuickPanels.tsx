import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { COMMANDS } from '../shortcuts'
import { useCommand } from '../useShortcuts'
import { type QuickPanelId } from '../quickPanels'
import {
  getAiUsage,
  getAssistantUsage,
  getGithubRepos,
  getProductivity,
  getUsage,
  AuthError,
} from '../api'
import { useAiUsageLive } from '../useAiUsageLive'
import type { NavTarget } from '../router'
import {
  ACTIVITY_META,
  ACTIVITY_ORDER,
  CHANNEL_META,
  CHANNEL_ORDER,
  ComboActivityChart,
  fmtInt,
  fmtUsd,
  ProductIcon,
  relTime,
  UsageChip,
} from '../usageMeta'
import { QuotaMeter } from './AiUsagePanel'
import {
  Hi,
  ArrowPathIcon,
  BoltIcon,
  BellAlertIcon,
  ChartBarIcon,
  ChevronRightIcon,
  CommandLineIcon,
  FolderIcon,
  MagnifyingGlassIcon,
  MinusIcon,
  SquaresPlusIcon,
  WarnIcon,
} from '../icons'

const USAGE_SECTION = { tab: 'settings', sub: 'providers', hash: 'usage' }

interface UsageQuickPanelsProps {
  onNavigate: (target: NavTarget) => void
  onAuthError: () => void
  terminalAvailable?: boolean
  terminalOpen?: boolean
  onToggleTerminal: () => void
  unreadNotifications?: number
  onOpenNotifications?: () => void
}

function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="insight-skeleton" aria-label="Loading usage data">
      {Array.from({ length: rows }, (_, i) => (
        <div className="insight-skeleton-row" key={i}>
          <span />
          <span />
        </div>
      ))}
    </div>
  )
}

export default function UsageQuickPanels({
  onNavigate,
  onAuthError,
  terminalAvailable = false,
  terminalOpen = false,
  onToggleTerminal,
  unreadNotifications = 0,
  onOpenNotifications,
}: UsageQuickPanelsProps) {
  const [open, setOpen] = useState<QuickPanelId | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [limits, setLimits] = useState<any>(null)
  const [activity, setActivity] = useState<any>(null)
  const [repositories, setRepositories] = useState<any>(null)
  const [repoQuery, setRepoQuery] = useState('')
  const [errors, setErrors] = useState<Record<QuickPanelId, string | null>>({ limits: null, activity: null, repositories: null })
  const [busy, setBusy] = useState<QuickPanelId | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const repoSearchRef = useRef<HTMLInputElement>(null)
  // Live quota while this drawer is open — the stream is what makes the bars
  // move after a chat turn, instead of a 30s snapshot re-read.
  const { data: liveAi } = useAiUsageLive({ onAuthError, enabled: open === 'limits' })

  const fail = useCallback((panel: QuickPanelId, e: any) => {
    if (e instanceof AuthError) {
      onAuthError()
      return
    }
    setErrors((prev) => ({ ...prev, [panel]: e?.message || String(e) }))
  }, [onAuthError])

  const loadLimits = useCallback(async (refresh = false) => {
    setBusy('limits')
    try {
      // Monthly spend still comes from /api/usage. Live quota arrives on the
      // stream; a refresh=true here is the force-credential-refresh button.
      const [ai, usage] = await Promise.all([
        refresh ? getAiUsage(true) : Promise.resolve(null),
        getUsage().catch(() => null),
      ])
      setLimits((current: any) => ({ ai: ai || current?.ai || null, usage }))
      setErrors((prev) => ({ ...prev, limits: null }))
    } catch (e) {
      fail('limits', e)
    } finally {
      setBusy((current) => current === 'limits' ? null : current)
    }
  }, [fail])

  const loadActivity = useCallback(async () => {
    setBusy('activity')
    try {
      const [assistant, productivity] = await Promise.all([getAssistantUsage(), getProductivity()])
      setActivity({ assistant, productivity })
      setErrors((prev) => ({ ...prev, activity: null }))
    } catch (e) {
      fail('activity', e)
    } finally {
      setBusy((current) => current === 'activity' ? null : current)
    }
  }, [fail])

  const loadRepositories = useCallback(async (refresh = false) => {
    setBusy('repositories')
    try {
      setRepositories(await getGithubRepos(refresh))
      setErrors((prev) => ({ ...prev, repositories: null }))
    } catch (e) {
      fail('repositories', e)
    } finally {
      setBusy((current) => current === 'repositories' ? null : current)
    }
  }, [fail])

  useEffect(() => {
    if (open === 'limits') void loadLimits()
  }, [open, loadLimits])

  useEffect(() => {
    if (open === 'activity' && !activity && !errors.activity && busy !== 'activity') loadActivity()
    if (open === 'repositories' && !repositories && !errors.repositories && busy !== 'repositories') loadRepositories()
  }, [open, activity, repositories, errors, busy, loadActivity, loadRepositories])

  useEffect(() => {
    if (open !== 'limits' || !liveAi) return
    setLimits((current: any) => ({ ai: liveAi, usage: current?.usage || null }))
    setErrors((prev) => ({ ...prev, limits: null }))
  }, [open, liveAi])

  // Repository mode is intentionally keyboard-first. Opening it focuses and
  // selects the current query so the next keystroke replaces it immediately.
  useEffect(() => {
    if (open !== 'repositories') return
    const timer = window.setTimeout(() => {
      const input = repoSearchRef.current
      input?.focus({ preventScroll: true })
      input?.setSelectionRange(0, input.value.length)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [menuOpen])

  useEffect(() => {
    if (!open && !menuOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (menuOpen) setMenuOpen(false)
      else setOpen(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, menuOpen])

  const monthly = useMemo(() => limits?.usage ? (
    (limits.usage.services || [])
      .filter((service: any) => !service.error)
      .reduce((sum: number, service: any) => sum + (service.priceUsd || 0), 0)
  ) : null, [limits])

  const ai = activity?.assistant
  const prod = activity?.productivity
  const aiChannels = ai
    ? CHANNEL_ORDER.map((id) => [id, ai.byChannel?.[id] || 0] as const).filter(([, count]) => count > 0)
    : []
  const prodKinds = prod
    ? ACTIVITY_ORDER.map((id) => [id, prod.byKind?.[id] || 0] as const).filter(([, count]) => count > 0)
    : []
  const hasActivity = Boolean((ai?.total || 0) + (prod?.total || 0))

  const allRepos = repositories?.repos || []
  const repoResults = useMemo(() => {
    const query = repoQuery.trim().toLowerCase()
    if (!query) return { total: allRepos.length, shown: allRepos.slice(0, 5) }
    const matches = allRepos.filter((repo: any) => (
      repo.fullName?.toLowerCase().includes(query) ||
      repo.language?.toLowerCase().includes(query) ||
      repo.description?.toLowerCase().includes(query)
    ))
    return { total: matches.length, shown: matches.slice(0, 10) }
  }, [allRepos, repoQuery])

  const selectPanel = (panel: QuickPanelId) => {
    setMenuOpen(false)
    setOpen(panel)
  }
  const toggleMenu = () => {
    if (menuOpen) return setMenuOpen(false)
    setOpen(null)
    setMenuOpen(true)
  }
  const selectTerminal = () => {
    setMenuOpen(false)
    setOpen(null)
    if (!terminalOpen) onToggleTerminal()
  }
  const goToUsage = () => {
    setOpen(null)
    onNavigate(USAGE_SECTION)
  }

  useCommand(COMMANDS.quickLimits, () => selectPanel('limits'))
  useCommand(COMMANDS.quickActivity, () => selectPanel('activity'))
  useCommand(COMMANDS.quickRepositories, () => selectPanel('repositories'))

  return (
    <>
      <div className="action-launcher" ref={menuRef}>
        <button
          type="button"
          className={`action-fab${menuOpen || open || terminalOpen ? ' active' : ''}`}
          onClick={toggleMenu}
          title="Open utilities"
          aria-label="Open utilities"
          aria-expanded={menuOpen}
          aria-controls="action-menu"
        >
          <Hi icon={SquaresPlusIcon} size={20} />
          {/* The dot, not the number: "is there anything new" is the whole
              question, and a count on a 40px button is unreadable anyway. */}
          {unreadNotifications > 0 && <span className="fab-dot" aria-hidden />}
        </button>
        {menuOpen && (
          <div id="action-menu" className="action-menu" role="menu" aria-label="Utilities">
            {onOpenNotifications && (
              <button
                type="button"
                role="menuitem"
                onClick={() => { setMenuOpen(false); onOpenNotifications() }}
              >
                <Hi icon={BellAlertIcon} size={17} /><span>Notifications</span>
                {unreadNotifications > 0 && <kbd>{unreadNotifications}</kbd>}
              </button>
            )}
            <button type="button" role="menuitem" onClick={() => selectPanel('limits')}>
              <Hi icon={BoltIcon} size={17} /><span>AI usage limits</span>
            </button>
            <button type="button" role="menuitem" onClick={() => selectPanel('activity')}>
              <Hi icon={ChartBarIcon} size={17} /><span>Totem usage</span>
            </button>
            <button type="button" role="menuitem" onClick={() => selectPanel('repositories')}>
              <Hi icon={FolderIcon} size={17} /><span>Repositories</span>
            </button>
            {terminalAvailable && (
              <button type="button" role="menuitem" onClick={selectTerminal}>
                <Hi icon={CommandLineIcon} size={17} /><span>Terminal</span><kbd>Ctrl+`</kbd>
              </button>
            )}
          </div>
        )}
      </div>

      {open && (
        <section
          id={`usage-quick-${open}`}
          className="insight-panel"
          aria-label={open === 'limits' ? 'AI usage limits' : open === 'activity' ? 'AI usage and productivity' : 'Repositories'}
        >
          <header className="insight-panel-head">
            <div className="insight-panel-title">
              <Hi icon={open === 'limits' ? BoltIcon : open === 'activity' ? ChartBarIcon : FolderIcon} size={17} />
              <span>{open === 'limits' ? 'AI usage limits' : open === 'activity' ? 'AI usage and productivity' : 'Repositories'}</span>
            </div>
            <div className="insight-panel-actions">
              <button
                type="button"
                className="term-icon-btn"
                onClick={() => open === 'limits' ? loadLimits(true) : open === 'activity' ? loadActivity() : loadRepositories(true)}
                disabled={busy === open}
                title="Refresh"
                aria-label="Refresh usage data"
              >
                <Hi icon={ArrowPathIcon} size={16} className={busy === open ? 'spin' : ''} />
              </button>
              <button
                type="button"
                className="term-icon-btn"
                onClick={() => setOpen(null)}
                title="Minimize"
                aria-label="Minimize usage panel"
              >
                <Hi icon={MinusIcon} size={17} />
              </button>
            </div>
          </header>

          <div className="insight-panel-body">
            {errors[open] && !(open === 'limits' ? limits : open === 'activity' ? activity : repositories) ? (
              <div className="insight-error">
                <div className="inline-warn"><WarnIcon /> {errors[open]}</div>
                <button className="btn compact" onClick={() => open === 'limits' ? loadLimits(true) : open === 'activity' ? loadActivity() : loadRepositories(true)}>
                  Retry
                </button>
              </div>
            ) : open === 'limits' ? (
              !limits ? <PanelSkeleton />
                : !limits.ai?.ok ? (
                  <div className="insight-error">
                    <div className="inline-warn"><WarnIcon /> {limits.ai?.error || 'AI usage is unavailable.'}</div>
                    <button className="btn compact" onClick={() => loadLimits(true)}>Retry</button>
                  </div>
                ) : !(limits.ai.accounts || []).length ? (
                  <div className="ov-empty">No AI accounts discovered. Configure tracked accounts from Usage settings.</div>
                ) : (
                  <>
                    <div className="insight-summary">
                      <div><b>{(limits.ai.accounts || []).length}</b><small>accounts</small></div>
                      <div><b>{fmtUsd(monthly)}</b><small>per month</small></div>
                      <span>Updated {relTime(limits.ai.updatedAt) || 'just now'}</span>
                    </div>
                    <div className="ov-quota-list">
                      {(limits.ai.accounts || []).map((account: any) => {
                        const tightest = [...(account.meters || [])]
                          .filter((meter: any) => meter.remainingPct != null)
                          .sort((a: any, b: any) => a.remainingPct - b.remainingPct)[0]
                        return (
                          <div className="prov-block" key={account.id}>
                            <div className="prov-head">
                              <span className="usage-name">
                                <ProductIcon id={account.backend} title={account.backend} />
                                {account.displayName || account.label}
                              </span>
                              {account.plan && <span className="pill usage-plan">{account.plan}</span>}
                            </div>
                            {tightest
                              ? <QuotaMeter meter={tightest} compact />
                              : <div className="muted prov-note">{account.status === 'ok' ? 'No windows reported.' : account.error || account.status}</div>}
                          </div>
                        )
                      })}
                    </div>
                  </>
                )
            ) : open === 'activity' ? (
              !activity ? <PanelSkeleton rows={4} />
                : !hasActivity ? (
                  <div className="ov-empty">No activity logged yet. Chat with Totem or create or complete a todo, habit, or event to start the history.</div>
                ) : (
                  <>
                    <div className="ov-activity-stats insight-activity-stats">
                      <div className="ov-bignum up"><b>{fmtInt(ai?.today || 0)}</b><small>AI chats today</small></div>
                      <div className="ov-bignum up"><b>{fmtInt(ai?.total || 0)}</b><small>AI all-time</small></div>
                      <div className="ov-bignum down"><b>{fmtInt(prod?.today || 0)}</b><small>actions today</small></div>
                      <div className="ov-bignum down"><b>{fmtInt(prod?.completed || 0)}</b><small>completed</small></div>
                      <div className="ov-bignum down"><b>{fmtInt(prod?.created || 0)}</b><small>created</small></div>
                    </div>
                    <ComboActivityChart
                      height={180}
                      top={{ daily: ai?.daily, order: CHANNEL_ORDER, meta: CHANNEL_META, label: 'AI chat', unit: 'request' }}
                      bottom={{ daily: prod?.daily, order: ACTIVITY_ORDER, meta: ACTIVITY_META, label: 'Productivity', unit: 'action' }}
                    />
                    <div className="ov-activity-legend">
                      {aiChannels.length > 0 && (
                        <div className="chan-row">
                          <span className="usage-row-label">▲ AI chat</span>
                          {aiChannels.map(([id, count]) => (
                            <UsageChip key={id} sm color={CHANNEL_META[id]?.color} icon={CHANNEL_META[id]?.icon} label={CHANNEL_META[id]?.label || id} count={count} />
                          ))}
                        </div>
                      )}
                      {prodKinds.length > 0 && (
                        <div className="chan-row">
                          <span className="usage-row-label">▼ Productivity</span>
                          {prodKinds.map(([id, count]) => (
                            <UsageChip key={id} sm color={ACTIVITY_META[id]?.color} icon={ACTIVITY_META[id]?.icon} label={ACTIVITY_META[id]?.label || id} count={count} />
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )
            ) : (
              !repositories ? <PanelSkeleton rows={5} />
                : !allRepos.length ? (
                  <div className="ov-empty">No repositories found. Check the GitHub connection from the Code view.</div>
                ) : (
                  <>
                    <label className="repo-quick-search">
                      <Hi icon={MagnifyingGlassIcon} size={16} />
                      <input
                        ref={repoSearchRef}
                        type="search"
                        value={repoQuery}
                        onChange={(e) => setRepoQuery(e.target.value)}
                        placeholder="Search repositories"
                        aria-label="Search repositories"
                      />
                    </label>
                    <div className="repo-quick-caption">
                      {repoQuery.trim()
                        ? `${repoResults.total.toLocaleString()} matching ${allRepos.length.toLocaleString()} repositories`
                        : `5 most recently pushed of ${allRepos.length.toLocaleString()}`}
                    </div>
                    {!repoResults.shown.length ? (
                      <div className="ov-empty">No repositories match “{repoQuery}”. Try a name, owner, language, or description.</div>
                    ) : (
                      <div className="ov-repo-list repo-quick-list">
                        {repoResults.shown.map((repo: any) => (
                          <a className="ov-repo" key={repo.fullName} href={repo.url} target="_blank" rel="noreferrer">
                            <span className="ov-repo-main">
                              <span className="ov-repo-name"><span className="ov-repo-owner">{repo.owner}/</span>{repo.name}</span>
                              {repo.description && <span className="repo-quick-description">{repo.description}</span>}
                            </span>
                            <span className="repo-quick-meta">
                              {repo.language && <span className="ov-repo-lang">{repo.language}</span>}
                              <span>{relTime(new Date(repo.pushedAt).getTime())}</span>
                            </span>
                          </a>
                        ))}
                      </div>
                    )}
                  </>
                )
            )}
          </div>

          <footer className="insight-panel-foot">
            <button
              type="button"
              className="ov-card-link"
              onClick={open === 'repositories' ? () => { setOpen(null); onNavigate('code') } : goToUsage}
            >
              {open === 'repositories' ? 'Open Code' : 'Open full usage'} <Hi icon={ChevronRightIcon} size={13} />
            </button>
          </footer>
        </section>
      )}
    </>
  )
}
