// The web preview's Markdown. react-native-nitro-markdown parses in native C++,
// which a browser doesn't have, so the preview walks `marked`'s tokens into the
// same RN views and styles as Markdown.tsx. iOS never loads this file.
import React, { useMemo } from 'react'
import { ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native'
import { marked, type Token, type Tokens } from 'marked'
import { colors, fonts, textAlpha } from '../theme'

const LINK = '#8fb0ff'
const LINE = '#2a2f3c'

export function openLink(href: string) {
  if (typeof window !== 'undefined') window.open(href, '_blank', 'noopener')
  return false
}

function inline(tokens: Token[] | undefined, base: TextStyle, key = 'i'): React.ReactNode[] {
  return (tokens || []).map((t, i) => {
    const k = `${key}${i}`
    switch (t.type) {
      case 'strong': return <Text key={k} style={{ fontFamily: fonts[600], color: colors.text }}>{inline((t as Tokens.Strong).tokens, base, k)}</Text>
      case 'em': return <Text key={k} style={{ fontStyle: 'italic' }}>{inline((t as Tokens.Em).tokens, base, k)}</Text>
      case 'del': return <Text key={k} style={{ textDecorationLine: 'line-through' }}>{inline((t as Tokens.Del).tokens, base, k)}</Text>
      case 'codespan': return <Text key={k} style={[st.inlineCode, { fontSize: Math.round((base.fontSize || 15) * 0.86) }]}>{(t as Tokens.Codespan).text}</Text>
      case 'link': return <Text key={k} style={{ color: LINK, textDecorationLine: 'underline' }} onPress={() => openLink((t as Tokens.Link).href)}>{inline((t as Tokens.Link).tokens, base, k)}</Text>
      case 'br': return '\n'
      case 'text': return (t as Tokens.Text).tokens ? inline((t as Tokens.Text).tokens, base, k) : (t as Tokens.Text).text
      case 'escape': return (t as Tokens.Escape).text
      default: return (t as any).raw || ''
    }
  })
}

function block(t: Token, i: number, base: TextStyle, size: number): React.ReactNode {
  switch (t.type) {
    case 'paragraph': return <Text key={i} style={[base, { marginBottom: 14 }]}>{inline((t as Tokens.Paragraph).tokens, base)}</Text>
    case 'heading': {
      const d = (t as Tokens.Heading).depth
      const fs = Math.round(size * (d === 1 ? 1.45 : d === 2 ? 1.25 : d === 3 ? 1.08 : 1))
      return <Text key={i} style={[base, { fontFamily: fonts[600], color: colors.text, fontSize: fs, lineHeight: Math.round(fs * 1.35), marginTop: 18, marginBottom: 10 }]}>{inline((t as Tokens.Heading).tokens, base)}</Text>
    }
    case 'code': {
      const c = t as Tokens.Code
      return (
        <View key={i} style={st.code}>
          <View style={st.codeHead}><Text style={st.codeLang}>{c.lang || 'text'}</Text><Text style={st.copy}>Copy</Text></View>
          <ScrollView horizontal contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 14 }}><Text style={st.codeText}>{c.text}</Text></ScrollView>
        </View>
      )
    }
    case 'list': {
      const l = t as Tokens.List
      return (
        <View key={i} style={{ marginBottom: 14 }}>
          {l.items.map((it, n) => (
            <View key={n} style={{ flexDirection: 'row', marginVertical: 2 }}>
              <Text style={[base, { width: 24, color: textAlpha(40) }]}>{l.ordered ? `${(Number(l.start) || 1) + n}.` : '•'}</Text>
              <View style={{ flex: 1 }}>{it.tokens.map((c, m) => (c.type === 'text' ? <Text key={m} style={base}>{inline((c as Tokens.Text).tokens, base)}</Text> : block(c, m, base, size)))}</View>
            </View>
          ))}
        </View>
      )
    }
    case 'blockquote': return <View key={i} style={{ borderLeftWidth: 3, borderLeftColor: LINE, paddingLeft: 16, marginBottom: 14 }}>{(t as Tokens.Blockquote).tokens.map((c, m) => block(c, m, { ...base, color: textAlpha(62) }, size))}</View>
    case 'hr': return <View key={i} style={{ height: 1, backgroundColor: LINE, marginVertical: 22 }} />
    case 'table': {
      const tb = t as Tokens.Table
      return (
        <ScrollView key={i} horizontal style={{ marginBottom: 16 }}>
          <View>
            <View style={{ flexDirection: 'row' }}>{tb.header.map((h, n) => <Text key={n} style={[base, st.cell, st.th]}>{inline(h.tokens, base)}</Text>)}</View>
            {tb.rows.map((r, n) => <View key={n} style={{ flexDirection: 'row' }}>{r.map((c, m) => <Text key={m} style={[base, st.cell, { fontSize: 14 }]}>{inline(c.tokens, base)}</Text>)}</View>)}
          </View>
        </ScrollView>
      )
    }
    case 'space': return null
    default: return <Text key={i} style={base}>{(t as any).text || (t as any).raw}</Text>
  }
}

export default React.memo(function Markdown({ text, size = 15, muted = false }: { text: string; size?: number; muted?: boolean }) {
  const tokens = useMemo(() => marked.lexer((text || '').replace(/\s+$/, ''), { gfm: true, breaks: true }), [text])
  const base: TextStyle = { fontFamily: fonts[400], fontSize: size, lineHeight: Math.round(size * 1.6), color: muted ? colors.muted : textAlpha(94) }
  return <View style={{ marginBottom: -14 }}>{tokens.map((t, i) => block(t, i, base, size))}</View>
})

const st = StyleSheet.create({
  inlineCode: { fontFamily: fonts.mono, backgroundColor: '#262a36', color: '#e9ecf3', borderRadius: 6, paddingHorizontal: 4 },
  code: { marginBottom: 16, borderRadius: 12, overflow: 'hidden', backgroundColor: '#0b0d12', borderWidth: 1, borderColor: LINE },
  codeHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 34, paddingLeft: 14, paddingRight: 16, backgroundColor: '#161922' },
  codeLang: { fontSize: 12, color: textAlpha(40), fontFamily: fonts[400] },
  copy: { fontSize: 12, color: textAlpha(62), fontFamily: fonts[400] },
  codeText: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 21, color: '#cfd4de' },
  cell: { borderWidth: StyleSheet.hairlineWidth, borderColor: LINE, paddingHorizontal: 12, paddingVertical: 7, minWidth: 80 },
  th: { backgroundColor: '#1a1d26', fontFamily: fonts[600], color: colors.text },
})
