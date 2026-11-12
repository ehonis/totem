// The pull request a chat's change-totem flow opened (web chat/ChangeCard.tsx).
// Links only: merging is the owner's, on GitHub, and merging deploys.
import React from 'react'
import { StyleSheet, View } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import type { ChangePart } from '../../lib/chat/types'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { colors } from '../../theme'
import { TI, vc } from './ui'
import { IconGitPullRequest, IconAlertTriangle, IconExternalLink } from './icons'

const CI_WORDS: Record<ChangePart['checks']['state'], string> = {
  none: 'No checks yet',
  pending: 'CI running',
  success: 'CI passed',
  failure: 'CI failed',
}

/** CI in a few words: "CI running · 2 of 3 done". */
function ciLine(checks: ChangePart['checks']): string {
  const total = checks.passed + checks.failed + checks.pending
  if (checks.state === 'none' || !total) return CI_WORDS[checks.state]
  if (checks.state === 'pending') return `${CI_WORDS.pending} · ${total - checks.pending} of ${total} done`
  if (checks.state === 'failure') return `${CI_WORDS.failure} · ${checks.failed} of ${total}`
  return `${CI_WORDS.success} · ${total} check${total === 1 ? '' : 's'}`
}

const CI_COLOR: Record<ChangePart['checks']['state'], string> = { none: vc.soft, pending: vc.soft, success: colors.green, failure: colors.red }

const open = (url: string) => { tap(); WebBrowser.openBrowserAsync(url, { controlsColor: colors.accent }).catch(() => {}) }

export default function ChangeCard({ part }: { part: ChangePart }) {
  const state = part.checks.state
  return (
    <View style={[st.card, state === 'success' && { borderColor: '#2e5a46' }, state === 'failure' && { borderColor: '#6a2a36' }]}>
      <View style={st.head}>
        <TI icon={IconGitPullRequest} size={15} />
        <T size={12.5} color={vc.soft}>Pull request ready · #{part.number}</T>
      </View>
      <T size={14.5} lineHeight={21} color={colors.text} style={{ marginTop: 4 }}>{part.title}</T>
      <T size={13} lineHeight={19.5} color={vc.soft} style={{ marginTop: 6 }}>
        <T size={13} color={CI_COLOR[state]}>{`${ciLine(part.checks)} (at push)`}</T>
        {` · ${part.files} file${part.files === 1 ? '' : 's'} · ${part.branch}`}
      </T>
      {part.warnings.map((w) => (
        <View key={w} style={st.warn}>
          <TI icon={IconAlertTriangle} size={14} color={colors.amber} />
          <T size={13} lineHeight={19.5} color={colors.amber} style={{ flex: 1 }}>{w}</T>
        </View>
      ))}
      <View style={st.actions}>
        <Press onPress={() => open(part.url)} style={[st.btn, st.primary]}>
          <T size={13} weight={500} color="#0f1115">Open PR</T>
          <TI icon={IconExternalLink} size={13} color="#0f1115" />
        </Press>
        <Press onPress={() => open(`${part.url}/checks`)} style={st.btn}><T size={13} weight={500} color={vc.soft}>Checks</T></Press>
      </View>
      <T size={12.5} color={vc.faint} style={{ marginTop: 8 }}>Merging deploys it. That is yours to do on GitHub.</T>
    </View>
  )
}

const st = StyleSheet.create({
  card: { marginTop: 10, marginBottom: 4, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1, borderColor: vc.line, backgroundColor: vc.surface },
  head: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  warn: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 6 },
  actions: { flexDirection: 'row', gap: 6, marginTop: 10 },
  btn: { height: 30, paddingHorizontal: 12, borderRadius: 999, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 4 },
  primary: { backgroundColor: colors.text },
})
