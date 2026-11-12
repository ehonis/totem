// An inbox proposal this chat's agent staged, in the reply that staged it: the
// web's InboxCardRow.tsx (chat/inbox-outcome.mjs on the bridge). Deny, Accept
// (Send, Open in T3 Code) and Save as draft go through the Inbox's own resolve
// route with this phone's approval code; the note goes to the agent with the
// decision, and Reply sends it alone, leaving the proposal open.
import React, { useEffect, useState } from 'react'
import { Linking, StyleSheet, TextInput, View } from 'react-native'
import { ApiError, getInbox, releaseInboxItem, replyInboxItem, resolveInboxItem } from '../../lib/api'
import { APPROVAL_REFUSALS } from '../../lib/approvalCode'
import { notifyInboxChanged } from '../../lib/useInboxCount'
import { pushError } from '../../lib/toast'
import { getState, patchMessagePart, resumeRuns, syncThreads } from '../../lib/chat/store'
import { inboxOutcome, resultOf, statusFor } from '../../lib/chat/inboxCards'
import type { InboxPart } from '../../lib/chat/types'
import { InboxDetails, LinkedinCard } from '../inbox/InboxScreen'
import { navigateTo } from '../../shell/nav'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { success, tap } from '../../ui/haptics'
import { alpha, colors } from '../../theme'
import { TI, vc } from './ui'
import { IconArrowBackUp, IconChevronRight, IconShield, IconShieldCheck, IconShieldX } from './icons'

// One listing shared by every card on screen, refreshed when it is a few seconds old.
let listing: { at: number; items: Promise<any[]> } | null = null
function inboxItems(fresh = false): Promise<any[]> {
  if (fresh || !listing || Date.now() - listing.at > 5000) {
    const items = getInbox().then((r: any) => r.items || [])
    listing = { at: Date.now(), items }
    items.catch(() => { listing = null })
  }
  return listing.items
}

/** One proposal, from the shared listing, or a fresh one when it was staged after that was read. */
async function findItem(id: string): Promise<any | null> {
  return (await inboxItems()).find((x) => x.id === id) || (await inboxItems(true)).find((x) => x.id === id) || null
}

/** The bridge starts the chat's next turn just after answering; pick it up here. */
function followTheChat() {
  setTimeout(() => { syncThreads().then(resumeRuns) }, 700)
}

export default function InboxCardRow({ part, messageId }: { part: InboxPart; messageId: string }) {
  const pending = part.status === 'pending'
  const [item, setItem] = useState<any>(null)
  const [missing, setMissing] = useState(false)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!pending) return
    let live = true
    findItem(part.id).then((found) => {
      if (!live) return
      setItem(found)
      setMissing(!found)
    }).catch(() => {})
    return () => { live = false }
  }, [pending, part.id])

  if (!pending) {
    const ok = part.status === 'accepted' || part.status === 'draft'
    const tone = ok ? colors.green : part.status === 'denied' ? colors.red : vc.soft
    return (
      <View style={st.settled}>
        <TI icon={ok ? IconShieldCheck : IconShieldX} size={15} color={tone} />
        <T size={13} color={vc.soft} numberOfLines={1} style={{ flexShrink: 1 }}>{part.title}</T>
        <T size={13} color={vc.soft} numberOfLines={1} style={{ flex: 1 }}>{inboxOutcome(part)}</T>
      </View>
    )
  }

  const threadId = getState().activeId
  const isEmail = part.kind === 'email'
  const t3Url: string | undefined = part.kind === 'prompt' ? item?.preview?.openUrl : undefined
  const blocked = !item || Boolean(item.refused || item.preview?.error) || (part.kind === 'prompt' && !t3Url)
  const words = note.trim()

  const decide = async (action: 'accept' | 'deny' | 'draft') => {
    if (busy || !item || !threadId) return
    tap()
    if (action === 'accept' && t3Url) Linking.openURL(t3Url).catch(() => {})
    setBusy(true)
    try {
      const res: any = await resolveInboxItem(item.id, action, item.digest, words || undefined)
      const result = action === 'deny' ? '' : resultOf(res?.note)
      patchMessagePart(threadId, messageId, part.id, { status: statusFor(action), ...(words ? { note: words } : {}), ...(result ? { result } : {}), decidedAt: Date.now() })
      success()
      notifyInboxChanged()
      listing = null
      followTheChat()
    } catch (e: any) {
      const fix = e instanceof ApiError && APPROVAL_REFUSALS.has((e as any).code) ? ' Set this phone’s approval code in Settings → Security.' : ''
      pushError(`Couldn't ${action === 'deny' ? 'deny' : action === 'draft' ? 'save' : 'accept'} “${part.title}”: ${e.message}${fix}`)
      inboxItems(true).then((items) => { const found = items.find((x) => x.id === part.id); setItem(found || null); setMissing(!found) }).catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  const reply = async () => {
    if (busy || !words || !threadId) return
    tap()
    setBusy(true)
    try {
      await replyInboxItem(part.id, words)
      setNote('')
      followTheChat()
    } catch (e: any) {
      pushError(`Couldn't send your reply: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  const release = async () => {
    setBusy(true)
    try {
      await releaseInboxItem(part.id)
      setItem((x: any) => (x ? { ...x, held: null } : x))
      notifyInboxChanged()
    } catch (e: any) {
      pushError(`Couldn't show “${part.title}”: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  const btn = (label: string, onPress: () => void, { primary = false, disabled = false } = {}) => (
    <Press key={label} style={[st.btn, primary && st.primary, (busy || disabled) && { opacity: 0.5 }]} disabled={busy || disabled} onPress={onPress} accessibilityRole="button">
      <T size={13} weight={primary ? 600 : 400} color={primary ? colors.bg : vc.text}>{label}</T>
    </Press>
  )

  return (
    <View style={st.card} accessibilityLabel={`Inbox proposal ${part.id}`}>
      <View style={st.head}>
        <TI icon={IconShield} size={15} color={colors.amber} />
        <T size={13.5} color={colors.text} style={{ flexShrink: 1 }}>
          {part.title}<T size={13.5} color={vc.soft}> · {item?.destination || part.kind} · {part.id}</T>
        </T>
      </View>
      {item?.preview?.summary ? <T size={12.5} color={vc.soft}>{item.preview.summary}</T> : null}
      {item?.refused ? <T size={12.5} color={colors.red}>Refused: {item.refused}</T> : null}
      {item?.held ? <T size={12.5} color={vc.soft}>You denied the same proposal ({item.held.id}) on {new Date(item.held.deniedAt).toLocaleDateString()}, so it is not asking again.</T> : null}
      {missing ? (
        <Press onPress={() => navigateTo('inbox')} accessibilityRole="link">
          <T size={12.5} color={vc.soft}>Not in the Inbox any more: it was decided elsewhere, or is still being written. Open the Inbox</T>
        </Press>
      ) : null}
      {item ? (
        <Press style={st.disclose} onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: open }}>
          <View style={open ? { transform: [{ rotate: '90deg' }] } : undefined}><TI icon={IconChevronRight} size={13} color={vc.soft} /></View>
          <T size={12.5} color={vc.soft}>{open ? 'Hide details' : 'Show details'}</T>
        </Press>
      ) : null}
      {/* A LinkedIn card's post, draft and link are the action itself, so they show without opening. */}
      {!open && item?.preview?.linkedin ? <LinkedinCard card={item.preview.linkedin} /> : null}
      {open && item ? <InboxDetails item={item} /> : null}
      {item ? (
        <TextInput
          style={st.note}
          value={note}
          onChangeText={setNote}
          maxLength={2000}
          multiline
          placeholder="Note for the agent (optional)"
          placeholderTextColor={vc.soft}
          accessibilityLabel="Note for the agent"
        />
      ) : null}
      <View style={st.actions}>
        <T size={12.5} color={colors.amber} style={{ flexBasis: '100%' }}>Waiting for your approval</T>
        {item?.held ? btn('Show anyway', () => void release()) : item ? (
          <>
            {btn('Deny', () => void decide('deny'))}
            {isEmail && !blocked ? btn('Save as draft', () => void decide('draft')) : null}
            {btn(isEmail || part.kind === 'imessage' ? 'Send' : part.kind === 'prompt' ? 'Open in T3 Code' : part.kind === 'linkedin' ? 'Mark done' : 'Accept', () => void decide('accept'), { primary: true, disabled: blocked })}
          </>
        ) : null}
        {item ? (
          <Press style={[st.btn, st.row, (busy || !words) && { opacity: 0.5 }]} disabled={busy || !words} onPress={() => void reply()} accessibilityRole="button" accessibilityLabel="Reply: send the note, the proposal stays open">
            <TI icon={IconArrowBackUp} size={13} color={vc.text} /><T size={13} color={vc.text}>Reply</T>
          </Press>
        ) : null}
      </View>
    </View>
  )
}

const st = StyleSheet.create({
  card: { marginVertical: 8, padding: 12, gap: 8, borderRadius: 12, borderWidth: 1, borderColor: alpha(colors.amber, 0.45), backgroundColor: alpha(colors.amber, 0.06) },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  disclose: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  note: { minHeight: 34, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: vc.line, color: colors.text, fontSize: 13 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  btn: { height: 32, paddingHorizontal: 14, borderRadius: 9, borderWidth: 1, borderColor: vc.line, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', gap: 4 },
  primary: { backgroundColor: colors.text, borderColor: colors.text },
  settled: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 4 },
})
