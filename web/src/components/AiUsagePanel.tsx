/**
 * Live AI quota, rendered from the in-process poller's snapshot.
 *
 * The bridge owns the hard part — discovering every Claude/Codex/Cursor profile
 * on the box, polling vendors, and pushing `GET /api/ai-usage/stream` whenever
 * the snapshot changes (see bridge.mjs ▸ ai-usage). This panel is just that
 * stream, drawn in Totem's skin. Re-poll remains as a force credential refresh,
 * not as the way you find out a bar moved.
 *
 * Two conventions are deliberate:
 *  - bars draw **headroom**, not usage, so a short bar always means running out;
 *  - severity ships as a colour *plus* an icon and a word, never colour alone.
 */
import React from 'react'
import { useAiUsageLive } from '../useAiUsageLive'
import { ProductIcon, relTime } from '../usageMeta'
import { Hi, ArrowPathIcon, ArrowTopRightOnSquareIcon, WarnIcon } from '../icons'

const BACKEND_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' }

// Keyed off remaining headroom, matching the poller's thresholds exactly.
const SEVERITIES = [
  { key: 'good', min: 60, icon: '●', word: 'Healthy' },
  { key: 'warning', min: 25, icon: '▲', word: 'Watch' },
  { key: 'serious', min: 10, icon: '◆', word: 'Low' },
  { key: 'critical', min: -1, icon: '■', word: 'Critical' },
]

function severityFor(remainingPct?: number | null) {
  if (remainingPct == null) return { key: 'unknown', icon: '○', word: 'Unknown' }
  return SEVERITIES.find((s) => remainingPct > s.min) || SEVERITIES[SEVERITIES.length - 1]
}

const fmtPct = (v?: number | null) => (v == null ? '—' : `${Number.isInteger(v) ? v : v.toFixed(1)}%`)

// "in 3h 12m" — the part you actually plan around.
function untilLabel(ms?: number | null): string | null {
  if (!ms) return null
  const diff = ms - Date.now()
  if (diff <= 0) return 'due now'
  const mins = Math.round(diff / 60000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `in ${hours}h ${mins % 60}m`
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function QuotaMeter({ meter, compact }: { meter: any; compact?: boolean }) {
  const sev = severityFor(meter.remainingPct)
  const width = Math.max(0, Math.min(100, meter.remainingPct ?? 0))
  const until = untilLabel(meter.resetsAt)
  const aria = `${meter.label}: ${fmtPct(meter.remainingPct)} remaining, ${fmtPct(meter.usedPct)} used. ${sev.word}.`
  return (
    <div className={`quota-meter${compact ? ' compact' : ''}`} data-severity={sev.key}>
      <div className="quota-meter-top">
        <span className="quota-meter-label">{meter.label}</span>
        <span className="quota-sev"><span aria-hidden="true">{sev.icon}</span> {sev.word}</span>
        <span className="quota-meter-value">{fmtPct(meter.remainingPct)} left</span>
      </div>
      <div className="quota-track" role="img" aria-label={aria}>
        <div className="quota-fill" style={{ width: `${width}%` }} />
      </div>
      {!compact && (
        <div className="quota-meter-foot muted">
          {fmtPct(meter.usedPct)} used
          {meter.resetsAt
            ? <> · resets {new Date(meter.resetsAt).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}{until ? ` · ${until}` : ''}</>
            : ' · no reset scheduled'}
        </div>
      )}
    </div>
  )
}

function AccountCard({ account, backendLabel }: { account: any; backendLabel: string }) {
  const failed = account.status && account.status !== 'ok'
  return (
    <div className={`quota-card${failed ? ' failed' : ''}`}>
      <div className="quota-card-head">
        <span className="usage-name">
          <ProductIcon id={account.backend} title={backendLabel} />
          {account.displayName || account.label}
        </span>
        {account.plan && <span className="pill usage-plan">{account.plan}</span>}
      </div>
      <div className="quota-card-sub muted">
        {account.email || account.sourceFile}
        {account.org && account.org !== account.email && <> · {account.org}</>}
      </div>

      {failed ? (
        <div className="muted inline-warn"><WarnIcon /> {account.error || account.status}</div>
      ) : account.meters?.length ? (
        <div className="quota-meters">
          {account.meters.map((m: any) => <QuotaMeter key={m.key} meter={m} />)}
        </div>
      ) : (
        <div className="muted quota-empty">No windows reported.</div>
      )}

      {account.notes?.length > 0 && (
        <div className="quota-notes muted">{account.notes.join(' · ')}</div>
      )}
      {account.detailUrl && (
        <a className="quota-detail-link" href={account.detailUrl} target="_blank" rel="noreferrer">
          Vendor dashboard <Hi icon={ArrowTopRightOnSquareIcon} size={12} />
        </a>
      )}
    </div>
  )
}

interface AiUsagePanelProps {
  onAuthError: () => void
  /** Kept so Settings ▸ Usage can still opt into live updates; the stream is always live. */
  autoRefresh?: boolean
  /** Bump to force an immediate re-read — e.g. after the settings panel saves. */
  reloadKey?: number
}

export default function AiUsagePanel({ onAuthError, reloadKey = 0 }: AiUsagePanelProps) {
  const { data, err, busy, forceRefresh } = useAiUsageLive({ onAuthError, reloadKey })

  const accounts = data?.accounts || []
  // Group by backend so three Claude profiles read as one Claude section.
  const backends = [...new Set(accounts.map((a: any) => a.backend))] as string[]
  // Section titles follow Settings ▸ Usage, falling back to the stock names.
  const labelFor = (backend: string) => data?.providers?.[backend] || BACKEND_LABEL[backend] || backend

  return (
    <div className="quota-panel">
      <div className="quota-panel-head">
        <div className="muted quota-panel-sub">
          {data?.ok
            ? <>{accounts.length} account{accounts.length === 1 ? '' : 's'} · live · updated {relTime(data.updatedAt)}</>
            : 'Live rate limits for every AI account on this box'}
        </div>
        <div className="quota-panel-actions">
          <button className="btn compact" onClick={() => { void forceRefresh() }} disabled={busy} title="Force a credential refresh and re-poll">
            <Hi icon={ArrowPathIcon} size={14} /> {busy ? 'Polling…' : 'Re-poll'}
          </button>
        </div>
      </div>

      {err ? (
        <div className="muted inline-warn"><WarnIcon /> {err}</div>
      ) : !data ? (
        <div className="muted">Loading live quota…</div>
      ) : !data.ok ? (
        <div className="quota-down">
          <div className="muted inline-warn"><WarnIcon /> {data.error}</div>
          <div className="muted quota-down-hint">
            Polling runs inside the bridge — check <code>journalctl --user -u assistant-bridge -f</code>.
          </div>
        </div>
      ) : (
        backends.map((backend) => {
          const title = labelFor(backend)
          const cards = accounts.filter((a: any) => a.backend === backend)
          // One profile called the same thing as its service ("Claude" under
          // "Claude") is a header saying nothing — drop it and keep the card.
          const named = (a: any) => a.displayName || a.label
          const redundant = cards.length === 1 && named(cards[0]).toLowerCase() === title.toLowerCase()
          return (
            <div key={backend} className="quota-group">
              {!redundant && <div className="quota-group-title">{title}</div>}
              <div className="quota-grid">
                {cards.map((a: any) => <AccountCard key={a.id} account={a} backendLabel={title} />)}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}
