import React, { useCallback, useEffect, useState } from 'react'
import { ApiError, AuthError, getAiSettings, getChatModels, saveAiSettings, testAi } from '../api'
import type { AiSettings as AiSettingsData } from '../api'

/*
 * Settings -> AI. Totem's AI is an agent CLI on this machine (Codex, Claude Code,
 * OpenCode, Cursor). This page picks which one answers by default, shows whether
 * it is installed and signed in, takes an API key where the CLI accepts one, and
 * runs a one-line test. Accounts, per-account environments and streaming live on
 * the Providers tab.
 */

type TestResult = { ok: boolean; ms: number; reply?: string; error?: string }

function errorText(e: unknown) {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
}

function stateLabel(p: AiSettingsData['providers'][number]) {
  if (!p.installed) return 'Not installed'
  if (p.loggedIn === true) return 'Signed in'
  if (p.loggedIn === false) return 'Not signed in'
  return 'Installed'
}

export default function AiSettings({ onAuthError }: { onAuthError: () => void }) {
  const [data, setData] = useState<AiSettingsData | null>(null)
  const [error, setError] = useState('')
  const [models, setModels] = useState<{ id: string; label?: string; name?: string }[]>([])
  const [model, setModel] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [tests, setTests] = useState<Record<string, TestResult | 'running'>>({})
  const [saving, setSaving] = useState(false)

  const fail = useCallback((e: unknown) => {
    if (e instanceof AuthError) return onAuthError()
    setError(errorText(e))
  }, [onAuthError])

  const load = useCallback(() => {
    getAiSettings().then((d) => { setData(d); setModel(d.defaultModel || '') }).catch(fail)
  }, [fail])
  useEffect(load, [load])

  useEffect(() => {
    if (!data?.defaultProvider) return
    getChatModels(data.defaultProvider)
      .then((r: { models?: { id: string; label?: string; name?: string }[] }) => setModels(r.models || []))
      .catch(() => setModels([]))
  }, [data?.defaultProvider])

  async function save(patch: Parameters<typeof saveAiSettings>[0]) {
    setSaving(true)
    setError('')
    try {
      const next = await saveAiSettings(patch)
      setData(next)
      setModel(next.defaultModel || '')
    } catch (e) {
      fail(e)
    } finally {
      setSaving(false)
    }
  }

  async function runTest(provider: string) {
    setTests((t) => ({ ...t, [provider]: 'running' }))
    try {
      const r = await testAi(provider)
      setTests((t) => ({ ...t, [provider]: r }))
    } catch (e) {
      setTests((t) => ({ ...t, [provider]: { ok: false, ms: 0, error: errorText(e) } }))
    }
  }

  if (!data) {
    return (
      <div className="settings-pane">
        <header className="settings-pane-head"><h2>AI</h2></header>
        <p className="text-muted">{error || 'Checking which AI tools are installed…'}</p>
      </div>
    )
  }

  return (
    <div className="settings-pane">
      <header className="settings-pane-head">
        <h2>AI</h2>
        <p>
          Totem runs its AI through a command-line agent installed on this machine. Pick the default one, sign it in
          (or give it an API key), choose a model, and test it.
        </p>
      </header>

      {!data.configured && (
        <div className="setting-list"><div className="setting-row"><div className="setting-copy">
          <strong>No AI is set up yet</strong>
          <span>
            Install one of the CLIs below and sign it in on this machine, or add an API key. Until then chat, the phone
            shortcut and AI jobs answer with a pointer back to this page; everything else works.
          </span>
        </div></div></div>
      )}
      {error && <p className="text-[var(--danger,#e5484d)]">{error}</p>}

      <div className="settings-section-title"><span /><strong>Default provider</strong></div>
      <div className="setting-list">
        {data.providers.map((p) => {
          const test = tests[p.id]
          return (
            <div className="setting-row" key={p.id}>
              <div className="setting-copy">
                <strong>
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="ai-default" checked={data.defaultProvider === p.id} disabled={saving}
                      onChange={() => save({ defaultProvider: p.id, defaultModel: null })} />
                    {p.label}
                  </label>
                </strong>
                <span>
                  {stateLabel(p)}{p.detail ? ` — ${p.detail}` : ''}
                  {p.fix && <> · fix: <code>{p.fix}</code></>}
                </span>
                {test && test !== 'running' && (
                  <span className={test.ok ? '' : 'text-[var(--danger,#e5484d)]'}>
                    {test.ok ? `Test passed in ${(test.ms / 1000).toFixed(1)}s.` : `Test failed: ${test.error || test.reply || 'no reply'}`}
                  </span>
                )}
              </div>
              <div className="setting-control">
                <button className="btn" disabled={test === 'running' || !p.installed} onClick={() => runTest(p.id)}>
                  {test === 'running' ? 'Testing…' : 'Test'}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="settings-section-title"><span /><strong>Model</strong></div>
      <div className="setting-list">
        <div className="setting-row">
          <div className="setting-copy">
            <strong>Default model</strong>
            <span>Leave empty to use the CLI's own default.</span>
          </div>
          <div className="setting-control flex gap-2">
            <input className="model-select" list="ai-models" value={model} placeholder="CLI default"
              onChange={(e) => setModel(e.target.value)} />
            <datalist id="ai-models">
              {models.map((m) => <option key={m.id} value={m.id}>{m.label || m.name || m.id}</option>)}
            </datalist>
            <button className="btn" disabled={saving || model === (data.defaultModel || '')}
              onClick={() => save({ defaultModel: model.trim() || null })}>Save</button>
          </div>
        </div>
      </div>

      <div className="settings-section-title"><span /><strong>API keys</strong></div>
      <div className="setting-list">
        {data.keys.map((k) => (
          <div className="setting-row" key={k.name}>
            <div className="setting-copy">
              <strong>{k.label}</strong>
              <span>
                <code>{k.name}</code>, passed to {k.providers.join(' and ')}.{' '}
                {k.source === 'env' && <>Set in the server environment ({k.masked}); change it there.</>}
                {k.source === 'settings' && <>Saved here ({k.masked}).</>}
                {!k.source && 'Not set. Optional if the CLI is signed in with a subscription.'}
              </span>
            </div>
            {k.source !== 'env' && (
              <div className="setting-control flex gap-2">
                <input className="model-select" type="password" autoComplete="off" placeholder={k.source ? 'Replace…' : 'Paste key'}
                  value={drafts[k.name] || ''} onChange={(e) => setDrafts((d) => ({ ...d, [k.name]: e.target.value }))} />
                <button className="btn" disabled={saving || !drafts[k.name]}
                  onClick={() => save({ keys: { [k.name]: drafts[k.name] } }).then(() => setDrafts((d) => ({ ...d, [k.name]: '' })))}>
                  Save
                </button>
                {k.source === 'settings' && (
                  <button className="btn danger" disabled={saving} onClick={() => save({ keys: { [k.name]: null } })}>Remove</button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
