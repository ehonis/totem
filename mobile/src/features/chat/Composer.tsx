// The chat's composer (web chat/Composer.tsx): the box, the files waiting in it,
// the + menu, the model and effort chips, the mic, and one round button that is
// Send, Stop, Steer or Voice depending on what's going on. Sending while a reply
// is running steers it (T3 Code's follow-up): the agent takes the words in
// mid-turn, and if it can't they go back in the box.
//
// Typing "/" or "$" anywhere opens the skills menu above the box (mentions.ts);
// a cited skill is tinted in the text, as the web marks it. Task mode, the
// browser and computer use are no longer switches: every run may use them and
// the agent decides, so a message is always sent as mode 'chat'.
import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState, useEffect, useSyncExternalStore } from 'react'
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native'
import Animated, { FadeIn, FadeOut, useAnimatedStyle, withTiming } from 'react-native-reanimated'
import { MenuView, type MenuAction } from '@react-native-menu/menu'
import * as ImagePicker from 'expo-image-picker'
import * as DocumentPicker from 'expo-document-picker'
import { deleteUpload } from '../../lib/chat/api'
import { insertMention, mentionAtCaret, splitMentions } from '../../lib/chat/mentions'
import type { Attachment, ChatMode, DraftAttachment } from '../../lib/chat/types'
import { getChatCommands, subscribeChatCommands, type ChatCommand } from '../../lib/studio'
import { pushError } from '../../lib/toast'
import { Hi } from '../../lib/icons'
import { alpha, colors, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { impact, tap } from '../../ui/haptics'
import { AttachmentChip, useMentionSet } from './Message'
import { uploadLocalFile, type LocalFile } from './upload'
import { useDictation } from './dictation'
import { TI, vc } from './ui'
import {
  IconArrowUp, IconPlayerStopFilled, IconPlus, IconMicrophone, IconWaveSine, IconX, IconCheck, IconCornerUpRight, IconPuzzle,
} from './icons'

export interface ComposerHandle {
  /** An upload that already exists (Search's "Add to chat"). */
  addAttachment: (a: Attachment) => void
  focus: () => void
  /** Start the mic: voice mode falls back to this when the bridge has no realtime voice. */
  dictate: () => void
}

export interface ComposerProps {
  value: string
  onChange: (v: string) => void
  onSend: (payload: { text: string; attachments: Attachment[]; mode: ChatMode }) => void
  onStop: () => void
  onSteer?: (text: string) => Promise<boolean> | boolean
  onVoice?: () => void
  busy: boolean
  placeholder?: string
  /** Temporary chats don't offer skills, as on the web. */
  allowCommands?: boolean
  maxUploadBytes?: number
  leftSlot?: React.ReactNode
  rightSlot?: React.ReactNode
  /** Tells the chat the box grew, so the list keeps its last message above it. */
  onFocus?: () => void
}

type Draft = DraftAttachment & { progress?: number; localUri?: string }

/**
 * The menu for a `/` or `$` token: Totem's skills with that prefix, then (for `/`)
 * the owner's agent skills. Names that start with the term come first.
 */
function rankCommands(catalog: ChatCommand[], prefix: string, term: string, alone: boolean) {
  const score = (c: ChatCommand) => {
    const name = c.cmd.slice(1)
    if (name.startsWith(term)) return 0
    if (name.includes(term) || c.title.toLowerCase().includes(term)) return 1
    return -1
  }
  const pick = (list: ChatCommand[]) => list
    .map((c) => ({ c, s: score(c) })).filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s).map((x) => x.c)
  const own = pick(catalog.filter((c) => c.kind !== 'agent' && c.cmd.startsWith(prefix) && (alone || c.mode !== 'fill')))
  const agent = prefix === '/' ? pick(catalog.filter((c) => c.kind === 'agent')) : []
  return [...own, ...agent].slice(0, 40)
}

const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const { value, onChange, onSend, onStop, onSteer, onVoice, busy, placeholder: idlePlaceholder = 'Ask Totem anything', allowCommands = true, maxUploadBytes = 25 * 1024 * 1024, leftSlot, rightSlot, onFocus } = props
  const input = useRef<TextInput>(null)
  const { height } = useWindowDimensions()
  const [drafts, setDrafts] = useState<Draft[]>([])
  const selection = useRef({ start: value.length, end: value.length })
  // Where the caret is, so "/" opens the skills menu mid-sentence, not only at the start.
  const [caret, setCaret] = useState(value.length)
  // The token whose menu was closed (its start), so it stays closed while he types on.
  const [dismissed, setDismissed] = useState<number | null>(null)
  const valueRef = useRef(value)
  valueRef.current = value

  // Dictated words go in where the cursor was, with a space if they need one.
  const dictation = useDictation(useCallback((text: string) => {
    const v = valueRef.current
    const { start, end } = selection.current
    const s = Math.min(start, v.length)
    const before = v.slice(0, s)
    const joiner = before && !/\s$/.test(before) ? ' ' : ''
    onChange(before + joiner + text + v.slice(Math.min(end, v.length)))
    requestAnimationFrame(() => input.current?.focus())
  }, [onChange]))
  const [, tick] = useState(0)
  useEffect(() => {
    if (dictation.state?.state !== 'recording') return
    const t = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [dictation.state?.state])

  const upload = useCallback((f: LocalFile) => {
    if (f.size && f.size > maxUploadBytes) { pushError(`${f.name} is larger than ${Math.round(maxUploadBytes / 1e6)} MB`); return }
    const key = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const isImage = /^image\//.test(f.mime)
    setDrafts((d) => [...d, { key, name: f.name, mime: f.mime || 'application/octet-stream', size: f.size || 0, kind: isImage ? 'image' : 'file', localUri: isImage ? f.uri : undefined, status: 'uploading', progress: 0 }])
    uploadLocalFile(f, { onProgress: (p) => setDrafts((d) => d.map((x) => (x.key === key ? { ...x, progress: p } : x))) })
      .then((uploaded) => setDrafts((d) => d.map((x) => (x.key === key ? { ...x, status: 'ready', uploaded, size: uploaded.size || x.size } : x))))
      .catch((e) => {
        setDrafts((d) => d.map((x) => (x.key === key ? { ...x, status: 'error', error: e.message } : x)))
        pushError(e.message)
      })
  }, [maxUploadBytes])

  const addAttachment = useCallback((a: Attachment) => {
    setDrafts((d) => (d.some((x) => x.uploaded?.id === a.id) ? d : [...d, {
      key: `ctx-${a.id}`, name: a.name, mime: a.mime, size: a.size, kind: a.kind, textPreview: a.preview, status: 'ready', uploaded: a,
    }]))
  }, [])

  useImperativeHandle(ref, () => ({ addAttachment, focus: () => input.current?.focus(), dictate: () => { void dictation.start() } }), [addAttachment, dictation])

  function removeDraft(key: string) {
    tap()
    setDrafts((d) => {
      const gone = d.find((x) => x.key === key)
      if (gone?.uploaded) deleteUpload(gone.uploaded.id)
      return d.filter((x) => x.key !== key)
    })
  }

  // --- the + menu: photos, camera, files, and skills -----------------------------
  async function pickPhotos() {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: 10, quality: 0.85 })
    if (r.canceled) return
    for (const a of r.assets) upload({ uri: a.uri, name: a.fileName || `photo-${Date.now()}.jpg`, mime: a.mimeType || 'image/jpeg', size: a.fileSize })
  }
  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync()
    if (!perm.granted) { pushError('Camera access is off. Turn it on in Settings → Totem.'); return }
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.85 })
    if (r.canceled) return
    const a = r.assets[0]
    upload({ uri: a.uri, name: a.fileName || `photo-${Date.now()}.jpg`, mime: a.mimeType || 'image/jpeg', size: a.fileSize })
  }
  async function pickFiles() {
    const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
    if (r.canceled) return
    for (const a of r.assets) upload({ uri: a.uri, name: a.name, mime: a.mimeType || 'application/octet-stream', size: a.size })
  }
  // --- skills ("/" or "$" anywhere) -------------------------------------------------
  // Picking a skill puts `/name` in the message where he typed it, so he can say
  // what to use it on; the bridge sends the skill's instructions with his words.
  // A message that is only a Totem command still runs that skill on its own.
  const catalog = useSyncExternalStore(subscribeChatCommands, getChatCommands, getChatCommands)
  const known = useMentionSet()
  const token = allowCommands && !dictation.state ? mentionAtCaret(value, Math.min(caret, value.length)) : null
  const query = token && token.start !== dismissed ? token : null
  // Only the token in an otherwise empty box can take a fill-mode skill's prefix.
  const alone = !!query && query.start === 0 && !value.slice(query.end).trim()
  const matches = useMemo(() => (query ? rankCommands(catalog, query.prefix, query.term, alone) : []), [catalog, query?.prefix, query?.term, alone]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!token) setDismissed(null) }, [token?.start]) // eslint-disable-line react-hooks/exhaustive-deps

  function placeCaret(next: string, pos: number) {
    onChange(next)
    setCaret(pos)
    selection.current = { start: pos, end: pos }
    requestAnimationFrame(() => { input.current?.focus(); (input.current as any)?.setSelection?.(pos, pos) })
  }

  function chooseCommand(c: ChatCommand) {
    if (!query) return
    tap()
    if (c.mode === 'fill' && alone) { placeCaret(c.text, c.text.length); return }
    const { value: next, caret: pos } = insertMention(value, query.start, query.end, c.cmd)
    placeCaret(next, pos)
  }

  function startMention() {
    const sep = value && !/\s$/.test(value) ? ' ' : ''
    const next = `${value}${sep}/`
    setDismissed(null)
    placeCaret(next, next.length)
  }

  // SF Symbols for every row: the native menu draws them at the system's weight.
  const plusActions: MenuAction[] = [
    { id: 'photos', title: 'Photo library', image: 'photo.on.rectangle' },
    { id: 'camera', title: 'Take a photo', image: 'camera' },
    { id: 'files', title: 'Add files', image: 'paperclip' },
    ...(allowCommands && catalog.length ? [{
      id: 'skills', title: '', displayInline: true, subactions: [
        { id: 'skill', title: 'Use a skill', subtitle: 'Or type / anywhere in the message', image: 'sparkles' },
      ],
    }] : []),
  ]
  function onPlus(id: string) {
    tap()
    if (id === 'photos') pickPhotos().catch((e) => pushError(e.message))
    else if (id === 'camera') takePhoto().catch((e) => pushError(e.message))
    else if (id === 'files') pickFiles().catch((e) => pushError(e.message))
    else if (id === 'skill') startMention()
  }

  // --- sending ------------------------------------------------------------------
  const uploading = drafts.some((d) => d.status === 'uploading')
  const ready = drafts.filter((d) => d.status === 'ready' && d.uploaded).map((d) => d.uploaded!)
  const canSend = !busy && !uploading && (value.trim().length > 0 || ready.length > 0)
  // Steering is words only; files wait in the box for the next message.
  const steerable = busy && !!onSteer
  const canSteer = steerable && value.trim().length > 0 && !drafts.length
  const placeholder = steerable ? 'Steer this reply: add context or change course' : idlePlaceholder

  async function steerNow() {
    if (!canSteer || !onSteer) return
    impact()
    const text = value.trim()
    onChange('')
    const ok = await onSteer(text)
    // Not sent: give the words back, unless he has started typing something else.
    if (!ok && !valueRef.current.trim()) onChange(text)
  }

  function send() {
    if (!canSend) return
    impact()
    onSend({ text: value.trim(), attachments: ready, mode: 'chat' })
    setDrafts([])
  }

  const d = dictation.state
  const secs = d ? Math.floor((Date.now() - d.startedAt) / 1000) : 0
  const showVoice = !!onVoice && !busy && !value.trim() && !drafts.length && !d
  const dot = useAnimatedStyle(() => ({ transform: [{ scale: withTiming(1 + Math.min((d?.level || 0) * 6, 0.8), { duration: 90 }) }] }), [d?.level])

  // The cited skills, tinted inside the box. iOS takes styled runs as the input's
  // children; react-native-web can't, so the preview keeps plain text.
  const marked = Platform.OS !== 'web' && known.size > 0 && /[/$]/.test(value)
  const runs = marked ? splitMentions(value, known) : null

  return (
    <View>
    {matches.length > 0 ? (
      <Animated.View entering={FadeIn.duration(120)} exiting={FadeOut.duration(100)} style={st.cmdMenu}>
        <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: Math.min(300, Math.round(height * 0.32)) }} contentContainerStyle={{ padding: 6 }}>
          {matches.map((c, i) => {
            const group = c.kind === 'agent' ? 'Your agent skills' : 'Totem skills'
            const prev = i > 0 ? (matches[i - 1].kind === 'agent' ? 'Your agent skills' : 'Totem skills') : ''
            return (
              <React.Fragment key={c.cmd}>
                {group !== prev ? <T size={12} color={vc.faint} style={{ paddingTop: i ? 10 : 4, paddingBottom: 4, paddingHorizontal: 10 }}>{group}</T> : null}
                <Press style={st.cmd} onPress={() => chooseCommand(c)} accessibilityLabel={`${c.cmd}: ${c.desc}`}>
                  <View style={st.cmdIcon}>{c.kind === 'agent' || !c.icon ? <TI icon={IconPuzzle} size={17} /> : <Hi icon={c.icon} size={17} color={vc.soft} />}</View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                      <T size={14} style={{ fontFamily: fonts.mono }} numberOfLines={1}>{c.cmd}</T>
                      {c.source ? <T size={11} color={vc.faint}>{c.source}</T> : null}
                    </View>
                    <T size={12.5} color={vc.faint} numberOfLines={1}>{c.desc}</T>
                  </View>
                </Press>
              </React.Fragment>
            )
          })}
        </ScrollView>
        <Press style={st.cmdClose} hitSlop={8} onPress={() => { tap(); setDismissed(query!.start) }} accessibilityLabel="Close the skills menu">
          <TI icon={IconX} size={14} color={vc.faint} />
        </Press>
      </Animated.View>
    ) : null}
    <View style={st.box}>
      {drafts.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.tray} style={{ flexGrow: 0 }}>
          {drafts.map((x) => (
            <AttachmentChip
              key={x.key}
              a={{ name: x.name, kind: x.kind, mime: x.mime, size: x.size, localUri: x.localUri, url: x.uploaded?.url, preview: x.textPreview }}
              status={x.status}
              progress={x.progress}
              onRemove={() => removeDraft(x.key)}
            />
          ))}
        </ScrollView>
      ) : null}
      {d ? (
        <Animated.View entering={FadeIn.duration(120)} exiting={FadeOut.duration(100)} style={st.dictation}>
          <Animated.View style={[st.recDot, dot]} />
          <T size={15} color={vc.soft} style={{ fontVariant: ['tabular-nums'] }}>
            {d.state === 'recording' ? `Listening · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : 'Transcribing…'}
          </T>
        </Animated.View>
      ) : (
        <TextInput
          ref={input}
          multiline
          {...(runs ? {} : { value })}
          onChangeText={(v) => { onChange(v); if (v.length !== value.length) setCaret(selection.current.end + v.length - value.length) }}
          onSelectionChange={(e) => { selection.current = e.nativeEvent.selection; setCaret(e.nativeEvent.selection.end) }}
          onFocus={onFocus}
          placeholder={placeholder}
          placeholderTextColor={vc.faint}
          keyboardAppearance="dark"
          selectionColor={colors.accent}
          // On a phone, Return is a newline and the button sends, as in every messaging app.
          returnKeyType="default"
          style={[st.input, { maxHeight: Math.round(height * 0.3) }]}
          accessibilityLabel="Message"
        >
          {runs ? runs.map((p, i) => (p.mention ? <Text key={i} style={st.mention}>{p.text}</Text> : <Text key={i}>{p.text}</Text>)) : null}
        </TextInput>
      )}
      <View style={st.bar}>
        <View style={st.left}>
          {!d ? (
            <MenuView style={{ flexShrink: 0 }} actions={plusActions} themeVariant="dark" onOpenMenu={tap} onPressAction={({ nativeEvent }) => onPlus(nativeEvent.event)}>
              <View style={st.iconBtn} accessibilityRole="button" accessibilityLabel="Add files and more">
                <TI icon={IconPlus} size={20} color={vc.soft} />
              </View>
            </MenuView>
          ) : null}
          {!d ? leftSlot : null}
        </View>
        <View style={st.right}>
          {d ? (
            <>
              <Press style={st.iconBtn} onPress={() => { tap(); dictation.cancel() }} accessibilityLabel="Cancel dictation"><TI icon={IconX} size={18} color={vc.soft} /></Press>
              <Press style={st.send} disabled={d.state !== 'recording'} onPress={() => { impact(); dictation.finish() }} accessibilityLabel="Finish dictation">
                {d.state === 'recording' ? <TI icon={IconCheck} size={18} color="#0f1115" stroke={2.25} /> : <ActivityIndicator size="small" color="#0f1115" />}
              </Press>
            </>
          ) : (
            <>
              {rightSlot}
              {!busy || steerable ? (
                <Press style={st.iconBtn} onPress={() => { tap(); dictation.start() }} accessibilityLabel="Dictate">
                  <TI icon={IconMicrophone} size={20} color={vc.soft} />
                </Press>
              ) : null}
              {busy && steerable && value.trim() ? (
                <>
                  <Press style={st.iconBtn} onPress={() => { impact(); onStop() }} accessibilityLabel="Stop the reply"><TI icon={IconPlayerStopFilled} size={14} color={vc.soft} /></Press>
                  <Press style={[st.send, !canSteer && st.sendOff]} onPress={steerNow} disabled={!canSteer} accessibilityLabel="Steer: send this into the running reply">
                    <TI icon={IconCornerUpRight} size={18} color={canSteer ? '#0f1115' : colors.muted} stroke={2.25} />
                  </Press>
                </>
              ) : busy ? (
                <Press style={st.send} onPress={() => { impact(); onStop() }} accessibilityLabel="Stop"><TI icon={IconPlayerStopFilled} size={14} color="#0f1115" /></Press>
              ) : showVoice ? (
                <Press style={st.send} onPress={() => { impact(); onVoice!() }} accessibilityLabel="Start voice"><TI icon={IconWaveSine} size={19} color="#0f1115" stroke={2} /></Press>
              ) : (
                <Press style={[st.send, !canSend && st.sendOff]} onPress={send} disabled={!canSend} accessibilityLabel={uploading ? 'Waiting for uploads' : 'Send'}>
                  {uploading ? <ActivityIndicator size="small" color={colors.muted} /> : <TI icon={IconArrowUp} size={18} color={canSend ? '#0f1115' : colors.muted} stroke={2.25} />}
                </Press>
              )}
            </>
          )}
        </View>
      </View>
    </View>
    </View>
  )
})

export default Composer

const st = StyleSheet.create({
  box: {
    backgroundColor: vc.surface, borderWidth: 1, borderColor: vc.line, borderRadius: 24,
    paddingTop: 8, paddingRight: 8, paddingBottom: 6, paddingLeft: 10,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 14, shadowOffset: { width: 0, height: 8 },
  },
  tray: { gap: 10, paddingTop: 8, paddingBottom: 10, paddingHorizontal: 2 },
  input: {
    color: colors.text, fontSize: 16, lineHeight: 24, fontFamily: fonts[400],
    paddingTop: Platform.OS === 'ios' ? 8 : 6, paddingBottom: 4, paddingHorizontal: 6, minHeight: 36,
  },
  dictation: { flexDirection: 'row', alignItems: 'center', gap: 12, height: 40, paddingHorizontal: 8 },
  recDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.red, shadowColor: colors.red, shadowOpacity: 0.4, shadowRadius: 4 },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 4, marginTop: 4 },
  left: { flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 1, minWidth: 0 },
  right: { flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 1, minWidth: 0, justifyContent: 'flex-end' },
  iconBtn: { flexShrink: 0, width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  send: { flexShrink: 0, width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.text },
  sendOff: { backgroundColor: '#3a3f4d' },
  mention: { color: '#b7c9ff', backgroundColor: alpha(colors.accent, 0.24), fontFamily: fonts[500] },
  cmdMenu: {
    marginBottom: 8, backgroundColor: vc.menu, borderWidth: 1, borderColor: vc.line, borderRadius: 16,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 12 },
  },
  cmd: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 50, paddingVertical: 7, paddingLeft: 10, paddingRight: 30, borderRadius: 10 },
  cmdIcon: { width: 32, height: 32, borderRadius: 8, backgroundColor: '#12141b', alignItems: 'center', justifyContent: 'center' },
  cmdClose: { position: 'absolute', top: 8, right: 8, width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: vc.raise },
})
