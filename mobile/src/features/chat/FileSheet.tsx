// Sheet detents: [0.75, 1] (formSheet, grabber, corner radius 22; registered in src/app/_layout.tsx).
//
// A text file from a chat, read in a sheet (the phone's take on the web's
// canvas panel, chat/ArtifactPanel.tsx): Markdown rendered, a CSV as a table,
// anything else as monospaced text. A Copy button in the corner, and Save or
// share, which downloads it with the app's credentials for the share sheet (the
// in-app browser it used to open can't send them, so behind Cloudflare Access it
// showed Access's login page).
import React, { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import { authHeaders } from '../../lib/api'
import { bridgeFetch } from '../../lib/connection'
import { pushError } from '../../lib/toast'
import Markdown from '../../ui/Markdown'
import { T } from '../../ui/Text'
import { Press, Spinner } from '../../ui/kit'
import { success, tap } from '../../ui/haptics'
import { colors, fonts } from '../../theme'
import { TI, vc } from './ui'
import { IconCopy, IconDownload, IconX } from './icons'
import { refusal, shareFile } from './openLink'
import { bridgePath, uploadPath } from '../../lib/links'

function parseDelimited(text: string, sep: string) {
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') q = false
      else cell += c
    } else if (c === '"') q = true
    else if (c === sep) { row.push(cell); cell = '' }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (c !== '\r') cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.slice(0, 2000)
}

export default function FileSheet() {
  const { id, name = 'File', mime = '', url = '' } = useLocalSearchParams<{ id: string; name?: string; mime?: string; url?: string }>()
  const insets = useSafeAreaInsets()
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState('')
  // The params can arrive by deep link: only a `/`-relative bridge path or an upload id.
  const src = url ? bridgePath(url) : uploadPath(id)
  useEffect(() => {
    if (!src) { setError(`${name} can’t be opened from this link.`); return }
    bridgeFetch(src, { headers: authHeaders() })
      .then(async (r) => { if (!r.ok) throw new Error(refusal({ status: r.status }, name)); setText(await r.text()) })
      .catch((e) => setError(e.message))
  }, [src, name])
  const kind = /markdown/.test(mime) || /\.(md|markdown)$/i.test(name) ? 'markdown' : /csv|tab-separated/.test(mime) || /\.(csv|tsv)$/i.test(name) ? 'table' : 'text'
  const rows = kind === 'table' && text != null ? parseDelimited(text, /\.tsv$/i.test(name) || /tab-separated/.test(mime) ? '\t' : ',') : []
  // The header sits above the scroller, not in it: a drag on it (and on the grabber
  // over it) always moves the sheet, so the file closes from wherever it was read
  // to. Inside the scroller, a downward drag only scrolled back up until the top.
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={st.head}>
        <T size={15} weight={600} numberOfLines={1} style={{ flex: 1 }}>{name}</T>
        {text != null ? (
          <Press style={st.btn} onPress={() => { Clipboard.setStringAsync(text).catch(() => {}); success() }} accessibilityLabel="Copy">
            <TI icon={IconCopy} size={18} color={colors.text} />
          </Press>
        ) : null}
        {!error ? (
          <Press style={st.btn} onPress={() => { tap(); if (src) shareFile(src, name).catch((e) => pushError(e?.message || `Couldn’t download ${name}.`)) }} accessibilityLabel="Save or share">
            <TI icon={IconDownload} size={18} color={colors.text} />
          </Press>
        ) : null}
        <Press style={st.btn} onPress={() => { tap(); router.back() }} accessibilityLabel="Close">
          <TI icon={IconX} size={18} color={colors.text} />
        </Press>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        {error ? <T muted style={{ padding: 20 }}>{error}</T> : text == null ? <View style={{ paddingTop: 40 }}><Spinner /></View> : kind === 'table' ? (
          <ScrollView horizontal contentContainerStyle={{ padding: 16 }}>
            <View>
              {rows.map((r, i) => (
                <View key={i} style={{ flexDirection: 'row' }}>
                  {r.map((c, j) => <T key={j} size={13.5} weight={i === 0 ? 600 : 400} style={[st.cell, i === 0 && { backgroundColor: '#1a1d26' }]} numberOfLines={3}>{c}</T>)}
                </View>
              ))}
            </View>
          </ScrollView>
        ) : (
          <View style={{ paddingHorizontal: 18, paddingTop: 8 }}>
            {kind === 'markdown' ? <Markdown text={text} size={16} /> : <T selectable style={{ fontFamily: fonts.mono, fontSize: 13, lineHeight: 20, color: '#cfd4de' }}>{text}</T>}
          </View>
        )}
      </ScrollView>
    </View>
  )
}

const st = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 18, paddingBottom: 10, paddingHorizontal: 16, backgroundColor: colors.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: vc.line },
  btn: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, borderColor: vc.line, alignItems: 'center', justifyContent: 'center' },
  cell: { borderWidth: StyleSheet.hairlineWidth, borderColor: vc.line, paddingHorizontal: 10, paddingVertical: 6, minWidth: 90, maxWidth: 240 },
})
