// A tool call waiting on the owner's approval, in the reply where it was asked:
// the web's ApprovalRow.tsx (T3 Code's pending approval row), with More as the
// system action sheet. lib/chat/approvals.ts has the rules.
import React, { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { getState, respondToApproval } from '../../lib/chat/store'
import { approvalOptions, approvalOutcome } from '../../lib/chat/approvals'
import type { ApprovalDecision, ApprovalPart } from '../../lib/chat/types'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { showMenu } from '../../ui/menu'
import { success, tap } from '../../ui/haptics'
import { alpha, colors } from '../../theme'
import { Logo } from './WorkLog'
import { TI, vc } from './ui'
import { IconDots, IconShield, IconShieldCheck, IconShieldX } from './icons'

export default function ApprovalRow({ part, messageId, live }: { part: ApprovalPart; messageId: string; live: boolean }) {
  const [busy, setBusy] = useState(false)
  const pending = part.status === 'pending'
  const canRespond = pending && live
  const decide = async (decision: ApprovalDecision) => {
    const threadId = getState().activeId
    if (busy || !threadId) return
    tap()
    setBusy(true)
    if (await respondToApproval(threadId, messageId, part.id, decision)) success()
    setBusy(false)
  }
  const { primary, more } = approvalOptions(part)
  const detail = part.detail && part.detail !== part.title ? part.detail : ''

  if (!pending) {
    const ok = part.status === 'approved'
    const tone = ok ? colors.green : part.status === 'expired' ? vc.soft : colors.red
    return (
      <View style={st.settled}>
        <TI icon={ok ? IconShieldCheck : IconShieldX} size={15} color={tone} />
        <T size={13} color={vc.soft} numberOfLines={1} style={{ flexShrink: 1 }}>{part.title}{detail ? ` ${detail}` : ''}</T>
        <T size={13} color={vc.soft} numberOfLines={1} style={{ flex: 1 }}>{approvalOutcome(part)}</T>
      </View>
    )
  }

  return (
    <View style={st.card} accessibilityLabel="Approval request">
      <View style={st.head}>
        {part.logo ? <Logo logo={part.logo} kind="mcp" size={15} /> : <TI icon={IconShield} size={15} color={colors.amber} />}
        <T size={13.5} color={colors.text} style={{ flexShrink: 1 }}>
          {part.title}{part.app ? <T size={13.5} color={vc.soft}> · {part.app}</T> : null}{part.subagent ? <T size={13.5} color={vc.soft}> · sub-agent</T> : null}
        </T>
      </View>
      {detail || part.input ? <T size={12} mono color={colors.text} style={st.detail} numberOfLines={8} selectable>{detail || part.input}</T> : null}
      {part.reason ? <T size={12.5} color={vc.soft} style={st.indent}>{part.reason}</T> : null}
      {canRespond ? (
        <View style={st.actions}>
          <T size={12.5} color={colors.amber} style={{ flexBasis: '100%' }}>Waiting for approval</T>
          {primary.map((o) => (
            <Press key={o.decision} style={[st.btn, o.decision === 'accept' && st.primary, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void decide(o.decision)} accessibilityRole="button">
              <T size={13} weight={o.decision === 'accept' ? 600 : 400} color={o.decision === 'accept' ? colors.bg : vc.text}>{o.label}</T>
            </Press>
          ))}
          <Press style={[st.btn, busy && { opacity: 0.5 }]} disabled={busy} accessibilityLabel="More approval options"
            onPress={() => showMenu(more.map((o) => ({ label: o.label, destructive: o.decision === 'cancel', onPress: () => void decide(o.decision) })))}>
            <TI icon={IconDots} size={15} color={vc.text} />
          </Press>
        </View>
      ) : (
        <T size={12.5} color={vc.soft} style={st.indent}>The reply that asked has ended, so this can no longer be answered.</T>
      )}
    </View>
  )
}

const st = StyleSheet.create({
  card: { marginVertical: 8, padding: 12, gap: 8, borderRadius: 12, borderWidth: 1, borderColor: alpha(colors.amber, 0.45), backgroundColor: alpha(colors.amber, 0.06) },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  detail: { padding: 8, borderRadius: 8, backgroundColor: vc.code },
  indent: {},
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  btn: { height: 32, paddingHorizontal: 14, borderRadius: 9, borderWidth: 1, borderColor: vc.line, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: colors.text, borderColor: colors.text },
  settled: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 4 },
})
