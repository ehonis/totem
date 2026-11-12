// Settings → Activity (web LogsView.tsx): what Totem is doing, what it did, and
// who asked. Four sections, by how urgently they are needed: approval sessions
// waiting on the owner, runs going now, every audited action, and the durable
// output of finished commands. A run, an output or an entry opens in the log
// sheet (activity/LogSheet.tsx). Approval sessions expire on a clock, so the pane
// refreshes while it is on screen, faster while something runs.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'
import { router, useIsFocused } from 'expo-router'
import {
  ApiError, AuthError, approveApprovalSession, denyApprovalSession, getActionLogSummary, getActionLogs,
  getApprovals, getOutputs, getRuns, revokeApprovalSession,
} from '../../../lib/api'
import { partitionApprovalLeases } from '../../../lib/components/approvalLeases'
import { Hi, CheckCircleIcon, ClockIcon, CommandLineIcon, SparklesIcon, XMarkIcon, ArrowPathIcon } from '../../../lib/icons'
import { pushError, pushSuccess } from '../../../lib/toast'
import { colors, fonts } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn, IconBtn, Segmented } from '../../../ui/kit'
import { confirm } from '../../../ui/menu'
import { Notice, Picker, Pill, Row, Section } from '../ui'
import { agoText, clockTime, elapsed, holdEntry, minutesLeft, type LogEntry } from '../activity/format'

const REFRESH_MS = 15_000
const LIVE_REFRESH_MS = 3_000

const ACTION_FILTERS = [
  { value: '', label: 'Everything' },
  { value: 'inbox', label: 'Inbox' },
  { value: 'command', label: 'Commands' },
  { value: 'approval', label: 'Approvals' },
  { value: 'task', label: 'Tasks' },
  { value: 'event', label: 'Calendar' },
  { value: 'note', label: 'Notes' },
  { value: 'habit', label: 'Habits' },
  { value: 'connection', label: 'Connections' },
]

const STATUS_FILTERS = [
  { value: '', label: 'Any result' },
  { value: 'ok', label: 'Worked' },
  { value: 'error', label: 'Failed' },
  { value: 'denied', label: 'Blocked' },
]

const WINDOWS = [
  { value: '1', label: '1h' },
  { value: '24', label: '24h' },
  { value: '168', label: '7d' },
  { value: '720', label: '30d' },
] as const

interface Grant {
  approvalSessionId: string
  kind: string
  status: string
  explanation: string
  why: string
  requestedBy: string
  requestedAt: string
  expiresAt: string
  code: string | null
  useCount: number
  lastUsedAt?: string
  denyReason?: string
  revokeReason?: string
  legacy?: boolean
}

const statusTone = (s: string) => (s === 'ok' ? 'ok' : s === 'error' ? 'error' : s === 'denied' ? 'warn' : undefined)

// A refusal from the approval gate names what it needs (the approval code); say it as the bridge did.
const refusal = (e: any, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message : '') || fallback

function GrantRow({ grant, onDecided }: { grant: Grant; onDecided: () => void }) {
  const active = grant.status === 'approved'
  const [busy, setBusy] = useState<'' | 'approve' | 'deny' | 'revoke'>('')
  const left = minutesLeft(grant.expiresAt)

  const decide = async (kind: 'approve' | 'deny' | 'revoke') => {
    if (kind === 'revoke' && !(await confirm('Revoke this session?', { message: `${grant.requestedBy} loses its approval at once.`, confirmLabel: 'Revoke' }))) return
    setBusy(kind)
    try {
      if (kind === 'approve') await approveApprovalSession(grant.approvalSessionId)
      else if (kind === 'deny') await denyApprovalSession(grant.approvalSessionId, 'denied from the app')
      else await revokeApprovalSession(grant.approvalSessionId, 'revoked from the app')
      pushSuccess(kind === 'approve' ? `Approved ${grant.requestedBy}'s working session` : kind === 'revoke' ? 'Approval session revoked' : 'Approval session denied')
      onDecided()
    } catch (e) {
      pushError(refusal(e, 'Could not record that decision.'))
    } finally {
      setBusy('')
    }
  }

  return (
    <Row
      stacked
      title={`${grant.requestedBy} ${active ? 'has an active working session' : 'requests a working session'}`}
      control={<Pill label={left > 0 ? `${left}m left` : 'expired'} tone={left <= 3 ? 'error' : active ? 'ok' : 'warn'} />}
    >
      {/* The explanation is the decision, so it is the row's content, not metadata. */}
      <View style={{ gap: 8 }}>
        <View style={{ gap: 2 }}>
          <T size={12} weight={600} muted>WHAT IT DOES</T>
          <T size={14} lineHeight={20}>{grant.explanation}</T>
        </View>
        <View style={{ gap: 2 }}>
          <T size={12} weight={600} muted>WHY</T>
          <T size={14} lineHeight={20}>{grant.why}</T>
        </View>
        {active ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <T size={12.5} muted style={{ flex: 1 }}>
              {grant.useCount.toLocaleString()} {grant.useCount === 1 ? 'action' : 'actions'}{grant.lastUsedAt ? `, last used ${agoText(grant.lastUsedAt)}` : ', not used yet'}
            </T>
            <Btn compact icon={XMarkIcon} title={busy === 'revoke' ? 'Revoking…' : 'Revoke'} disabled={!!busy} onPress={() => void decide('revoke')} />
          </View>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Btn compact kind="primary" icon={CheckCircleIcon} title={busy === 'approve' ? 'Approving…' : 'Approve'} disabled={!!busy || left <= 0} onPress={() => void decide('approve')} />
            <Btn compact icon={XMarkIcon} title={busy === 'deny' ? 'Denying…' : 'Deny'} disabled={!!busy} onPress={() => void decide('deny')} />
            {/* Read to the assistant when no dashboard is at hand. */}
            {grant.code ? <T size={12.5} muted selectable>code <T size={12.5} weight={700} style={{ fontFamily: fonts.mono }}>{grant.code}</T></T> : null}
          </View>
        )}
      </View>
    </Row>
  )
}

export default function ActivityPane(_: { target?: string }) {
  const focused = useIsFocused()
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [summary, setSummary] = useState<any>(null)
  const [grants, setGrants] = useState<Grant[]>([])
  const [outputs, setOutputs] = useState<any[]>([])
  const [runs, setRuns] = useState<any[]>([])
  const [timezone, setTimezone] = useState<string | undefined>()
  const [action, setAction] = useState('')
  const [status, setStatus] = useState('')
  const [hours, setHours] = useState(24)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showDecided, setShowDecided] = useState(false)

  const load = useCallback(async () => {
    try {
      const [logs, sum, appr, outs, live] = await Promise.all([
        getActionLogs({ action, status, hours, limit: 200 }),
        getActionLogSummary(hours),
        getApprovals(),
        getOutputs(50),
        getRuns(),
      ])
      setEntries(logs.entries || [])
      setTimezone(logs.timezone || undefined)
      setSummary(sum)
      setGrants(appr.grants || [])
      setOutputs(outs.outputs || [])
      setRuns(live.runs || [])
      setError('')
    } catch (e: any) {
      if (e instanceof AuthError) return
      setError(e?.message || 'Could not load the activity log.')
    } finally {
      setLoading(false)
    }
  }, [action, status, hours])

  const anyRunning = useMemo(() => runs.some((r) => r.status === 'running'), [runs])
  useEffect(() => {
    if (!focused) return
    void load()
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  }, [load, focused])
  // While something runs, only the run list is read fast; the log, approvals and
  // outputs keep the slow tick, and are read once more when the last run ends.
  useEffect(() => {
    if (!focused || !anyRunning) return
    const t = setInterval(() => {
      getRuns().then((live) => {
        const next = live.runs || []
        setRuns(next)
        if (!next.some((r: any) => r.status === 'running')) void load()
      }).catch(() => {})
    }, LIVE_REFRESH_MS)
    return () => clearInterval(t)
  }, [focused, anyRunning, load])

  const { pending, active, decided } = useMemo(() => {
    const g = partitionApprovalLeases(grants)
    return { ...g, decided: g.decided.slice(0, 8) }
  }, [grants])
  const failures = summary?.byStatus?.error || 0
  const liveCount = runs.filter((r) => r.status === 'running').length

  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}

      <Section
        id="logs"
        title="Approvals"
        action={
          <>
            {pending.length ? <Pill label={`${pending.length} waiting`} tone="warn" /> : null}
            {active.length ? <Pill label={`${active.length} active`} tone="ok" /> : null}
            <IconBtn icon={ArrowPathIcon} label="Refresh" size={16} box={30} onPress={() => void load()} />
          </>
        }
        description="An assistant cannot activate a session itself. Once approved, a session stays active until an hour passes without an authorized action. Approving from the phone needs its approval code (Settings → Security)."
      >
        {!pending.length && !active.length ? <Row title="Nothing waiting" description="No approval sessions are waiting or active." /> : null}
        {pending.map((g) => <GrantRow key={g.approvalSessionId} grant={g} onDecided={load} />)}
        {active.map((g) => <GrantRow key={g.approvalSessionId} grant={g} onDecided={load} />)}
        {decided.length ? (
          <Row title={`Recently decided (${decided.length})`} onPress={() => setShowDecided((v) => !v)} value={showDecided ? 'Hide' : 'Show'} />
        ) : null}
        {showDecided ? decided.map((g) => (
          <Row
            key={g.approvalSessionId}
            title={g.explanation || g.approvalSessionId.slice(0, 8)}
            description={[g.approvalSessionId.slice(0, 8), g.requestedBy, g.denyReason, g.revokeReason].filter(Boolean).join(' · ')}
            control={<Pill label={g.status} />}
          />
        )) : null}
      </Section>

      <Section
        title="Now running"
        action={liveCount ? <Pill label={`${liveCount} live`} tone="warn" /> : <T size={12.5} muted>idle</T>}
        description="Commands and agent runs accepted from the inbox, while they work and for half an hour after."
      >
        {!runs.length ? <Row title="Nothing running" /> : runs.map((r) => {
          const running = r.status === 'running'
          return (
            <Row
              key={`${r.id}-${r.startedAt}`}
              icon={<Hi icon={r.kind === 'agent' ? SparklesIcon : CommandLineIcon} size={14} color={colors.muted} />}
              title={r.label || r.id}
              description={[r.id, r.provider ? `${r.provider}${r.model ? `/${r.model}` : ''}` : '', r.actor].filter(Boolean).join(' · ')}
              accessory={running
                ? <Pill label={`Running · ${elapsed(r.ms)}`} tone="warn" />
                : <Pill label={r.status === 'ok' ? 'Done' : r.error || r.status} tone={r.status === 'ok' ? 'ok' : 'error'} />}
              chevron
              onPress={() => router.push({ pathname: '/settings/log', params: { kind: 'run', id: r.id } })}
            />
          )
        })}
      </Section>

      <Section
        title="Activity"
        description={`Every action Totem takes, who asked for it, and whether it worked.${summary ? ` ${summary.count} in the last ${hours}h${failures ? `, ${failures} failed` : ''}.` : ''}`}
      >
        <Row
          title="Window"
          stacked
          control={<Segmented options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))} value={String(hours) as any} onChange={(v) => setHours(Number(v))} />}
        />
        <Row title="Kind" control={<Picker label="Kind" value={action} options={ACTION_FILTERS} onChange={setAction} />} />
        <Row title="Result" control={<Picker label="Result" value={status} options={STATUS_FILTERS} onChange={setStatus} />} />
        {loading ? <Row title="Loading…" /> : !entries.length ? (
          <Row title={`Nothing matches in the last ${hours}h.`} />
        ) : entries.map((e) => (
          <Row
            key={e.id}
            title={<T size={13.5} weight={500} style={{ fontFamily: fonts.mono }} numberOfLines={1}>{e.action}</T>}
            description={`${clockTime(e.iso, timezone)} · ${e.actor}${e.summary || e.target ? ` · ${e.summary || e.target}` : ''}${e.ms != null ? ` · ${e.ms}ms` : ''}`}
            accessory={<Pill label={e.status} tone={statusTone(e.status)} />}
            onPress={() => { holdEntry(e, timezone); router.push({ pathname: '/settings/log', params: { kind: 'entry', id: e.id } }) }}
          />
        ))}
      </Section>

      <Section title="Command outputs" action={<T size={12.5} muted>{outputs.length}</T>}>
        {!outputs.length ? <Row title="No commands have run from the inbox yet." /> : outputs.map((o) => (
          <Row
            key={o.id}
            icon={<Hi icon={ClockIcon} size={13} color={colors.muted} />}
            title={<T size={13.5} style={{ fontFamily: fonts.mono }} numberOfLines={1}>{o.label || o.id}</T>}
            description={[o.ms != null ? `${o.ms}ms` : '', o.finishedAt ? agoText(o.finishedAt) : ''].filter(Boolean).join(' · ') || undefined}
            accessory={<Pill label={`exit ${o.exitCode ?? '—'}`} tone={o.ok ? 'ok' : 'error'} />}
            chevron
            onPress={() => router.push({ pathname: '/settings/log', params: { kind: 'output', id: o.id } })}
          />
        ))}
      </Section>
    </>
  )
}
