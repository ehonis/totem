import React, { useEffect, useMemo, useState } from 'react'
import { Hi, SparklesIcon, ExclamationTriangleIcon, CheckIcon, XMarkIcon } from '../icons'
import { reviseSkill, getSkillReviseModels, AuthError } from '../api'
import { pushError } from '../toast'
import { lineDiff, diffHunks, diffStats } from './lineDiff'

// "Ask AI to change this" for a skill's instructions.
//
// The awkward edits are the ones worth having help with — "make step 4 stricter
// about duplicates", "stop it committing", "say this in half the words" — and
// they are exactly the ones that are miserable to make by hand in a textarea
// holding a sixty-line prompt.
//
// Two rules shape the whole component:
//
//   - **Nothing is saved.** The request comes back as a proposal, the diff is
//     shown, and Apply only fills the textarea. Save is still Save, and Reset to
//     default is still there if it all goes wrong.
//   - **The diff is the product.** An AI edit you cannot see is a rewrite you
//     have to re-read from scratch to trust. So the response is rendered as
//     hunks with context, with the add/remove counts stated.

interface ReviseModel {
  id: string
  name: string
  reasoningLevels: string[]
  defaultReasoning: string | null
  recommended: boolean
}

interface ReviseProvider {
  provider: string
  name: string
  state: string
  fix: string | null
  models: ReviseModel[]
}

interface Proposal {
  before: string
  after: string
  instruction: string
  provider: string
  model: string
  effort: string
  ms: number
  changed: boolean
  note: string | null
}

interface Props {
  skillId: string
  /** The body currently in the editor, saved or not — that is what gets revised. */
  body: string
  onApply: (next: string) => void
  onAuthError?: () => void
}

export default function SkillReviser({ skillId, body, onApply, onAuthError }: Props) {
  const [providers, setProviders] = useState<ReviseProvider[] | null>(null)
  const [providerId, setProviderId] = useState('')
  const [modelId, setModelId] = useState('')
  const [effort, setEffort] = useState('')
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [proposal, setProposal] = useState<Proposal | null>(null)

  // The catalog is live (codex's model list comes from the CLI's own cache), so
  // it is fetched rather than hardcoded — the same reason the job editor does it.
  useEffect(() => {
    let alive = true
    getSkillReviseModels()
      .then((d) => {
        if (!alive) return
        const list: ReviseProvider[] = d?.providers || []
        setProviders(list)
        const first = list.find((p) => p.state === 'ready' && p.models.length) || list.find((p) => p.models.length)
        if (first) {
          const m = first.models.find((x) => x.recommended) || first.models[0]
          setProviderId(first.provider)
          setModelId(m?.id || '')
          setEffort(m?.defaultReasoning || 'medium')
        }
      })
      .catch((e) => {
        if (e instanceof AuthError) return onAuthError?.()
        if (alive) setProviders([])
      })
    return () => { alive = false }
  }, [onAuthError])

  // A new skill opened in the same panel should not inherit the last one's diff.
  useEffect(() => { setProposal(null); setInstruction('') }, [skillId])

  const provider = providers?.find((p) => p.provider === providerId) || null
  const model = provider?.models.find((m) => m.id === modelId) || null
  const levels = model?.reasoningLevels?.length ? model.reasoningLevels : ['low', 'medium', 'high']

  function pickProvider(id: string) {
    const p = providers?.find((x) => x.provider === id)
    const m = p?.models.find((x) => x.recommended) || p?.models[0]
    setProviderId(id)
    setModelId(m?.id || '')
    setEffort(m?.defaultReasoning || 'medium')
  }

  function pickModel(id: string) {
    const m = provider?.models.find((x) => x.id === id)
    setModelId(id)
    // Not every model supports every level — Luna has no `ultra` — so keep the
    // current choice only if the new model actually offers it.
    const next = m?.reasoningLevels || []
    if (next.length && !next.includes(effort)) setEffort(m?.defaultReasoning || next[0])
  }

  async function revise() {
    setBusy(true)
    setProposal(null)
    try {
      const res = await reviseSkill({ id: skillId, body, instruction, provider: providerId, model: modelId, reasoning: effort })
      setProposal(res)
    } catch (e: any) {
      if (e instanceof AuthError) return onAuthError?.()
      pushError(e?.message || 'The revision did not come back.')
    } finally {
      setBusy(false)
    }
  }

  const rows = useMemo(() => (proposal ? lineDiff(proposal.before, proposal.after) : []), [proposal])
  const hunks = useMemo(() => diffHunks(rows, 3), [rows])
  const stats = useMemo(() => diffStats(rows), [rows])

  // The editor is live while a revision is in flight, so the text can have moved
  // on since the proposal was built. Applying it would then silently throw those
  // edits away, so say so instead.
  const stale = proposal ? proposal.before !== body : false

  const canRevise = Boolean(providerId && modelId && instruction.trim().length >= 4 && body.trim() && !busy)

  if (providers && !providers.length) return null

  return (
    <div className="skill-reviser">
      <div className="skill-reviser-head">
        <Hi icon={SparklesIcon} size={14} />
        <strong>Ask AI to change this</strong>
        <span className="muted">It proposes an edit and you see the diff. Nothing is saved until you save.</span>
      </div>

      <div className="skill-reviser-controls">
        <select
          className="model-select"
          value={providerId}
          onChange={(e) => pickProvider(e.target.value)}
          disabled={busy || !providers}
          aria-label="Which AI to use"
        >
          {(providers || []).map((p) => (
            <option key={p.provider} value={p.provider} disabled={p.state !== 'ready' && p.state !== 'unknown'}>
              {p.name}{p.state !== 'ready' && p.state !== 'unknown' ? ` — ${p.state}` : ''}
            </option>
          ))}
        </select>
        <select
          className="model-select"
          value={modelId}
          onChange={(e) => pickModel(e.target.value)}
          disabled={busy || !provider}
          aria-label="Model"
        >
          {(provider?.models || []).map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
        <select
          className="model-select"
          value={effort}
          onChange={(e) => setEffort(e.target.value)}
          disabled={busy || !model}
          aria-label="Thinking level"
        >
          {levels.map((l) => (
            <option key={l} value={l}>{l}{l === model?.defaultReasoning ? ' (default)' : ''}</option>
          ))}
        </select>
      </div>

      {provider && provider.state !== 'ready' && provider.state !== 'unknown' && (
        <div className="job-form-note warn">
          <Hi icon={ExclamationTriangleIcon} size={13} />
          <span>{provider.name} is {provider.state}.{provider.fix ? <> Run <code>{provider.fix}</code> on the box.</> : null}</span>
        </div>
      )}

      <textarea
        className="skill-reviser-input"
        rows={3}
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="What should change? e.g. “make step 4 stricter about duplicates”, “stop it committing”, “say the output rules in half the words”"
        disabled={busy}
        spellCheck={false}
      />

      <div className="skill-reviser-actions">
        <button type="button" className="btn compact primary" onClick={revise} disabled={!canRevise}>
          {busy ? `Thinking… (${model?.name || modelId}, ${effort})` : 'Propose an edit'}
        </button>
        {busy && <span className="muted">It runs read-only — it cannot change any file, only hand back text.</span>}
      </div>

      {proposal && (
        <div className="skill-diff-wrap">
          <div className="skill-diff-head">
            <span>
              {proposal.provider === 'claude' ? 'Claude Code' : 'Codex'} · {proposal.model} ({proposal.effort})
              {' · '}{(proposal.ms / 1000).toFixed(1)}s
            </span>
            {proposal.changed && (
              <span className="skill-diff-stats">
                <span className="add">+{stats.added}</span> <span className="rm">−{stats.removed}</span>
              </span>
            )}
          </div>

          {!proposal.changed ? (
            <p className="muted skill-diff-empty">{proposal.note}</p>
          ) : (
            <>
              {stale && (
                <div className="job-form-note warn">
                  <Hi icon={ExclamationTriangleIcon} size={13} />
                  <span>
                    You have edited the instructions since this was proposed. Applying it will replace
                    what is in the box now, including those edits.
                  </span>
                </div>
              )}
              <div className="skill-diff" role="group" aria-label="Proposed changes">
                {hunks.map((h, hi) => (
                  <React.Fragment key={hi}>
                    {h.skipped > 0 && (
                      <div className="skill-diff-gap">{h.skipped} unchanged line{h.skipped === 1 ? '' : 's'}</div>
                    )}
                    {h.rows.map((r, ri) => (
                      <div key={ri} className={`skill-diff-row ${r.op}`}>
                        <span className="skill-diff-gutter">{r.op === 'add' ? '+' : r.op === 'remove' ? '−' : ' '}</span>
                        <span className="skill-diff-text">{r.text || ' '}</span>
                      </div>
                    ))}
                  </React.Fragment>
                ))}
              </div>
              <div className="skill-reviser-actions">
                <button
                  type="button"
                  className="btn compact primary"
                  onClick={() => { onApply(proposal.after); setProposal(null) }}
                >
                  <Hi icon={CheckIcon} size={13} /> Apply to instructions
                </button>
                <button type="button" className="btn compact" onClick={() => setProposal(null)}>
                  <Hi icon={XMarkIcon} size={13} /> Discard
                </button>
                <span className="muted">Applying fills the box above — you still have to press Save.</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
