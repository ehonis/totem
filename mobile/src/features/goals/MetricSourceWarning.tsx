// The web's sources/MetricSourceWarning.tsx: a small mark on a goal metric whose
// source is failing, so a number that is not arriving does not read as a slow
// week. Taps through to Settings → Connections.
import React from 'react'
import { router } from 'expo-router'
import { failingSourceFor, since, useSourceHealth } from '../../lib/sources/health'
import { ExclamationTriangleIcon, Hi } from '../../lib/icons'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'

export default function MetricSourceWarning({ sourceKind }: { sourceKind: string }) {
  const health = useSourceHealth()
  const source = failingSourceFor(health, sourceKind)
  if (!source) return null
  const from = since(source.failingSince)
  return (
    <Press
      haptic
      accessibilityRole="link"
      accessibilityHint={source.error || undefined}
      onPress={() => router.push('/settings/connections')}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
    >
      <Hi icon={ExclamationTriangleIcon} size={12} color={colors.red} />
      <T size={11} color={colors.red}>{source.label} failing{from ? ` since ${from}` : ''}</T>
    </Press>
  )
}
