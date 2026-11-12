import React from 'react'
import type { ChangePart } from './types'
import { TI } from './ui'
import { IconGitPullRequest, IconAlertTriangle, IconExternalLink } from './icons'

const CI_WORDS: Record<ChangePart['checks']['state'], string> = {
  none: 'No checks yet',
  pending: 'CI running',
  success: 'CI passed',
  failure: 'CI failed',
}

/** CI in a few words: "CI running · 2 of 3 done". */
export function ciLine(checks: ChangePart['checks']): string {
  const total = checks.passed + checks.failed + checks.pending
  if (checks.state === 'none' || !total) return CI_WORDS[checks.state]
  if (checks.state === 'pending') return `${CI_WORDS.pending} · ${total - checks.pending} of ${total} done`
  if (checks.state === 'failure') return `${CI_WORDS.failure} · ${checks.failed} of ${total}`
  return `${CI_WORDS.success} · ${total} check${total === 1 ? '' : 's'}`
}

/**
 * The pull request a chat's change-totem flow opened (dev/change.mjs). Links
 * only: merging is the owner's, on GitHub, and merging deploys.
 */
export default function ChangeCard({ part }: { part: ChangePart }) {
  return (
    <div className={`vc-totem-prop vc-change ${part.checks.state}`}>
      <div className="vc-totem-prop-head">
        <TI icon={IconGitPullRequest} size={15} />
        <span>Pull request ready · #{part.number}</span>
      </div>
      <div className="vc-totem-prop-summary">{part.title}</div>
      <div className="vc-totem-prop-detail">
        <span className={`vc-change-ci ${part.checks.state}`} title="As it stood when the branch was pushed; open Checks for now">{ciLine(part.checks)} (at push)</span>
        {' · '}{part.files} file{part.files === 1 ? '' : 's'} · <code>{part.branch}</code>
      </div>
      {part.warnings.map((w) => (
        <div key={w} className="vc-totem-prop-detail vc-change-warn"><TI icon={IconAlertTriangle} size={14} />{w}</div>
      ))}
      <div className="vc-totem-prop-actions">
        <a className="vc-btn sm primary" href={part.url} target="_blank" rel="noreferrer">Open PR <TI icon={IconExternalLink} size={13} /></a>
        <a className="vc-btn sm ghost" href={`${part.url}/checks`} target="_blank" rel="noreferrer">Checks</a>
      </div>
      <div className="vc-totem-prop-done">Merging deploys it. That is yours to do on GitHub.</div>
    </div>
  )
}
