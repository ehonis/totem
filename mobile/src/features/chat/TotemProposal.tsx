// A change the agent proposed to one of the owner's totems (web chat/TotemProposal.tsx).
// Nothing changes until he taps Accept: the confirm-only rule for anything inferred.
import React, { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { api } from '../../lib/api'
import { pushError } from '../../lib/toast'
import { getState, patchMessagePart } from '../../lib/chat/store'
import type { TotemProposalPart } from '../../lib/chat/types'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { success, tap } from '../../ui/haptics'
import { colors } from '../../theme'
import { TI, vc } from './ui'
import { IconSparkles, IconCheck, IconChevronRight } from './icons'

export default function TotemProposal({ part, messageId }: { part: TotemProposalPart; messageId: string }) {
  const [busy, setBusy] = useState(false)
  const [showInstructions, setShowInstructions] = useState(false)
  async function act(action: 'accept' | 'dismiss') {
    const threadId = getState().activeId
    if (!threadId) return
    setBusy(true)
    try {
      const r = await api<{ status: TotemProposalPart['status'] }>('/api/totems/proposal', { method: 'POST', body: JSON.stringify({ threadId, messageId, partId: part.id, action }) })
      patchMessagePart(threadId, messageId, part.id, { status: r.status })
      if (action === 'accept') success(); else tap()
    } catch (e: any) { pushError(e.message) } finally { setBusy(false) }
  }
  return (
    <View style={[st.card, part.status === 'accepted' && { borderColor: '#2e5a46' }]}>
      <View style={st.head}>
        <TI icon={IconSparkles} size={15} />
        <T size={12.5} color={vc.soft}>{part.totemName ? `Change ${part.totemName}` : 'Change a totem'}</T>
      </View>
      <T size={14.5} lineHeight={21} color={colors.text} style={{ marginTop: 4 }}>{part.summary}</T>
      {part.memoryNote ? (
        <T size={13} lineHeight={19.5} color={vc.soft} style={{ marginTop: 6 }}><T size={13} weight={600} color={vc.soft}>Remember:</T> {part.memoryNote}</T>
      ) : null}
      {part.instructions ? (
        <View style={{ marginTop: 6 }}>
          <Press onPress={() => setShowInstructions((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <TI icon={IconChevronRight} size={13} color={vc.soft} style={showInstructions ? { transform: [{ rotate: '90deg' }] } : undefined} />
            <T size={13} color={vc.soft}>New instructions</T>
          </Press>
          {showInstructions ? <T size={13} lineHeight={19.5} color={vc.soft} style={{ marginTop: 6 }}>{part.instructions}</T> : null}
        </View>
      ) : null}
      {part.status === 'pending' ? (
        <View style={st.actions}>
          <Press disabled={busy} onPress={() => act('accept')} style={[st.btn, st.primary]}><T size={13} weight={500} color="#0f1115">Accept</T></Press>
          <Press disabled={busy} onPress={() => act('dismiss')} style={st.btn}><T size={13} weight={500} color={vc.soft}>Dismiss</T></Press>
        </View>
      ) : (
        <View style={st.done}>
          {part.status === 'accepted' ? <><TI icon={IconCheck} size={14} color={vc.faint} /><T size={12.5} color={vc.faint}>Applied</T></> : <T size={12.5} color={vc.faint}>Dismissed</T>}
        </View>
      )}
    </View>
  )
}

const st = StyleSheet.create({
  card: { marginTop: 10, marginBottom: 4, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1, borderColor: vc.line, backgroundColor: vc.surface },
  head: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  actions: { flexDirection: 'row', gap: 6, marginTop: 10 },
  btn: { height: 30, paddingHorizontal: 12, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: colors.text },
  done: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8 },
})
