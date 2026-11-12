import React from 'react'
import { Hi, ArrowPathIcon } from '../../icons'
import { SettingsRow as Row, SettingsSection } from './ui'

// Settings → Providers › Defaults: the account and model a new chat, the phone
// shortcut and a totem run on when they name none.

type Provider = any

// The free platform default. Paid providers fall back to it on usage limits
// (mirrors FALLBACK_PROVIDER in bridge.mjs).
export const FALLBACK_PROVIDER = 'opencode'

// The default-model picker for the default account. defaultModel may carry param
// brackets (e.g. composer-2.5[fast=true]) so the dropdown matches on the bare id.
function DefaultModelPicker({ defaultModel, models, saving, onChange }: {
  defaultModel?: string
  models: any[]
  saving: string | null
  onChange: (model: string) => void
}) {
  const baseId = (defaultModel || '').split('[')[0]
  return (
    <select
      className="model-select"
      value={baseId}
      disabled={saving === 'defaultModel'}
      onChange={(e) => onChange(e.target.value)}
    >
      {!models.some((m) => m.id === baseId) && baseId && <option value={baseId}>{baseId}</option>}
      {!baseId && <option value="">Provider default</option>}
      {models.map((m) => (
        <option key={m.id} value={m.id}>{m.name}{m.recommended ? ' (recommended)' : ''}</option>
      ))}
    </select>
  )
}

export default function ProviderDefaults({ providers, defaultModel, models, saving, checkedAt, onRefresh, onMakeDefault, onChangeModel }: {
  providers: Provider[]
  defaultModel?: string
  /** The default account's model catalog. */
  models: any[]
  saving: string | null
  checkedAt?: string
  onRefresh: () => void
  onMakeDefault: (p: Provider) => void
  onChangeModel: (model: string) => void
}) {
  const defaultAccount = providers.find((p) => p.default) || null
  const candidates = providers.filter((p) => p.installed && (p.enabled || p.default))
  const checked = checkedAt ? new Date(checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
  return (
    <SettingsSection
      id="defaults"
      title="Defaults"
      description="What a new chat, the phone shortcut and a totem run on when they name no account."
      action={
        <>
          {checked && <span className="muted ss-meta">Checked {checked}</span>}
          <button className="icon-btn small" onClick={onRefresh} title="Check accounts again" aria-label="Check accounts again"><Hi icon={ArrowPathIcon} size={16} /></button>
        </>
      }
    >
      <Row
        id="default-account"
        title="Default account"
        description={defaultAccount && defaultAccount.id !== FALLBACK_PROVIDER
          ? `When it hits a usage limit, requests fall back to ${providers.find((p) => p.id === FALLBACK_PROVIDER)?.name || 'OpenCode'}.`
          : 'Only accounts that are installed and switched on can be the default.'}
        control={
          <select className="model-select" aria-label="Default account" value={defaultAccount?.id || ''} disabled={!!saving}
            onChange={(e) => { const p = providers.find((x) => x.id === e.target.value); if (p) onMakeDefault(p) }}>
            {!defaultAccount && <option value="">None</option>}
            {candidates.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        }
      />
      {defaultAccount?.supportsModelPicker && (
        <Row
          id="default-model"
          title="Default model"
          description={`On ${defaultAccount.name}. A chat can still pick another in the composer.`}
          control={<DefaultModelPicker defaultModel={defaultModel} models={models} saving={saving} onChange={onChangeModel} />}
        />
      )}
    </SettingsSection>
  )
}
