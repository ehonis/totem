// Journal settings, as a modal.
//
// It used to be a panel that pushed the whole view down the page, which made
// changing one number feel like navigating somewhere. Same `.modal-backdrop` +
// `.event-modal` shell the goal composer uses, so it dismisses on backdrop click
// and Escape and looks like the rest of the app.
//
// The one non-obvious control is the model picker. Every other scheduled job takes
// whatever the Providers tab has as the default, and for most that is right — but
// the digest reads twenty minutes of rambling and has to come back with the right
// five facts, which is a different job from answering a phone request fast. Empty
// means "use the default", so an untouched install behaves as before.
import React, { useEffect, useMemo, useState } from 'react'
import { getAgentModels } from '../api'
import { ExclamationTriangleIcon, Hi, XMarkIcon } from '../icons'
import type { AgentProvider, JournalSettings } from './types'

interface Props {
  settings: JournalSettings
  busy?: boolean
  onSave: (patch: Partial<JournalSettings>) => Promise<void> | void
  onClose: () => void
}

export default function JournalSettingsModal({ settings, busy = false, onSave, onClose }: Props) {
  const [minutes, setMinutes] = useState(String(settings.ingestDelayMinutes))
  const [keepDays, setKeepDays] = useState(String(settings.keepAudioDays))
  const [vocab, setVocab] = useState(settings.vocabulary)
  const [provider, setProvider] = useState(settings.provider)
  const [model, setModel] = useState(settings.model)
  const [effort, setEffort] = useState(settings.effort)
  const [providers, setProviders] = useState<AgentProvider[] | null>(null)
  const [catalogError, setCatalogError] = useState('')

  // The catalog is a few CLI calls behind the bridge, so the form is usable before
  // it lands: the current choice is shown as-is until the real list replaces it.
  useEffect(() => {
    let cancelled = false
    getAgentModels()
      .then((data) => { if (!cancelled) setProviders(data.providers) })
      .catch((e) => { if (!cancelled) setCatalogError(e instanceof Error ? e.message : 'Model list unavailable.') })
    return () => { cancelled = true }
  }, [])

  const chosen = useMemo(
    () => providers?.find((p) => p.provider === (provider || providers.find((x) => x.isDefault)?.provider)) || null,
    [providers, provider],
  )
  const defaultProviderName = providers?.find((p) => p.isDefault)?.name || 'the default'
  const chosenModel = chosen?.models.find((m) => m.id === model) || null
  const reasoningLevels = chosenModel?.reasoningLevels?.length ? chosenModel.reasoningLevels : []

  const dirty =
    Number(minutes) !== settings.ingestDelayMinutes ||
    Number(keepDays) !== settings.keepAudioDays ||
    vocab !== settings.vocabulary ||
    provider !== settings.provider ||
    model !== settings.model ||
    effort !== settings.effort

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    void onSave({
      ingestDelayMinutes: Number(minutes),
      keepAudioDays: Number(keepDays),
      vocabulary: vocab,
      provider,
      model,
      // A reasoning level the chosen model does not offer is worse than none.
      effort: reasoningLevels.includes(effort) ? effort : '',
    })
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="event-modal journal-settings-modal"
        role="dialog" aria-modal="true" aria-labelledby="journal-settings-title"
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
      >
        <div className="modal-head">
          <div>
            <div className="modal-kicker">Voice journal</div>
            <h2 id="journal-settings-title">Journal settings</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Hi icon={XMarkIcon} size={20} /></button>
        </div>

        <label className="field">
          Don’t-ingest window
          <span className="journal-setting-row">
            <input type="number" min={0} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} autoFocus />
            <span className="muted">minutes after Save</span>
          </span>
          <small className="muted">The digest waits this long so you can stop it. Zero runs it as soon as the transcript exists.</small>
        </label>

        <label className="field">
          Keep recordings for
          <span className="journal-setting-row">
            <input type="number" min={0} max={365} value={keepDays} onChange={(e) => setKeepDays(e.target.value)} />
            <span className="muted">days after transcribing</span>
          </span>
          <small className="muted">
            The transcript is the permanent record; the audio is a grace period in case you want to keep a copy.
            Zero deletes it the moment the words exist. Individual entries can be kept for good from their ⋯ menu.
          </small>
        </label>

        <label className="field">
          Names &amp; words to spell right
          <textarea rows={2} value={vocab} onChange={(e) => setVocab(e.target.value)} placeholder="Names, places and projects you mention…" />
          <small className="muted">Handed to whisper as a hint. People, places, products — anything it keeps mishearing.</small>
        </label>

        <fieldset className="journal-model">
          <legend>Which AI digests an entry</legend>
          <div className="journal-model-row">
            <label className="field">
              Agent
              <select
                value={provider}
                onChange={(e) => { setProvider(e.target.value); setModel(''); setEffort('') }}
              >
                <option value="">Default ({defaultProviderName})</option>
                {(providers || []).map((p) => (
                  <option key={p.provider} value={p.provider}>
                    {p.name}{p.state !== 'ready' && p.state !== 'unknown' ? ` — ${p.state}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Model
              <select value={model} onChange={(e) => { setModel(e.target.value); setEffort('') }} disabled={!chosen}>
                <option value="">{chosen ? `Default${chosen.models.find((m) => m.recommended) ? ` (${chosen.models.find((m) => m.recommended)!.name})` : ''}` : 'Default'}</option>
                {/* A model saved before the catalog moved on still shows, rather than
                    silently reading as "Default" while the digest uses it. */}
                {model && !chosen?.models.some((m) => m.id === model) && <option value={model}>{model} (not in the current list)</option>}
                {(chosen?.models || []).map((m) => (
                  <option key={m.id} value={m.id}>{m.name}{m.recommended ? ' — recommended' : ''}</option>
                ))}
              </select>
            </label>
            {reasoningLevels.length > 0 && (
              <label className="field">
                Thinking
                <select value={effort} onChange={(e) => setEffort(e.target.value)}>
                  <option value="">Default{chosenModel?.defaultReasoning ? ` (${chosenModel.defaultReasoning})` : ''}</option>
                  {reasoningLevels.map((level) => <option key={level} value={level}>{level}</option>)}
                </select>
              </label>
            )}
          </div>
          {chosen && chosen.state !== 'ready' && chosen.state !== 'unknown' && (
            <p className="journal-model-warn">
              <Hi icon={ExclamationTriangleIcon} size={13} />
              {chosen.name} is {chosen.state}{chosen.fix ? ` — ${chosen.fix}` : ''}. Digests will fail until that is fixed.
            </p>
          )}
          {catalogError && <p className="journal-model-warn"><Hi icon={ExclamationTriangleIcon} size={13} /> {catalogError}</p>}
          <small className="muted">
            Leave these on Default to follow the Providers tab. The digest is a background job with a 30-minute
            budget, so a slower, more careful model is a fair trade here.
          </small>
        </fieldset>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!dirty || busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  )
}
