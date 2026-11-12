// Settings → Usage › Edit tracking (web AiUsageSettings.tsx): what the Usage pane
// shows, written to data/ai-usage.json on the server: how often to poll, whether
// to find profiles on its own, the two opt-in quota pollers, and per service its
// name, plan, price and renewal, and per profile its name and whether it is shown.
// Text commits when the field is left; switches commit at once. Each save answers
// with the whole new config. Saves queue, one request at a time, so the next
// field can be edited while one is out.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { AuthError, getAiUsageConfig, setAiUsageConfig } from '../../../lib/api'
import { Hi, EyeIcon, EyeSlashIcon, PlusIcon, TrashIcon } from '../../../lib/icons'
import { colors } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn, IconBtn } from '../../../ui/kit'
import { confirm } from '../../../ui/menu'
import { ProviderLogo } from '../../chat/ui'
import { Code, Field, Loading, Notice, PaneScroll, Pill, Row, Section, Switch } from '../ui'

/** A field that reports a change only once it is finished being typed. */
function CommitField({ value, onCommit, placeholder, disabled, numeric, label, width }: {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  disabled?: boolean
  numeric?: boolean
  label: string
  width?: number
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  // Follow the server once a save lands, unless the field is being typed in again:
  // the answer to the last save must not undo newer typing.
  useEffect(() => { if (!focused.current) setDraft(value) }, [value])
  const commit = () => { focused.current = false; if (draft !== value) onCommit(draft) }
  return (
    <Field
      value={draft}
      placeholder={placeholder}
      editable={!disabled}
      accessibilityLabel={label}
      keyboardType={numeric ? 'decimal-pad' : 'default'}
      returnKeyType="done"
      onChangeText={setDraft}
      onFocus={() => { focused.current = true }}
      onEndEditing={commit}
      style={width ? { width, textAlign: 'right' } : { flex: 1 }}
    />
  )
}

const PATH_HINT: Record<string, string> = {
  claude: '~/.t3-something (or the dir holding .credentials.json)',
  codex: '~/.t3-something/.codex',
  cursor: '~/.t3-something/.config/cursor/auth.json',
}

function AddProfile({ backend, saving, onPatch }: { backend: string; saving: boolean; onPatch: (p: any) => void }) {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [home, setHome] = useState('')
  if (!open) return <Row title="Add a profile" tone="accent" icon={<Hi icon={PlusIcon} size={15} color={colors.accent} />} onPress={() => setOpen(true)} disabled={saving} />
  const submit = () => {
    if (!label.trim() || !home.trim()) return
    onPatch({ addAccount: { backend, label: label.trim(), path: home.trim() } })
    setLabel(''); setHome(''); setOpen(false)
  }
  return (
    <Row title="Add a profile" description="A profile auto-discovery does not find. Cursor takes its auth.json; the rest take the profile directory." stacked>
      <View style={{ gap: 8 }}>
        <Field placeholder="Name (e.g. work)" value={label} onChangeText={setLabel} accessibilityLabel="Profile name" />
        <Field mono placeholder={PATH_HINT[backend] || '~/profile-dir'} value={home} onChangeText={setHome} accessibilityLabel="Profile path" />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn title="Add" disabled={saving || !label.trim() || !home.trim()} onPress={submit} />
          <Btn title="Cancel" kind="ghost" onPress={() => setOpen(false)} />
        </View>
      </View>
    </Row>
  )
}

function BackendSection({ backend, saving, onPatch }: { backend: any; saving: boolean; onPatch: (p: any) => void }) {
  const patchProvider = (patch: any) => onPatch({ providers: { [backend.id]: patch } })
  const visible = backend.accounts.filter((a: any) => !a.hidden).length
  return (
    <Section
      title={backend.name}
      action={<Pill label={backend.hidden ? 'Hidden' : `${visible} of ${backend.accounts.length} tracked`} />}
    >
      <Row
        icon={<ProviderLogo driver={backend.id} name={backend.name} size={16} />}
        title="Show in Usage"
        description={backend.hidden ? `${backend.name} is hidden everywhere in Usage.` : undefined}
        control={<Switch label={`Show ${backend.name} in Usage`} value={!backend.hidden} disabled={saving} onChange={(v) => patchProvider({ hidden: !v })} />}
      />
      <Row title="Name" control={<CommitField label="Service name" width={160} value={backend.name} placeholder={backend.defaultName} onCommit={(v) => patchProvider({ name: v })} />} />
      <Row title="Plan" control={<CommitField label="Plan" width={140} value={backend.plan || ''} placeholder="auto" onCommit={(v) => patchProvider({ plan: v })} />} />
      <Row title="Price / month" description="In dollars." control={<CommitField label="Price per month" numeric width={100} value={backend.priceUsd == null ? '' : String(backend.priceUsd)} placeholder="auto" onCommit={(v) => patchProvider({ priceUsd: v === '' ? null : v })} />} />
      <Row title="Renews" description="YYYY-MM-DD." control={<CommitField label="Renewal date" width={130} value={(backend.renewsAt || '').slice(0, 10)} placeholder="auto" onCommit={(v) => patchProvider({ renewsAt: v === '' ? null : v })} />} />
      {backend.accounts.map((a: any) => {
        const failed = a.status && a.status !== 'ok'
        return (
          <Row
            key={a.id}
            title={a.displayName || a.label}
            stacked
            description={[a.email, a.plan, !a.discovered ? 'manual' : '', a.hidden ? 'hidden' : '', failed ? `${a.status}${a.error ? `: ${a.error}` : ''}` : ''].filter(Boolean).join(' · ') || undefined}
          >
            <View style={{ gap: 8 }}>
              <Code>{a.path || a.label}</Code>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <CommitField label={`Name for ${a.label}`} value={a.displayName || ''} placeholder={a.label} onCommit={(v) => onPatch({ accountNames: { [a.id]: v } })} />
                <IconBtn
                  icon={a.hidden ? EyeSlashIcon : EyeIcon}
                  label={a.hidden ? 'Show this profile' : 'Hide this profile'}
                  disabled={saving}
                  color={a.hidden ? colors.muted : colors.text}
                  onPress={() => onPatch({ hidden: { [a.id]: !a.hidden } })}
                />
                {!a.discovered ? (
                  <IconBtn
                    icon={TrashIcon}
                    label="Remove this profile"
                    color={colors.red}
                    disabled={saving}
                    onPress={async () => { if (await confirm(`Remove ${a.displayName || a.label}?`, { message: 'Totem stops polling this manually added profile.', confirmLabel: 'Remove' })) onPatch({ removeAccount: a.id }) }}
                  />
                ) : null}
              </View>
            </View>
          </Row>
        )
      })}
      {!backend.accounts.length ? <Row title={`No ${backend.name} login found on this server.`} /> : null}
      <AddProfile backend={backend.id} saving={saving} onPatch={onPatch} />
    </Section>
  )
}

export default function UsageTrackingScreen() {
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    getAiUsageConfig().then((d) => { setData(d); setErr(null) }).catch((e) => { if (!(e instanceof AuthError)) setErr(e.message) })
  }, [])

  // Saving re-runs discovery and re-polls on the bridge, so one request at a time.
  const patch = useCallback((body: any) => {
    const run = async () => {
      setSaving(true)
      setErr(null)
      try {
        setData(await setAiUsageConfig(body))
      } catch (e: any) {
        if (!(e instanceof AuthError)) setErr(e.message)
      } finally {
        setSaving(false)
      }
    }
    queue.current = queue.current.then(run, run)
    return queue.current
  }, [])

  return (
    <PaneScroll>
      {err ? <Notice tone="error">{err}</Notice> : null}
      {!data ? (err ? null : <Loading label="Loading settings…" />) : (
        <>
          <Section title="Polling" description={`Saved to ${data.configPath} on the server.`}>
            <Row
              title="Poll every"
              description="Seconds between reads while nobody is watching."
              control={<CommitField label="Poll interval in seconds" numeric width={80} value={String(data.pollIntervalSeconds)} onCommit={(v) => patch({ pollIntervalSeconds: v })} />}
            />
            <Row
              title="Auto-discover profiles"
              description={data.autoDiscover ? 'Finds ~/.claude, ~/.codex, ~/.config/cursor and any ~/.t3-* profile.' : 'Only the profiles listed below are polled.'}
              control={<Switch label="Auto-discover profiles" value={!!data.autoDiscover} disabled={saving} onChange={(v) => patch({ autoDiscover: v })} />}
            />
            <Row
              title="Claude quota polling"
              description={data.claudeOAuthFromEnv
                ? 'Set by AI_USAGE_CLAUDE_OAUTH on the server.'
                : 'Uses an undocumented Anthropic endpoint and refreshes Claude Code’s own login with its built-in client id. Off unless you turn it on.'}
              control={<Switch label="Claude quota polling" value={!!data.claudeOAuthUsage} disabled={saving || data.claudeOAuthFromEnv} onChange={(v) => patch({ claudeOAuthUsage: v })} />}
            />
            <Row
              title="Cursor quota polling"
              description={data.cursorUsageFromEnv
                ? 'Set by AI_USAGE_CURSOR on the server.'
                : 'Uses Cursor’s private usage endpoint with the token cursor-agent stores. Off unless you turn it on.'}
              control={<Switch label="Cursor quota polling" value={!!data.cursorUsage} disabled={saving || data.cursorUsageFromEnv} onChange={(v) => patch({ cursorUsage: v })} />}
            />
          </Section>
          {(data.backends || []).map((b: any) => <BackendSection key={b.id} backend={b} saving={saving} onPatch={patch} />)}
          {saving ? <T size={12.5} muted style={{ textAlign: 'center' }}>Saving…</T> : null}
        </>
      )}
    </PaneScroll>
  )
}
