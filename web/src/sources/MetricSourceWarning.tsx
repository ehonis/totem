import React from 'react'
import { Hi, ExclamationTriangleIcon } from '../icons'
import { failingSourceFor, since, useSourceHealth } from './health'

/**
 * A small mark on a goal metric whose source is failing.
 *
 * A metric can still show a number while its source is down (the Strava cache is
 * a day old, say), which reads as a slow week. This says the number is not
 * arriving, and links to the source in Settings → Connections.
 */
export default function MetricSourceWarning({ sourceKind }: { sourceKind: string }) {
  const health = useSourceHealth()
  const source = failingSourceFor(health, sourceKind)
  if (!source) return null
  const from = since(source.failingSince)
  return (
    <a
      className="goal-source-warning"
      href="/settings/connections"
      title={source.error ? `${source.label}: ${source.error}` : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return
        e.preventDefault()
        window.history.pushState({}, '', '/settings/connections')
        window.dispatchEvent(new PopStateEvent('popstate'))
      }}
    >
      <Hi icon={ExclamationTriangleIcon} size={12} />
      {source.label} failing{from ? ` since ${from}` : ''}
    </a>
  )
}
