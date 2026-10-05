// Shared usage vocabulary + tiny presentational pieces used by both the Usage
// view and the Overview tab. Kept in one place so the channel/provider colors,
// number formatting, and quota-bar rendering stay identical across the app.
import React, { useState } from 'react'
import {
  Hi,
  ChatBubbleLeftRightIcon,
  DevicePhoneMobileIcon,
  SunIcon,
  DocumentTextIcon,
  ServerStackIcon,
  FireIcon,
  CheckCircleIcon,
  PlusIcon,
  CalendarDaysIcon,
  SparklesIcon,
  CommandLineIcon,
} from './icons'

// ---- Number / time formatting ----
export const fmtInt = (n: number | null | undefined) => (n == null ? '-' : n.toLocaleString())
export const fmtUsd = (n: number | null | undefined) => (n == null ? '-' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`)
export const fmtTok = (n: number | null | undefined) => {
  if (n == null) return '-'
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

export function relTime(ms: number | null | undefined): string | null {
  if (!ms) return null
  const diff = Date.now() - ms
  const s = Math.round(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function untilTime(ms: number | null | undefined): string | null {
  if (!ms) return null
  const diff = ms - Date.now()
  if (diff <= 0) return 'now'
  const m = Math.round(diff / 60000)
  if (m < 60) return `in ${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `in ${h}h`
  return `in ${Math.round(h / 24)}d`
}

// Where Totem actually got used - the real surface behind each channel id.
export const CHANNEL_ORDER = ['web', 'http', 'mcp', 'morning', 'journal']
export const CHANNEL_META: Record<string, any> = {
  web: { label: 'Web app', icon: ChatBubbleLeftRightIcon, color: '#2563eb' },
  http: { label: 'iOS Shortcut', icon: DevicePhoneMobileIcon, color: '#16a34a' },
  mcp: { label: 'External client (MCP)', icon: ServerStackIcon, color: '#14b8a6' },
  morning: { label: 'Morning briefing', icon: SunIcon, color: '#f59e0b' },
  journal: { label: 'Journal ingest', icon: DocumentTextIcon, color: '#a855f7' },
}

// Productivity activity kinds — every object created or completed through Totem.
// Order is the chart's stacking order (completions at the base). Shares the exact
// same shape as CHANNEL_META so the stacked ActivityChart renders it unchanged.
export const ACTIVITY_ORDER = ['habit.log', 'todo.complete', 'todo.create', 'event.create', 'habit.create', 'terminal.command']
export const ACTIVITY_META: Record<string, any> = {
  'habit.log': { label: 'Habit logged', icon: FireIcon, color: '#22c55e' },
  'todo.complete': { label: 'Todo completed', icon: CheckCircleIcon, color: '#2563eb' },
  'todo.create': { label: 'Todo added', icon: PlusIcon, color: '#38bdf8' },
  'event.create': { label: 'Event added', icon: CalendarDaysIcon, color: '#f59e0b' },
  'habit.create': { label: 'Habit added', icon: SparklesIcon, color: '#a855f7' },
  'terminal.command': { label: 'Terminal command', icon: CommandLineIcon, color: '#94a3b8' },
}

// Which agent backend served each request. Order pins the four known providers
// first; any other id falls through with a generic label/color.
export const PROVIDER_ORDER = ['cursor', 'codex', 'claude', 'opencode']
export const PROVIDER_META: Record<string, any> = {
  cursor: { label: 'Cursor', color: '#5b8cff' },
  codex: { label: 'Codex', color: '#f3f4f6' },
  claude: { label: 'Claude Code', color: '#d97757' },
  opencode: { label: 'OpenCode', color: '#f0506e' },
}

const LOGO_PATHS: Record<string, string> = {
  claude: 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z',
  codex: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
  cursor: 'M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23',
}

export function ProductIcon({ id, title }: { id: string; title?: string }) {
  const d = LOGO_PATHS[id]
  if (!d) return <span className="ico">•</span>
  return (
    <svg className={`product-ico ${id}`} viewBox="0 0 24 24" role="img" aria-label={title || id}>
      <path d={d} />
    </svg>
  )
}

// A used-percent meter (quota windows - Claude/Codex/Cursor).
export function Meter({ label, pct, resetsAt }: { label: string; pct?: number | null; resetsAt?: number | null }) {
  const p = Math.max(0, Math.min(100, pct ?? 0))
  const cls = p >= 90 ? 'red' : p >= 70 ? 'amber' : ''
  return (
    <div className="usage-meter">
      <div className="usage-meter-head">
        <span>{label}</span>
        <span className="muted">{pct == null ? '-' : `${Math.round(pct)}%`}{resetsAt ? ` · resets ${untilTime(resetsAt)}` : ''}</span>
      </div>
      <div className="usage-bar"><div className={`usage-bar-fill ${cls}`} style={{ width: `${p}%` }} /></div>
    </div>
  )
}

// A "YYYY-MM-DD" day key -> a local Date (avoids the UTC-midnight off-by-one).
function dayKeyToDate(key: string): Date {
  if (typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key)) {
    const [y, m, d] = key.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  return new Date(key)
}

// Shared 30-day stacked activity graph. One column per day, each split into the
// segments that made up that day. Hovering a column reveals a floating tooltip
// with the day's total and per-segment breakdown. Defaults to the AI-request
// channel palette (Settings ▸ Usage), but `order`/`meta`/`unit` let the Overview
// reuse the identical chart for productivity activity (todos/habits/events).
interface ActivityChartProps {
  daily?: any[]
  height?: number
  order?: string[]
  meta?: Record<string, any>
  unit?: string
}

export function ActivityChart({
  daily,
  height = 104,
  order = CHANNEL_ORDER,
  meta = CHANNEL_META,
  unit = 'request',
}: ActivityChartProps) {
  const [hover, setHover] = useState<number | null>(null) // hovered column index, or null
  if (!daily?.length) return null
  const max = Math.max(1, ...daily.map((d) => d.count))
  const active = hover != null ? daily[hover] : null
  // Keep the tooltip from spilling past the chart edges near the first/last days.
  const tipLeft = hover == null ? 0 : Math.min(92, Math.max(8, ((hover + 0.5) / daily.length) * 100))

  return (
    <div className="activity-chart" style={{ '--activity-h': `${height}px` } as React.CSSProperties}>
      <div className="activity-bars" onMouseLeave={() => setHover(null)}>
        {daily.map((d, i) => (
          <div
            key={d.date}
            className={`activity-col${hover === i ? ' is-hover' : ''}`}
            onMouseEnter={() => setHover(i)}
          >
            <div
              className="activity-bar"
              style={{ height: `${d.count ? Math.max(4, Math.round((d.count / max) * 100)) : 0}%` }}
            >
              {order.map((id) => {
                const n = d.channels?.[id] || 0
                if (!n) return null
                return (
                  <div
                    key={id}
                    className="activity-seg"
                    style={{ height: `${(n / d.count) * 100}%`, background: meta[id]?.color }}
                  />
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {active && (
        <div className="activity-tip" style={{ left: `${tipLeft}%` }}>
          <div className="activity-tip-day">
            {dayKeyToDate(active.date).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
          </div>
          <div className="activity-tip-total">{fmtInt(active.count)} {unit}{active.count === 1 ? '' : 's'}</div>
          {active.count > 0 && (
            <div className="activity-tip-rows">
              {order.filter((id) => active.channels?.[id]).map((id) => (
                <div className="activity-tip-row" key={id}>
                  <span className="activity-tip-dot" style={{ background: meta[id]?.color }} />
                  <span className="activity-tip-label">{meta[id]?.label || id}</span>
                  <b>{fmtInt(active.channels[id])}</b>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// A single series feeding one half of the diverging combo chart below.
interface ComboSeries {
  daily?: any[] // [{ date, count, channels: {segId: n} }]
  order: string[] // segment stacking order
  meta: Record<string, any> // segId -> { label, color, icon }
  label: string // legend/tooltip heading, e.g. "AI chat"
  unit: string // "request" / "action"
}

// Diverging 30-day activity graph — the AI-usage graph and the productivity
// graph fused into one picture. `top` rises above a center baseline, `bottom`
// descends below it, so a glance reads as "conversations in ↑ / things done ↓".
// Each half is scaled to its own peak (the two datasets differ by an order of
// magnitude), and both halves share one hovered column + a two-part tooltip.
export function ComboActivityChart({ top, bottom, height = 160 }: { top: ComboSeries; bottom: ComboSeries; height?: number }) {
  const [hover, setHover] = useState<number | null>(null)
  // Align the two series by date (both are last-30-days from the bridge, but
  // merge on the key rather than trust index parity).
  const dates = (top.daily?.length ? top.daily : bottom.daily || []).map((d) => d.date)
  const topByDate: Record<string, any> = Object.fromEntries((top.daily || []).map((d) => [d.date, d]))
  const botByDate: Record<string, any> = Object.fromEntries((bottom.daily || []).map((d) => [d.date, d]))
  const cols = dates.map((date) => ({ date, top: topByDate[date], bottom: botByDate[date] }))
  if (!cols.length) return null
  const topMax = Math.max(1, ...cols.map((c) => c.top?.count || 0))
  const botMax = Math.max(1, ...cols.map((c) => c.bottom?.count || 0))
  const half = Math.floor((height - 1) / 2)
  const active = hover != null ? cols[hover] : null
  const tipLeft = hover == null ? 0 : Math.min(92, Math.max(8, ((hover + 0.5) / cols.length) * 100))

  const halfBar = (day: any, series: ComboSeries, max: number, dir: 'up' | 'down') => (
    <div className={`combo-bar ${dir}`} style={{ height: `${day?.count ? Math.max(5, Math.round((day.count / max) * 100)) : 0}%` }}>
      {series.order.map((id) => {
        const n = day?.channels?.[id] || 0
        if (!n) return null
        return <div key={id} className="combo-seg" style={{ height: `${(n / day.count) * 100}%`, background: series.meta[id]?.color }} />
      })}
    </div>
  )

  const tipRows = (day: any, series: ComboSeries, dir: 'up' | 'down') => (
    <div className="combo-tip-half">
      <div className={`combo-tip-head ${dir}`}>
        <span className="combo-arrow">{dir === 'up' ? '▲' : '▼'}</span>
        {fmtInt(day?.count || 0)} {series.label} {series.unit}{(day?.count || 0) === 1 ? '' : 's'}
      </div>
      {(day?.count || 0) > 0 && (
        <div className="activity-tip-rows">
          {series.order.filter((id) => day.channels?.[id]).map((id) => (
            <div className="activity-tip-row" key={id}>
              <span className="activity-tip-dot" style={{ background: series.meta[id]?.color }} />
              <span className="activity-tip-label">{series.meta[id]?.label || id}</span>
              <b>{fmtInt(day.channels[id])}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <div className="activity-chart combo-chart" style={{ '--combo-half': `${half}px` } as React.CSSProperties}>
      <div className="combo-axis up">{top.label}</div>
      <div className="combo-bars" onMouseLeave={() => setHover(null)}>
        <div className="combo-baseline" />
        {cols.map((c, i) => (
          <div key={c.date} className={`combo-col${hover === i ? ' is-hover' : ''}`} onMouseEnter={() => setHover(i)}>
            <div className="combo-top">{halfBar(c.top, top, topMax, 'up')}</div>
            <div className="combo-bottom">{halfBar(c.bottom, bottom, botMax, 'down')}</div>
          </div>
        ))}
      </div>
      <div className="combo-axis down">{bottom.label}</div>

      {active && (
        <div className="activity-tip combo-tip" style={{ left: `${tipLeft}%` }}>
          <div className="activity-tip-day">
            {dayKeyToDate(active.date).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
          </div>
          {tipRows(active.top, top, 'up')}
          <div className="combo-tip-div" />
          {tipRows(active.bottom, bottom, 'down')}
        </div>
      )}
    </div>
  )
}

// Channel/provider chip (colored dot + label + count). Used by both views.
export function UsageChip({ color, icon, label, count, sm = false }: { color?: string; icon?: any; label?: string; count?: number | null; sm?: boolean }) {
  return (
    <span className={`chan-chip${sm ? ' sm' : ''}`} style={{ '--chan-color': color } as React.CSSProperties}>
      {icon && <span className="chan-ico"><Hi icon={icon} size={sm ? 12 : 14} /></span>}
      {label}
      {count != null && <b>{fmtInt(count)}</b>}
    </span>
  )
}
