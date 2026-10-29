import React from 'react'
import { StyleSheet, View } from 'react-native'
import { providerById } from '../../lib/chat/store'
import type { Switch } from '../../lib/chat/handoff'
import { T } from '../../ui/Text'
import { TI, ProviderLogo, vc } from './ui'
import { IconArrowRight } from './icons'

// Where a chat moved to another account: a divider in the log above the turn
// that moved, or (pending) a row over the composer before the next message
// goes. The web's web/src/chat/HandoffMark.tsx.
export default function HandoffMark({ s, pending = false }: { s: Switch; pending?: boolean }) {
  const from = providerById(s.from)
  const to = providerById(s.to)
  return (
    <View style={[st.row, pending && st.pending]}>
      <View style={st.rule} />
      <T size={12} color={vc.faint}>{pending ? 'Handoff with your next message' : 'Context handed off'}</T>
      <View style={st.who}>
        <ProviderLogo driver={from?.driver} name={from?.name} size={13} />
        <T size={12} color={vc.soft}>{from?.name || s.from}</T>
        <TI icon={IconArrowRight} size={13} color={vc.faint} />
        <ProviderLogo driver={to?.driver} name={to?.name} size={13} />
        <T size={12} color={vc.soft}>{to?.name || s.to}</T>
      </View>
      <View style={st.rule} />
    </View>
  )
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 24 },
  pending: { paddingHorizontal: 4, paddingBottom: 6 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: vc.line },
  who: { flexDirection: 'row', alignItems: 'center', gap: 4 },
})
