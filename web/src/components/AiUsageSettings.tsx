/**
 * Settings for everything the Usage section shows.
 *
 * Discovery is right until real life changes — a second profile starts pointing
 * at the same account, a login dies, a plan moves. Rather than editing the
 * bridge for that, this panel writes `data/ai-usage.json` (see
 * bridge.mjs ▸ AI usage settings): display names, what to hide, subscription
 * price/renewal overrides, and how often to poll.
 *
 * Text fields commit on blur/Enter; toggles commit immediately. Every save
 * returns the refreshed settings, and `onChanged` lets the Usage panels above
 * re-read themselves so a rename or a hide shows up straight away.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { getAiUsageConfig, setAiUsageConfig, AuthError } from '../api'
import { ProductIcon } from '../usageMeta'
import { Hi, EyeIcon, EyeSlashIcon, PlusIcon, TrashIcon, WarnIcon } from '../icons'

type Backend = any
type Account = any

// A text input that only reports a change once it's actually finished being typed.
function CommitField({ value, onCommit, placeholder, disabled, type = 'text', width }: {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  disabled?: boolean
  type?: string
  width?: number
}) {
  const [draft, setDraft] = useState(value)
  // Follow the server once a save lands (or another edit refreshes the payload).
  useEffect(() => { setDraft(value) }, [value])
  const commit = () => { if (draft !== value) onCommit(draft) }
  return (
    <input
      className="usage-set-input"
      type={type}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      style={width ? { width } : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setDraft(value)
      }}
    />
  )
}

function HideButton({ hidden, disabled, onClick, what }: { hidden: boolean; disabled?: boolean; onClick: () => void; what: string }) {
  return (
    <button
      className={`model-icon-btn ${hidden ? 'off' : ''}`}
      disabled={disabled}
      onClick={onClick}
      title={hidden ? `Show ${what}` : `Hide ${what}`}
      aria-label={hidden ? `Show ${what}` : `Hide ${what}`}
    >
      <Hi icon={hidden ? EyeSlashIcon : EyeIcon} size={16} />
    </button>
  )
}

// One tracked profile: what to call it, whether it's polled, and who it is.
function AccountRow({ account, saving, onPatch }: { account: Account; saving: boolean; onPatch: (patch: any) => void }) {
  const failed = account.status && account.status !== 'ok'
  return (
    <div className={`usage-set-account ${account.hidden ? 'is-hidden' : ''}`}>
      <span className={`provider-led ${account.status === 'ok' ? 'ok' : ''}`} />
      <CommitField
        value={account.displayName || ''}
        placeholder={account.label}
        disabled={saving}
        onCommit={(v) => onPatch({ accountNames: { [account.id]: v } })}
      />
      <div className="usage-set-account-meta muted">
        <code>{account.path || account.label}</code>
        {account.email && <span>{account.email}</span>}
        {account.plan && <span className="pill">{account.plan}</span>}
        {!account.discovered && <span className="pill">manual</span>}
        {account.hidden && <span className="pill">hidden</span>}
        {failed && <span className="inline-warn"><WarnIcon /> {account.status}</span>}
      </div>
      <div className="usage-set-account-actions">
        <HideButton
          hidden={account.hidden}
          disabled={saving}
          onClick={() => onPatch({ hidden: { [account.id]: !account.hidden } })}
          what="this profile"
        />
        {!account.discovered && (
          <button
            className="model-icon-btn danger"
            disabled={saving}
            onClick={() => onPatch({ removeAccount: account.id })}
            title="Remove this manually-added profile"
            aria-label="Remove profile"
          >
            <Hi icon={TrashIcon} size={15} />
          </button>
        )}
      </div>
      {failed && account.error && <div className="usage-set-account-error muted">{account.error}</div>}
    </div>
  )
}

// Manually point at a profile auto-discovery doesn't find (a Claude/Codex home
// outside ~, a second Cursor login). Cursor takes its auth.json; the rest take
// the profile directory.
const PATH_HINT: Record<string, string> = {
  claude: '~/.t3-something (or the dir holding .credentials.json)',
  codex: '~/.t3-something/.codex',
  cursor: '~/.t3-something/.config/cursor/auth.json',
}

function AddAccountForm({ backend, saving, onPatch }: { backend: string; saving: boolean; onPatch: (patch: any) => void }) {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [home, setHome] = useState('')

  if (!open) {
    return (
      <button className="btn compact usage-set-add" disabled={saving} onClick={() => setOpen(true)}>
        <Hi icon={PlusIcon} size={14} /> Add a profile
      </button>
    )
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!label.trim() || !home.trim()) return
    onPatch({ addAccount: { backend, label: label.trim(), path: home.trim() } })
    setLabel(''); setHome(''); setOpen(false)
  }

  return (
    <form className="usage-set-add-form" onSubmit={submit}>
      <input
        className="usage-set-input"
        placeholder="Name (e.g. work)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        disabled={saving}
      />
      <input
        className="usage-set-input grow"
        placeholder={PATH_HINT[backend] || '~/profile-dir'}
        value={home}
        onChange={(e) => setHome(e.target.value)}
        disabled={saving}
      />
      <button type="submit" className="btn compact" disabled={saving || !label.trim() || !home.trim()}>Add</button>
      <button type="button" className="btn compact" disabled={saving} onClick={() => setOpen(false)}>Cancel</button>
    </form>
  )
}

// One service (Claude / Codex / Cursor): its card title, subscription facts the
// vendor doesn't publish, and the profiles polled underneath it.
function BackendCard({ backend, saving, onPatch }: { backend: Backend; saving: boolean; onPatch: (patch: any) => void }) {
  const patchProvider = (patch: any) => onPatch({ providers: { [backend.id]: patch } })
  const visible = backend.accounts.filter((a: Account) => !a.hidden).length
  return (
    <section className={`usage-set-card ${backend.hidden ? 'is-hidden' : ''}`}>
      <div className="usage-set-card-head">
        <ProductIcon id={backend.id} title={backend.name} />
        <CommitField
          value={backend.name}
          placeholder={backend.defaultName}
          disabled={saving}
          onCommit={(v) => patchProvider({ name: v })}
        />
        <span className="muted usage-set-count">
          {backend.hidden
            ? 'hidden from Usage'
            : `${visible} of ${backend.accounts.length} profile${backend.accounts.length === 1 ? '' : 's'} tracked`}
        </span>
        <HideButton
          hidden={backend.hidden}
          disabled={saving}
          onClick={() => patchProvider({ hidden: !backend.hidden })}
          what={`${backend.name} everywhere in Usage`}
        />
      </div>

      <div className="usage-set-fields">
        <label className="usage-set-field">
          <span>Plan</span>
          <CommitField
            value={backend.plan || ''}
            placeholder="auto"
            disabled={saving}
            onCommit={(v) => patchProvider({ plan: v })}
          />
        </label>
        <label className="usage-set-field">
          <span>Price / mo</span>
          <CommitField
            value={backend.priceUsd == null ? '' : String(backend.priceUsd)}
            placeholder="auto"
            type="number"
            width={90}
            disabled={saving}
            onCommit={(v) => patchProvider({ priceUsd: v === '' ? null : v })}
          />
        </label>
        <label className="usage-set-field">
          <span>Renews</span>
          <CommitField
            value={(backend.renewsAt || '').slice(0, 10)}
            placeholder="auto"
            type="date"
            disabled={saving}
            onCommit={(v) => patchProvider({ renewsAt: v === '' ? null : v })}
          />
        </label>
      </div>

      <div className="usage-set-accounts">
        {backend.accounts.map((a: Account) => (
          <AccountRow key={a.id} account={a} saving={saving} onPatch={onPatch} />
        ))}
        {!backend.accounts.length && (
          <div className="muted usage-set-empty">No {backend.name} login found on this box.</div>
        )}
      </div>
      <AddAccountForm backend={backend.id} saving={saving} onPatch={onPatch} />
    </section>
  )
}

export default function AiUsageSettings({ onAuthError, onChanged }: { onAuthError: () => void; onChanged?: () => void }) {
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getAiUsageConfig()
      .then((d) => { setData(d); setErr(null) })
      .catch((e) => { if (e instanceof AuthError) onAuthError(); else setErr(e.message) })
  }, [onAuthError])

  // Saving re-runs discovery and re-polls on the bridge, so it is deliberately
  // one request at a time — the response is the new truth for the whole panel.
  const patch = useCallback(async (body: any) => {
    setSaving(true)
    setErr(null)
    try {
      setData(await setAiUsageConfig(body))
      onChanged?.()
    } catch (e: any) {
      if (e instanceof AuthError) onAuthError()
      else setErr(e.message)
    } finally {
      setSaving(false)
    }
  }, [onAuthError, onChanged])

  if (err && !data) return <div className="muted inline-warn"><WarnIcon /> {err}</div>
  if (!data) return <div className="muted">Loading settings…</div>

  return (
    <div className="usage-settings">
      {err && <div className="muted inline-warn"><WarnIcon /> {err}</div>}

      <div className="usage-set-globals">
        <label className="usage-set-field">
          <span>Poll every</span>
          <CommitField
            value={String(data.pollIntervalSeconds)}
            type="number"
            width={80}
            disabled={saving}
            onCommit={(v) => patch({ pollIntervalSeconds: v })}
          />
          <em className="muted">seconds</em>
        </label>
        <label className="usage-set-field">
          <span>Auto-discover profiles</span>
          <button
            type="button"
            role="switch"
            aria-checked={data.autoDiscover}
            aria-label="Auto-discover profiles"
            disabled={saving}
            className={`switch ${data.autoDiscover ? 'on' : ''}`}
            onClick={() => patch({ autoDiscover: !data.autoDiscover })}
          >
            <span />
          </button>
          <em className="muted">
            {data.autoDiscover
              ? 'Finds ~/.claude, ~/.codex, ~/.config/cursor and any ~/.t3-* profile.'
              : 'Only the profiles listed below are polled.'}
          </em>
        </label>
        <label className="usage-set-field">
          <span>Claude quota polling</span>
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(data.claudeOAuthUsage)}
            aria-label="Claude quota polling"
            disabled={saving || data.claudeOAuthFromEnv}
            className={`switch ${data.claudeOAuthUsage ? 'on' : ''}`}
            onClick={() => patch({ claudeOAuthUsage: !data.claudeOAuthUsage })}
          >
            <span />
          </button>
          <em className="muted">
            {data.claudeOAuthFromEnv
              ? 'Set by AI_USAGE_CLAUDE_OAUTH on the server.'
              : 'Uses an undocumented Anthropic endpoint and refreshes Claude Code\'s own login with its built-in client id. Off unless you turn it on.'}
          </em>
        </label>
        <label className="usage-set-field">
          <span>Cursor quota polling</span>
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(data.cursorUsage)}
            aria-label="Cursor quota polling"
            disabled={saving || data.cursorUsageFromEnv}
            className={`switch ${data.cursorUsage ? 'on' : ''}`}
            onClick={() => patch({ cursorUsage: !data.cursorUsage })}
          >
            <span />
          </button>
          <em className="muted">
            {data.cursorUsageFromEnv
              ? 'Set by AI_USAGE_CURSOR on the server.'
              : 'Uses Cursor\'s private usage endpoint with the token cursor-agent stores. Off unless you turn it on.'}
          </em>
        </label>
      </div>

      {data.backends.map((b: Backend) => (
        <BackendCard key={b.id} backend={b} saving={saving} onPatch={patch} />
      ))}

      <div className="muted usage-set-foot">Saved to <code>{data.configPath}</code></div>
    </div>
  )
}
