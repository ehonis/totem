// One message in the conversation (web chat/Message.tsx): his bubble on the
// right, Totem's reply as Markdown on the left with its steps (WorkLog),
// pictures, files, steers and totem proposals in the order they happened.
// Long-press either for the native menu (copy, edit, regenerate, details); the
// quiet action row under a reply stays too, as it does on the web phone. A skill
// he cited ("/morning") is tinted in his bubble.
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Image } from 'expo-image'
import * as Clipboard from 'expo-clipboard'
import * as WebBrowser from 'expo-web-browser'
import { router } from 'expo-router'
import { MenuView, type MenuAction } from '@react-native-menu/menu'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Markdown from '../../ui/Markdown'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { impact, success, tap } from '../../ui/haptics'
import { alpha, colors, fonts } from '../../theme'
import { authHeaders } from '../../lib/api'
import { bridgeUrl } from '../../lib/connection'
import { useSmoothText } from '../../lib/chat/smooth'
import { useTextTicks } from '../../lib/chat/ticks'
import { POWER_NAMES } from '../../lib/chat/models'
import { splitMentions } from '../../lib/chat/mentions'
import type { Attachment, ChatMessage, Part, ProviderRow, SteerPart, ToolPart } from '../../lib/chat/types'
import { getChatCommands, subscribeChatCommands } from '../../lib/studio'
import WorkLog from './WorkLog'
import { AgentCard } from './AgentsPanel'
import TurnStats, { TurnChip } from './TurnStats'
import TotemProposal from './TotemProposal'
import Spark, { WorkingLine } from './Spark'
import { foldTotemCalls, type TotemAnswer } from '../../lib/chat/totemReply'
import { TotemIcon, loadJobs, useJobs } from '../totems/shared'
import { TI, ProviderLogo, formatBytes, formatDuration, vc } from './ui'
import {
  IconAlertCircle, IconCopy, IconCheck, IconRefresh, IconFileText, IconFileTypePdf, IconClipboardText,
  IconBolt, IconDeviceDesktop, IconMicrophone, IconX, IconCornerUpRight, IconWorld, IconPencil,
} from './icons'

// A pasted URL has no spaces to wrap at; iOS breaks it anywhere already, the web preview needs telling.
const WRAP = Platform.OS === 'web' ? ({ wordBreak: 'break-word', overflowWrap: 'anywhere' } as any) : undefined

// --- files and pictures ----------------------------------------------------------

/** An image the bridge serves: signed URLs open anywhere; the bearer covers the rest. */
export const imageSource = (url?: string, uploadId?: string) => ({
  uri: bridgeUrl(url || `/api/chat/uploads/${uploadId}`),
  headers: authHeaders(),
})

const TEXTLIKE = /^(text\/|application\/(json|xml))/
export function openFile(f: { id?: string; uploadId?: string; name: string; mime: string; url?: string; path?: string }) {
  const id = f.uploadId || f.id || ''
  tap()
  // Text, Markdown and CSV read in a sheet; PDFs and pages open in the in-app browser.
  if (TEXTLIKE.test(f.mime) || /\.(md|markdown|csv|tsv|txt|json)$/i.test(f.name)) {
    router.push({ pathname: '/chat/file', params: { id, name: f.name, mime: f.mime, url: f.url || '' } })
    return
  }
  WebBrowser.openBrowserAsync(bridgeUrl(f.url || `/api/chat/uploads/${id}`), { controlsColor: colors.accent }).catch(() => {})
}

export function AttachmentChip({ a, onOpen, onRemove, status, progress, large }: {
  a: { name: string; kind: string; mime: string; size: number; url?: string; preview?: string; localUri?: string }
  onOpen?: () => void
  onRemove?: () => void
  status?: 'uploading' | 'ready' | 'error'
  progress?: number
  /** In a sent message, pictures show at their own shape, up to 260 pt. */
  large?: boolean
}) {
  const [ratio, setRatio] = useState(1)
  if (a.kind === 'image' && (a.url || a.localUri)) {
    return (
      <View>
        <Press onPress={onOpen} style={[st.thumb, large && { width: ratio >= 1 ? 240 : Math.max(120, 240 * ratio), height: ratio >= 1 ? Math.max(120, 240 / ratio) : 240 }]} accessibilityLabel={a.name}>
          <Image
            source={a.localUri ? { uri: a.localUri } : imageSource(a.url)}
            style={[{ width: '100%', height: '100%' }, status === 'uploading' && { opacity: 0.5 }]}
            contentFit="cover"
            onLoad={large ? (e) => { const { width, height } = e.source; if (width && height) setRatio(width / height) } : undefined}
          />
          {status === 'uploading' ? (
            <View style={st.progressTrack}><View style={[st.progressFill, { width: `${Math.round((progress || 0) * 100)}%` }]} /></View>
          ) : null}
        </Press>
        {onRemove ? <ChipX label={a.name} onPress={onRemove} /> : null}
      </View>
    )
  }
  const icon = a.kind === 'text' ? IconClipboardText : /pdf/.test(a.mime) ? IconFileTypePdf : IconFileText
  const pasted = /^Pasted text/i.test(a.name)
  const meta = status === 'uploading' ? `Uploading ${Math.round((progress || 0) * 100)}%`
    : status === 'error' ? 'Upload failed'
      : pasted ? `Pasted · ${formatBytes(a.size)}` : `${(a.name.split('.').pop() || 'file').toUpperCase()} · ${formatBytes(a.size)}`
  return (
    <View>
      <Press onPress={onOpen} style={[st.file, large && { backgroundColor: vc.bubble, borderColor: 'transparent' }]}>
        <View style={[st.fileIcon, status === 'error' && { backgroundColor: colors.red }]}><TI icon={icon} size={18} color="#fff" /></View>
        <View style={{ minWidth: 0, flexShrink: 1 }}>
          <T size={13.5} weight={500} numberOfLines={1}>{pasted ? (a.preview || 'Pasted text') : a.name}</T>
          <T size={12} color={vc.faint} numberOfLines={1}>{meta}</T>
        </View>
      </Press>
      {onRemove ? <ChipX label={a.name} onPress={onRemove} /> : null}
    </View>
  )
}

function ChipX({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Press onPress={onPress} hitSlop={8} accessibilityLabel={`Remove ${label}`} style={st.chipX}>
      <TI icon={IconX} size={12} color="#0f1115" stroke={2.25} />
    </Press>
  )
}

/** A picture full screen, on black; tap anywhere to close. */
export function Lightbox({ source, alt, onClose }: { source: { uri: string; headers?: Record<string, string> } | null; alt?: string; onClose: () => void }) {
  const insets = useSafeAreaInsets()
  return (
    <Modal visible={!!source} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={st.lightbox} onPress={onClose} accessibilityLabel={alt || 'Image'}>
        {source ? <Image source={source} style={{ width: '100%', height: '100%' }} contentFit="contain" /> : null}
        <Press onPress={onClose} accessibilityLabel="Close" style={[st.lightboxClose, { top: insets.top + 14 }]}>
          <TI icon={IconX} size={20} color="#fff" />
        </Press>
      </Pressable>
    </Modal>
  )
}

function copy(text: string) {
  Clipboard.setStringAsync(text).catch(() => {})
  success()
}

/** A long-press menu around a message, built from (id, title, run) rows. */
function MessageMenu({ items, children }: { items: { id: string; title: string; image: string; run: () => void; destructive?: boolean }[]; children: React.ReactNode }) {
  const actions: MenuAction[] = items.map((i) => ({ id: i.id, title: i.title, image: i.image, attributes: i.destructive ? { destructive: true } : undefined }))
  return (
    <MenuView
      shouldOpenOnLongPress
      actions={actions}
      themeVariant="dark"
      onOpenMenu={impact}
      onPressAction={({ nativeEvent }) => items.find((i) => i.id === nativeEvent.event)?.run()}
    >
      {children}
    </MenuView>
  )
}

// --- his messages --------------------------------------------------------------------

const MODE_BADGE: Record<string, { icon: any; label: string }> = {
  task: { icon: IconBolt, label: 'Task' },
  computer: { icon: IconDeviceDesktop, label: 'Computer use' },
}

/**
 * Every command a message can cite, under both prefixes (the bridge accepts
 * either), for drawing `/name` as a skill rather than as text.
 */
export function useMentionSet() {
  const catalog = useSyncExternalStore(subscribeChatCommands, getChatCommands, getChatCommands)
  return useMemo(() => {
    const set = new Set<string>()
    for (const c of catalog) { const name = c.cmd.slice(1).toLowerCase(); set.add(`/${name}`); set.add(`$${name}`) }
    return set
  }, [catalog])
}

/** His words, with each skill he cited tinted. */
function MentionText({ text }: { text: string }) {
  const known = useMentionSet()
  return (
    <T size={15} lineHeight={23} color={colors.text} style={WRAP} selectable={Platform.OS === 'web'}>
      {splitMentions(text, known).map((p, i) => (p.mention ? <Text key={i} style={st.mention}>{p.text}</Text> : p.text))}
    </T>
  )
}

export const UserMessage = React.memo(function UserMessage({ m, canEdit, onEdit, onRetry, onDiscard }: {
  m: ChatMessage
  canEdit: boolean
  onEdit: (text: string) => void
  onRetry?: () => void
  onDiscard?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(m.content)
  const [lightbox, setLightbox] = useState<{ uri: string; headers?: Record<string, string> } | null>(null)
  const [copied, setCopied] = useState(false)
  const badge = m.mode ? MODE_BADGE[m.mode] : null
  const doCopy = () => { copy(m.content); setCopied(true); setTimeout(() => setCopied(false), 1200) }
  const startEdit = () => { setDraft(m.content); setEditing(true) }
  const items = [
    ...(m.content ? [{ id: 'copy', title: 'Copy', image: 'doc.on.doc', run: doCopy }] : []),
    ...(canEdit && m.content && !m.unsent ? [{ id: 'edit', title: 'Edit', image: 'pencil', run: startEdit }] : []),
    ...(onRetry ? [{ id: 'retry', title: 'Try again', image: 'arrow.clockwise', run: onRetry }] : []),
  ]
  const open = (a: Attachment) => (a.kind === 'image' ? setLightbox(imageSource(a.url, a.id)) : openFile(a))
  return (
    <View style={{ alignItems: 'flex-end' }}>
      {!!m.attachments?.length && (
        <View style={st.userAttachments}>
          {m.attachments.map((a) => <AttachmentChip key={a.id} a={a} large onOpen={() => open(a)} />)}
        </View>
      )}
      {editing ? (
        <View style={st.edit}>
          <TextInput
            autoFocus
            multiline
            value={draft}
            onChangeText={setDraft}
            style={st.editInput}
            keyboardAppearance="dark"
            selectionColor={colors.accent}
          />
          <View style={st.editActions}>
            <Press style={[st.vcBtn, st.vcBtnGhost]} onPress={() => { setEditing(false); setDraft(m.content) }}><T size={13} weight={500} color={vc.soft}>Cancel</T></Press>
            <Press
              style={[st.vcBtn, st.vcBtnPrimary]}
              disabled={!draft.trim()}
              onPress={() => { impact(); setEditing(false); onEdit(draft.trim()) }}
            >
              <T size={13} weight={500} color="#0f1115">Send</T>
            </Press>
          </View>
        </View>
      ) : m.content ? (
        <MessageMenu items={items}>
          <View style={st.bubble}>
            {badge || m.voice ? (
              <View style={st.badge}>
                {badge ? <><TI icon={badge.icon} size={13} /><T size={12} color={vc.soft}>{badge.label}</T></> : null}
                {m.voice ? <><TI icon={IconMicrophone} size={13} /><T size={12} color={vc.soft}>Voice</T></> : null}
              </View>
            ) : null}
            <MentionText text={m.content} />
          </View>
        </MessageMenu>
      ) : null}
      {m.unsent ? (
        <View style={st.unsent} accessibilityRole="alert">
          <TI icon={IconAlertCircle} size={15} color="#f0cd72" />
          <T size={12.5} color={vc.soft} style={{ flexShrink: 1 }}>Not sent{m.sendError && m.sendError !== 'Not sent' ? ` · ${m.sendError}` : ''}. Saved on this device.</T>
          {onRetry ? <Press style={[st.vcBtn, st.vcBtnSm, st.vcBtnPrimary]} onPress={() => { impact(); onRetry() }}><T size={13} weight={500} color="#0f1115">Try again</T></Press> : null}
          {onDiscard ? <Press style={[st.vcBtn, st.vcBtnSm, st.vcBtnGhost]} onPress={onDiscard}><T size={13} weight={500} color={vc.soft}>Edit</T></Press> : null}
        </View>
      ) : null}
      {!editing && m.content && !m.unsent ? (
        <View style={[st.actions, { justifyContent: 'flex-end' }]}>
          <Act icon={copied ? IconCheck : IconCopy} label={copied ? 'Copied' : 'Copy'} onPress={doCopy} />
          {canEdit ? <Act icon={IconPencil} label="Edit" onPress={startEdit} /> : null}
        </View>
      ) : null}
      <Lightbox source={lightbox} onClose={() => setLightbox(null)} />
    </View>
  )
})

function Act({ icon, label, onPress, on }: { icon: any; label: string; onPress: () => void; on?: boolean }) {
  return (
    <Press onPress={onPress} accessibilityLabel={label} hitSlop={4} style={[st.act, on && { backgroundColor: vc.raise }]}>
      <TI icon={icon} size={15} color={on ? colors.text : vc.faint} />
    </Press>
  )
}

// --- Totem's replies -------------------------------------------------------------------

type Block =
  | { kind: 'text'; text: string; key: string }
  | { kind: 'tools'; tools: ToolPart[]; key: string }
  | { kind: 'agent'; tool: ToolPart; key: string }
  | { kind: 'image'; part: any; key: string }
  | { kind: 'file'; part: any; key: string }
  | { kind: 'proposal'; part: any; key: string }
  | { kind: 'steer'; part: SteerPart; key: string }
  | { kind: 'totem'; answer: TotemAnswer; key: string }

// A totem proposal arrives as a fenced block while streaming; the bridge turns it
// into a card when the reply settles. Until then, don't show the raw JSON.
const PROPOSAL_FENCE = /```totem-proposal[\s\S]*?(```|$)/g

function blocks(parts: Part[]): Block[] {
  const out: Block[] = []
  // A totem asked in the chat speaks for itself: one message per ask, not a tool row.
  const totems = foldTotemCalls(parts)
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (totems.skip.has(i)) continue
    const answer = totems.at.get(i)
    if (answer) out.push({ kind: 'totem', answer, key: `k${i}` })
    // A call that started another agent stands on its own, never folded into the steps.
    else if (p.type === 'tool' && p.agent) out.push({ kind: 'agent', tool: p, key: `a${i}` })
    else if (p.type === 'tool') {
      const last = out[out.length - 1]
      if (last?.kind === 'tools') last.tools.push(p)
      else out.push({ kind: 'tools', tools: [p], key: `w${i}` })
    } else if (p.type === 'image') out.push({ kind: 'image', part: p, key: `i${i}` })
    else if (p.type === 'file') out.push({ kind: 'file', part: p, key: `f${i}` })
    else if (p.type === 'totem-proposal') out.push({ kind: 'proposal', part: p, key: `p${i}` })
    else if (p.type === 'steer') out.push({ kind: 'steer', part: p, key: `s${i}` })
    else if (p.text) {
      const last = out[out.length - 1]
      // Two text parts with no tool between them are one paragraph run.
      if (last?.kind === 'text') last.text += p.text
      else out.push({ kind: 'text', text: p.text, key: `t${i}` })
    }
  }
  for (const b of out) if (b.kind === 'text') b.text = b.text.replace(PROPOSAL_FENCE, '')
  return out
}

/** A totem's answer in the chat, under its name: what the host's totems__ask brought back. */
function TotemSays({ answer: a, live }: { answer: TotemAnswer; live: boolean }) {
  const jobs = useJobs()
  useEffect(() => { if (!jobs) void loadJobs() }, [jobs])
  const known = a.totemId ? jobs?.find((j) => j.id === a.totemId) : undefined
  const waiting = a.status === 'asking' || a.status === 'working'
  return (
    <View style={st.totemSay} accessibilityHint={a.question ? `Asked: ${a.question}` : undefined}>
      <View style={st.totemHead}>
        <TotemIcon name={a.icon || known?.iconName} small />
        <T size={13.5} weight={600}>{a.name || known?.name || 'A totem'}</T>
        {waiting ? (live
          ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><Spark size={12} /><T size={12.5} color={vc.soft}>{a.status === 'working' ? 'still working' : 'thinking'}</T></View>
          : <T size={12.5} color={vc.soft}>no answer</T>) : null}
      </View>
      {a.status === 'done' ? <Markdown text={a.reply || '(nothing to say)'} size={16} /> : null}
      {a.status === 'error' ? <T size={14} color={vc.soft}>Couldn’t answer: {a.error}</T> : null}
    </View>
  )
}

/** What the owner sent mid-reply, where it landed: his bubble, marked as a steer. */
function SteerNote({ part }: { part: SteerPart }) {
  return (
    <View style={{ alignItems: 'flex-end', marginVertical: 10 }} accessibilityHint={part.via === 'restart' ? 'Interrupted the reply and carried on with this' : 'Taken into the running reply'}>
      <View style={st.bubble}>
        <View style={st.badge}><TI icon={IconCornerUpRight} size={13} /><T size={12} color={vc.soft}>Steered</T></View>
        <T size={15} lineHeight={23} color={colors.text} style={WRAP}>{part.text}</T>
      </View>
    </View>
  )
}

/** A file Totem made: a card that opens it (ArtifactPanel's FileCard). */
function FileCard({ file }: { file: { uploadId: string; name: string; mime: string; url?: string; path?: string } }) {
  const kind = /markdown/.test(file.mime) || /\.(md|markdown)$/i.test(file.name) ? 'Document'
    : /html/.test(file.mime) || /\.html?$/i.test(file.name) ? 'Web page'
      : /csv|tab-separated/.test(file.mime) || /\.(csv|tsv)$/i.test(file.name) ? 'Table'
        : /pdf/.test(file.mime) ? 'PDF' : /^image\//.test(file.mime) ? 'Image' : 'File'
  const icon = kind === 'Web page' ? IconWorld : kind === 'PDF' ? IconFileTypePdf : kind === 'Table' ? IconClipboardText : IconFileText
  return (
    <Press onPress={() => openFile(file)} style={st.filecard}>
      <View style={st.filecardIcon}><TI icon={icon} size={22} color="#8fb0ff" /></View>
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <T size={15} weight={500} numberOfLines={1}>{file.name}</T>
        <T size={13} color={vc.faint}>{kind}</T>
      </View>
    </Press>
  )
}

/** True once `signature` has stopped changing for 700 ms while `live`. */
function useQuiet(live: boolean, signature: string) {
  const [quiet, setQuiet] = useState(false)
  useEffect(() => {
    setQuiet(false)
    if (!live) return
    const t = setTimeout(() => setQuiet(true), 700)
    return () => clearTimeout(t)
  }, [live, signature])
  return live && quiet
}

/** The reply's last text block while it streams: released word by word. */
function StreamingText({ text }: { text: string }) {
  const shown = useSmoothText(text, true)
  useTextTicks(shown)
  return <Markdown text={shown} size={16} />
}

/** A screenshot or picture in a reply, at its own shape. */
function Shot({ part, onOpen }: { part: any; onOpen: () => void }) {
  const [ratio, setRatio] = useState(16 / 10)
  return (
    <Press onPress={onOpen} style={st.shot}>
      <Image
        source={imageSource(part.url, part.uploadId)}
        style={{ width: '100%', aspectRatio: ratio }}
        contentFit="cover"
        accessibilityLabel={part.alt || 'Screenshot'}
        onLoad={(e) => { const { width, height } = e.source; if (width && height) setRatio(width / height) }}
      />
    </Press>
  )
}

export const AssistantMessage = React.memo(function AssistantMessage({ m, live, activity, provider, modelName, isLast, onRegenerate }: {
  m: ChatMessage
  live: boolean
  activity?: string
  provider?: ProviderRow
  modelName?: string
  isLast: boolean
  onRegenerate?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [details, setDetails] = useState(false)
  const [lightbox, setLightbox] = useState<{ uri: string; headers?: Record<string, string> } | null>(null)
  const list = useMemo(() => (m.parts?.length ? blocks(m.parts) : m.content ? [{ kind: 'text', text: m.content, key: 'c' } as Block] : []), [m.parts, m.content])
  const thinking = live && !list.length
  // Mid-reply silence (between tools, or thinking before the next sentence) gets
  // the working line too, so a live reply never looks stalled.
  const toolRunning = !!m.parts?.some((p) => p.type === 'tool' && p.status === 'running')
  const quiet = useQuiet(live, `${m.content.length}:${m.parts?.length || 0}`)
  const secs = m.durationMs && m.durationMs > 2000 ? formatDuration(m.durationMs) : null
  const lane = m.power ? [POWER_NAMES[String(m.power)], m.route === 'thinking' && secs ? `thought for ${secs}` : null].filter(Boolean).join(', ')
    : m.route === 'thinking' ? (secs ? `Thought for ${secs}` : 'Thinking') : m.route === 'instant' ? 'Instant' : null
  const meta = [lane, provider?.name, modelName, lane ? null : secs].filter(Boolean).join(' · ')
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const doCopy = () => { copy(m.content); setCopied(true); clearTimeout(copiedTimer.current); copiedTimer.current = setTimeout(() => setCopied(false), 1200) }
  const items = [
    ...(m.content ? [{ id: 'copy', title: 'Copy', image: 'doc.on.doc', run: doCopy }] : []),
    ...(isLast && onRegenerate ? [{ id: 'regen', title: 'Regenerate', image: 'arrow.clockwise', run: () => { impact(); onRegenerate() } }] : []),
    ...(meta ? [{ id: 'details', title: details ? 'Hide reply details' : 'Reply details', image: 'info.circle', run: () => setDetails((d) => !d) }] : []),
  ]

  const body = (
    <View style={{ gap: 10, minWidth: 0 }}>
      {list.map((b, i) => {
        if (b.kind === 'tools') return <WorkLog key={b.key} tools={b.tools} live={live && i === list.length - 1} />
        if (b.kind === 'agent') return <AgentCard key={b.key} tool={b.tool} />
        if (b.kind === 'proposal') return <TotemProposal key={b.key} part={b.part} messageId={m.id} />
        if (b.kind === 'steer') return <SteerNote key={b.key} part={b.part} />
        if (b.kind === 'totem') return <TotemSays key={b.key} answer={b.answer} live={live} />
        if (b.kind === 'file') return <FileCard key={b.key} file={b.part} />
        if (b.kind === 'image') return <Shot key={b.key} part={b.part} onOpen={() => setLightbox(imageSource(b.part.url, b.part.uploadId))} />
        if (live && i === list.length - 1) return <StreamingText key={b.key} text={b.text} />
        return <Markdown key={b.key} text={b.text} size={16} />
      })}
      {thinking ? <WorkingLine text={activity ? activity.split('\n')[0].replace(/^(Working|Running|Done):\s*/, '') : m.route === 'thinking' ? 'Thinking longer for a better answer' : 'Thinking'} /> : null}
      {live && !thinking && quiet && !toolRunning ? <WorkingLine text={activity && !/^Done:/.test(activity) ? activity.split('\n')[0].replace(/^(Working|Running):\s*/, '') : 'Working'} /> : null}
      {m.status === 'error' ? (
        <View style={st.error}>
          <T size={14} lineHeight={20} color="#ffb3c0" style={{ flexShrink: 1 }}>{m.error || 'Something went wrong before the reply finished.'}</T>
          {isLast && onRegenerate ? (
            <Press style={st.vcBtn} onPress={() => { impact(); onRegenerate() }}>
              <TI icon={IconRefresh} size={14} color={colors.text} /><T size={13} weight={500}>Try again</T>
            </Press>
          ) : null}
        </View>
      ) : null}
      {m.status === 'stopped' ? <T size={13} color={vc.faint}>Stopped</T> : null}
    </View>
  )

  return (
    <View>
      {items.length && !live ? <MessageMenu items={items}>{body}</MessageMenu> : body}
      {!live && (m.content || m.status === 'error') ? (
        <View style={st.actions}>
          {m.content ? <Act icon={copied ? IconCheck : IconCopy} label={copied ? 'Copied' : 'Copy'} onPress={doCopy} /> : null}
          {isLast && onRegenerate ? <Act icon={IconRefresh} label="Regenerate" onPress={() => { impact(); onRegenerate() }} /> : null}
          {meta ? (
            <TurnChip open={details} onToggle={() => setDetails((d) => !d)}>
              {provider ? <View style={{ opacity: 0.75 }}><ProviderLogo driver={provider.driver} name={provider.name} size={12} /></View> : null}
              <T size={12} color={details ? vc.soft : vc.faint} numberOfLines={1} style={{ flexShrink: 1 }}>{meta}</T>
            </TurnChip>
          ) : null}
        </View>
      ) : null}
      {details && meta && !live ? <TurnStats m={m} modelName={modelName} /> : null}
      <Lightbox source={lightbox} onClose={() => setLightbox(null)} />
    </View>
  )
})

export const st = StyleSheet.create({
  totemSay: { gap: 6, paddingTop: 10, paddingBottom: 12, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1, borderColor: vc.line, backgroundColor: vc.surface },
  totemHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bubble: { maxWidth: '86%', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 22, backgroundColor: vc.bubble },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 4 },
  userAttachments: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginBottom: 8, maxWidth: '80%' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 6, minHeight: 30 },
  act: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  mention: { color: '#b7c9ff', backgroundColor: alpha(colors.accent, 0.24), fontFamily: fonts[500] },
  edit: { width: '100%', backgroundColor: vc.bubble, borderRadius: 22, paddingTop: 12, paddingHorizontal: 14, paddingBottom: 10 },
  editInput: { color: colors.text, fontSize: 15, lineHeight: 23, fontFamily: fonts[400], maxHeight: 320, padding: 0 },
  editActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 6, marginTop: 6 },
  vcBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 14, borderRadius: 999, backgroundColor: vc.raise, borderWidth: 1, borderColor: vc.line },
  vcBtnSm: { height: 30, paddingHorizontal: 12 },
  vcBtnGhost: { backgroundColor: 'transparent', borderColor: 'transparent' },
  vcBtnPrimary: { backgroundColor: colors.text, borderColor: 'transparent' },
  unsent: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginTop: 6 },
  error: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, paddingVertical: 10, paddingLeft: 14, paddingRight: 12, borderRadius: 12, backgroundColor: '#f0506e14', borderWidth: 1, borderColor: '#f0506e40' },
  shot: { borderWidth: 1, borderColor: vc.line, borderRadius: 12, overflow: 'hidden', backgroundColor: vc.code, alignSelf: 'stretch' },
  thumb: { width: 64, height: 64, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: vc.line, backgroundColor: vc.code },
  progressTrack: { position: 'absolute', left: 6, right: 6, bottom: 6, height: 3, borderRadius: 2, backgroundColor: '#ffffff30', overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: '#fff' },
  file: { flexDirection: 'row', alignItems: 'center', gap: 10, maxWidth: 260, height: 56, paddingLeft: 8, paddingRight: 14, borderRadius: 14, backgroundColor: vc.surface, borderWidth: 1, borderColor: vc.line },
  fileIcon: { width: 38, height: 38, borderRadius: 10, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  chipX: { position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 10, backgroundColor: colors.text, borderWidth: 2, borderColor: vc.surface, alignItems: 'center', justifyContent: 'center' },
  filecard: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 72, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 16, backgroundColor: vc.surface, borderWidth: 1, borderColor: vc.line },
  filecardIcon: { width: 40, height: 40, borderRadius: 10, backgroundColor: '#5b8cff1f', alignItems: 'center', justifyContent: 'center' },
  lightbox: { flex: 1, backgroundColor: '#000000e8', alignItems: 'center', justifyContent: 'center', padding: 12 },
  lightboxClose: { position: 'absolute', right: 14, width: 40, height: 40, borderRadius: 20, backgroundColor: '#ffffff1f', alignItems: 'center', justifyContent: 'center' },
})
