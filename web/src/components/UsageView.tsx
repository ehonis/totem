import React, { useEffect, useState, useCallback, useRef } from 'react'
import { getUsage, getAssistantUsage, AuthError } from '../api'
import { useSettings } from '../settings'
import AiUsagePanel from './AiUsagePanel'
import AiUsageSettings from './AiUsageSettings'
import {
  fmtInt, fmtUsd, fmtTok, relTime,
  CHANNEL_ORDER, CHANNEL_META, PROVIDER_ORDER, PROVIDER_META,
  ProductIcon, Meter, ActivityChart,
} from '../usageMeta'
import {
  Hi,
  Cog6ToothIcon,
  SparklesIcon,
  WarnIcon,
} from '../icons'

function renewLabel(iso: any) {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d as any)) return null
  const days = Math.round((d as any - Date.now()) / 86400000)
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return days >= 0 ? `renews ${date} · ${days}d` : `renewed ${date}`
}

// `quotaElsewhere` = the live-quota panel above is drawing this service's rate
// limits, so the card drops its own (staler, single-profile) window meters and
// sticks to what that panel doesn't know: price, tokens, and local activity.
function ServiceCard({ s, quotaElsewhere }: { s: any; quotaElsewhere?: boolean }) {
  if (s.error) return <div className="usage-card"><div className="muted inline-warn"><WarnIcon /> {s.error}</div></div>
  const u = s.usage || {}
  const last = relTime(u.lastActivity)

  // Top models for Claude (by token volume).
  const claudeModels = u.byModel
    ? Object.entries(u.byModel)
        .map(([model, m]: [string, any]) => ({ model, ...m }))
        .sort((a, b) => (b.tokens || 0) - (a.tokens || 0))
        .slice(0, 3)
    : []
  return (
    <div className="usage-card">
      <div className="usage-card-head">
        <span className="usage-name"><ProductIcon id={s.id} title={s.name} />{s.name}</span>
        {s.plan && <span className="pill usage-plan">{s.plan}</span>}
      </div>

      <div className="usage-sub">
        <span>{s.priceUsd != null ? `${fmtUsd(s.priceUsd)}/mo` : 'price -'}</span>
        <span className="dotsep">·</span>
        <span>{renewLabel(s.renewsAt) || 'renewal -'}</span>
        {last && <><span className="dotsep">·</span><span>active {last}</span></>}
      </div>

      {/* Live quota windows - shown for any service that publishes them
          (Claude via its OAuth usage endpoint, Codex via its session log),
          unless the live-quota panel is already showing them per profile. */}
      {(!quotaElsewhere && u.windows?.length > 0) && (
        <div className="usage-meters">
          {u.windows.map((w: any) => <Meter key={w.label} label={w.label} pct={w.usedPercent} resetsAt={w.resetsAt} />)}
          {u.extra?.is_enabled && (
            <Meter label="Extra usage" pct={u.extra.utilization} resetsAt={null} />
          )}
        </div>
      )}

      {/* Codex: session tokens */}
      {s.id === 'codex' && (
        u.windows?.length ? (
          <div className="usage-stats">
            <div className="stat"><span className="stat-num">{fmtTok(u.totalTokens)}</span><small>session tokens</small></div>
          </div>
        ) : <div className="muted" style={{ fontSize: 13 }}>No recent session activity.</div>
      )}

      {/* Claude: token spend + estimated cost */}
      {s.id === 'claude' && (
        <>
          <div className="usage-stats">
            <div className="stat"><span className="stat-num">{fmtTok(u.totalTokens)}</span><small>tokens</small></div>
            <div className="stat"><span className="stat-num">{fmtUsd(u.estCostUsd)}</span><small>est. value</small></div>
            <div className="stat"><span className="stat-num">{fmtInt(u.messages)}</span><small>messages</small></div>
          </div>
          {claudeModels.map((m: any) => (
            <div className="mini-row usage-row" key={m.model}>
              <span className="mini-text">{m.model.replace('claude-', '')}</span>
              <span className="pill">{fmtTok(m.tokens)}</span>
              <span className="pill">{fmtUsd(Math.round((m.costUsd || 0) * 100) / 100)}</span>
            </div>
          ))}
          {u.note && <div className="usage-note">{u.note}</div>}
        </>
      )}

      {/* Cursor: auto vs API split + included-usage units + local activity */}
      {s.id === 'cursor' && (
        <>
          <div className="usage-stats">
            {u.totalPercentUsed != null && (
              <div className="stat"><span className="stat-num">{Math.round(u.totalPercentUsed)}%</span><small>total included</small></div>
            )}
            {u.units && (
              <div className="stat"><span className="stat-num">{fmtInt(u.units.used)}<span className="stat-den">/{fmtInt(u.units.limit)}</span></span><small>usage units</small></div>
            )}
            {u.aiEdits != null && <div className="stat"><span className="stat-num">{fmtInt(u.aiEdits)}</span><small>AI edits</small></div>}
          </div>
          {u.message && <div className="usage-note">{u.message}.</div>}
          {u.apiMessage && <div className="usage-note">{u.apiMessage}.</div>}
          {u.note && <div className="usage-note">{u.note}.</div>}
        </>
      )}
    </div>
  )
}

function AssistantPanel({ a }: { a: any }) {
  if (!a) return null
  const channels = CHANNEL_ORDER
    .map((id: any) => [id, a.byChannel?.[id] || 0])
    .filter(([, n]: any) => n > 0)
  // Known providers first, then any others present in the data, dropping zeros.
  const byProvider = a.byProvider || {}
  const providers = [...PROVIDER_ORDER, ...Object.keys(byProvider).filter((id) => !PROVIDER_ORDER.includes(id))]
    .map((id) => [id, byProvider[id] || 0])
    .filter(([, n]: any) => n > 0)
  const everUsed = a.total > 0
  return (
    <div className="usage-card assistant-card">
      <div className="usage-card-head">
        <span className="usage-name"><span className="ico"><Hi icon={SparklesIcon} size={16} /></span>Your assistant</span>
        {a.lastUsed
          ? <span className="pill usage-plan">last used {relTime(a.lastUsed)}</span>
          : <span className="pill">never used</span>}
      </div>

      {!everUsed ? (
        <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          No requests logged yet - usage is tracked from now on. Text the Shortcut, message the bot,
          or use the web chat and it'll show up here.
        </div>
      ) : (
        <>
          <div className="usage-stats" style={{ marginTop: 12 }}>
            <div className="stat"><span className="stat-num">{fmtInt(a.today)}</span><small>today</small></div>
            <div className="stat"><span className="stat-num">{fmtInt(a.last7d)}</span><small>7 days</small></div>
            <div className="stat"><span className="stat-num">{fmtInt(a.last30d)}</span><small>30 days</small></div>
            <div className="stat"><span className="stat-num">{fmtInt(a.total)}</span><small>all time</small></div>
          </div>

          <ActivityChart daily={a.daily} />

          <div className="chan-row">
            {channels.map(([id, n]: any) => (
              <span className="chan-chip" key={id} style={{ '--chan-color': CHANNEL_META[id]?.color } as any}>
                <span className="chan-ico">{CHANNEL_META[id]?.icon ? <Hi icon={CHANNEL_META[id].icon} size={14} /> : '•'}</span>{CHANNEL_META[id]?.label || id}
                <b>{fmtInt(n)}</b>
              </span>
            ))}
          </div>

          {providers.length > 0 && (
            <div className="chan-row provider-usage-row">
              <span className="usage-row-label">By provider</span>
              {providers.map(([id, n]: any) => (
                <span className="chan-chip" key={id} style={{ '--chan-color': PROVIDER_META[id]?.color || '#8a91a3' } as any}>
                  {PROVIDER_META[id]?.label || id}
                  <b>{fmtInt(n)}</b>
                </span>
              ))}
            </div>
          )}

          <div className="usage-sub" style={{ marginTop: 4 }}>
            {a.avgMs != null && <span>~{(a.avgMs / 1000).toFixed(1)}s avg reply</span>}
            {a.errorRate > 0 && <><span className="dotsep">·</span><span>{a.errorRate}% errors</span></>}
            {a.since && <><span className="dotsep">·</span><span>since {new Date(a.since).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span></>}
          </div>

          {a.recent?.length > 0 && (
            <div className="recent-list">
              {a.recent.slice(0, 8).map((e: any, i: number) => (
                <div className="recent-row" key={i}>
                  <span className="recent-when">{relTime(e.ts)}</span>
                  <span className="chan-chip sm" style={{ '--chan-color': CHANNEL_META[e.channel]?.color } as any}>
                    <span className="chan-ico">{CHANNEL_META[e.channel]?.icon ? <Hi icon={CHANNEL_META[e.channel].icon} size={12} /> : '•'}</span>{CHANNEL_META[e.channel]?.label || e.channel}
                  </span>
                  <span className="recent-text">{e.preview || <span className="muted">(no preview)</span>}</span>
                  {!e.ok && <span className="pill due-overdue">err</span>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

interface UsageViewProps {
  onAuthError: () => void
  embedded?: boolean
  /** Arrived via /settings/providers#usage — bring the section into view. */
  scrollIntoView?: boolean
}

export default function UsageView({ onAuthError, embedded = false, scrollIntoView = false }: UsageViewProps) {
  const { autoRefresh, reduceMotion } = useSettings()
  const [data, setData] = useState<any>(null)
  const [assistant, setAssistant] = useState<any>(null)
  const [err, setErr] = useState<any>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Bumped after a settings save so the quota panel re-reads the new shape.
  const [reloadKey, setReloadKey] = useState(0)
  const timer = useRef<any>(null)

  const load = useCallback(async () => {
    try {
      const [d, a] = await Promise.all([getUsage(), getAssistantUsage()])
      setData(d); setAssistant(a); setErr(null)
    } catch (e: any) {
      if (e instanceof AuthError) { onAuthError(); return }
      setErr(e.message)
    }
  }, [onAuthError])

  // A rename/hide changes both the live-quota panel and the subscription cards.
  const onSettingsChanged = useCallback(() => {
    setReloadKey((k) => k + 1)
    load()
  }, [load])

  // Deep-linked from Overview ▸ Providers ▸ Usage. The section sits below the
  // provider list, so without this you land on the settings page and still have
  // to hunt for it. Runs after the first paint so the anchor has a position.
  // Re-runs once the data lands, since the cards above it change height while
  // they load and would otherwise leave the section off-screen again.
  const anchor = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!scrollIntoView) return undefined
    const id = requestAnimationFrame(() => {
      anchor.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
    })
    return () => cancelAnimationFrame(id)
  }, [scrollIntoView, reduceMotion, Boolean(data)])

  useEffect(() => {
    load()
    // Live-ish: re-poll every 30s while mounted, unless auto-refresh is off.
    if (!autoRefresh) return undefined
    timer.current = setInterval(load, 30000)
    return () => clearInterval(timer.current)
  }, [load, autoRefresh])

  const services = data?.services || []
  const monthly = services.reduce((sum: number, s: any) => sum + (s.priceUsd || 0), 0)
  const subtitle = monthly
    ? `${fmtUsd(monthly)}/mo across ${services.length} subscriptions`
    : 'Assistant activity & coding-assistant subscriptions'

  // The gear opens the panel that owns which profiles are tracked, what they're
  // called, and the subscription facts the vendors don't publish.
  const settingsButton = (
    <button
      className={`btn compact ${settingsOpen ? 'on' : ''}`}
      onClick={() => setSettingsOpen((v) => !v)}
      title="Edit accounts, names, prices, and what's shown here"
      aria-expanded={settingsOpen}
    >
      <Hi icon={Cog6ToothIcon} size={15} /> {settingsOpen ? 'Done' : 'Settings'}
    </button>
  )

  // Deliberately outside `body`: a broken /api/usage is one of the things you'd
  // open the settings to fix, so the editor must not depend on it loading.
  const settingsPanel = settingsOpen && (
    <>
      <div className="group-title">Usage settings</div>
      <AiUsageSettings onAuthError={onAuthError} onChanged={onSettingsChanged} />
    </>
  )

  const body = err ? <div className="muted inline-warn"><WarnIcon /> {err}</div>
    : !data ? <div className="muted">Loading…</div>
    : (
      <>
        {/* Live rate limits come from the bridge's AI-usage poller — it watches
            every Claude/Codex/Cursor profile, not just the one this box logs into. */}
        <div className="group-title">Live quota</div>
        <AiUsagePanel onAuthError={onAuthError} autoRefresh reloadKey={reloadKey} />
        <div className="group-title">Assistant activity</div>
        <AssistantPanel a={assistant} />
        <div className="group-title">Subscriptions</div>
        <div className="usage-grid">
          {services.map((s: any) => <ServiceCard key={s.id} s={s} quotaElsewhere />)}
        </div>
      </>
    )

  // Embedded inside the Providers tab: render as a section rather than a
  // standalone view with its own page header.
  if (embedded) {
    return (
      <>
        <div className="settings-section-title" id="usage" ref={anchor}>
          <span />
          <strong>Usage</strong>
          <div className="settings-section-actions">{settingsButton}</div>
        </div>
        <div className="muted settings-note">
          {subtitle}{data && <> · updated {relTime(data.generatedAt)}</>}
        </div>
        {settingsPanel}
        {body}
      </>
    )
  }

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1 style={{ marginBottom: 2 }}>Usage</h1>
          <div className="muted" style={{ fontSize: 13 }}>
            {subtitle}
            {data && <> · updated {relTime(data.generatedAt)}</>}
          </div>
        </div>
        <div className="view-head-actions">
          {settingsButton}
          <button className="btn" onClick={load}>Refresh</button>
        </div>
      </div>

      {settingsPanel}
      {body}
    </div>
  )
}
