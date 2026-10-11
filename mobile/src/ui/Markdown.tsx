// Markdown, the way the web's components/Markdown.tsx and chat.css `.vc .md`
// draw it: Inter at the reading size, links in soft blue that open in the
// in-app browser, inline code on a dark chip, fenced code in a panel with its
// language and a Copy button, GFM tables with hairline borders. Parsed natively
// (react-native-nitro-markdown, C++ md4c), rendered as real RN views.
//
//   <Markdown text={md} size={15} muted? />
//
// Like the web (marked, breaks: true), a single newline is a line break.
import React, { useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as WebBrowser from 'expo-web-browser'
import { Image } from 'expo-image'
import { Markdown as NitroMarkdown, type CustomRenderers, type PartialMarkdownTheme, type NodeStyleOverrides } from 'react-native-nitro-markdown'
import { colors, fonts, textAlpha } from '../theme'
import { bridgeUrl, withAccess } from '../lib/connection'
import { tap } from './haptics'

const LINK = '#8fb0ff'
const LINE = '#2a2f3c'

export function openLink(href: string) {
  if (/^https?:\/\//i.test(href)) {
    WebBrowser.openBrowserAsync(href, { controlsColor: colors.accent, dismissButtonStyle: 'close' }).catch(() => {})
    return false
  }
  // A bridge path ("/api/chat/uploads/…?sig=") opens against the bridge.
  if (href.startsWith('/')) {
    WebBrowser.openBrowserAsync(bridgeUrl(href), { controlsColor: colors.accent }).catch(() => {})
    return false
  }
  return true // mailto:, tel: … the library's own validated fallback
}

/** The `.md-code` panel: language on the left, Copy on the right, the code scrolling sideways. */
function CodeBlock({ content, language }: { content: string; language?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <View style={st.code}>
      <View style={st.codeHead}>
        <Text style={st.codeLang}>{(language || '').replace('plaintext', '') || 'text'}</Text>
        <Text
          style={st.copy}
          suppressHighlighting
          onPress={() => {
            tap()
            Clipboard.setStringAsync(content.replace(/\n$/, '')).catch(() => {})
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 14 }}>
        <Text style={st.codeText} selectable>{content.replace(/\n$/, '')}</Text>
      </ScrollView>
    </View>
  )
}

/** A picture in a reply. Bridge paths resolve against the bridge; a local file the turn hasn't uploaded yet shows nothing. */
function MdImage({ url, alt }: { url: string; alt?: string }) {
  const [ratio, setRatio] = useState(16 / 10)
  const [failed, setFailed] = useState(false)
  if (!url || failed || /^(file:\/\/|\/(?!api\/))/.test(url)) return null
  return (
    <Image
      source={url.startsWith('/') ? { uri: bridgeUrl(url), headers: withAccess() } : { uri: url }}
      accessibilityLabel={alt}
      contentFit="cover"
      onLoad={(e) => { const { width, height } = e.source; if (width && height) setRatio(width / height) }}
      onError={() => setFailed(true)}
      style={{ width: '100%', aspectRatio: ratio, borderRadius: 12, marginBottom: 14, backgroundColor: '#0b0d12' }}
    />
  )
}

const renderers: CustomRenderers = {
  code_block: ({ content, language }) => <CodeBlock content={content} language={language} />,
  image: ({ url, alt }) => <MdImage url={url} alt={alt} />,
  // marked's `breaks: true`: a newline inside a paragraph is a line break. Wrapped
  // in Text so it is safe whether its parent is a Text (a paragraph) or a View (a tight list item).
  soft_break: () => <Text>{'\n'}</Text>,
}

function themeFor(size: number, muted: boolean): { theme: PartialMarkdownTheme; styles: NodeStyleOverrides } {
  const body = muted ? colors.muted : textAlpha(94)
  return {
    theme: {
      colors: {
        text: body, textMuted: colors.muted, heading: muted ? colors.muted : colors.text, link: LINK,
        code: '#e9ecf3', codeBackground: '#262a36', codeLanguage: textAlpha(40),
        blockquote: LINE, border: LINE, surface: 'transparent', surfaceLight: '#1a1d26', accent: colors.accent,
        tableBorder: LINE, tableHeader: '#1a1d26', tableHeaderText: colors.text, tableRowEven: 'transparent', tableRowOdd: 'transparent',
      },
      spacing: { xs: 4, s: 6, m: 10, l: 14, xl: 24 },
      fontSizes: { xs: 12, s: Math.round(size * 0.86), m: size, l: size + 2, xl: size + 6, h1: Math.round(size * 1.45), h2: Math.round(size * 1.25), h3: Math.round(size * 1.08), h4: size, h5: size, h6: size },
      fontFamilies: { regular: fonts[400], heading: fonts[600], mono: fonts.mono },
      // Inter's semibold is its own face; asking iOS for a synthetic bold on top looks smeared.
      headingWeight: 'normal',
      borderRadius: { s: 6, m: 12, l: 12 },
    },
    styles: {
      text: { lineHeight: Math.round(size * 1.6) },
      // The paragraph renders as Text, though the library types it as a view.
      paragraph: { lineHeight: Math.round(size * 1.6), marginBottom: 14 } as any,
      bold: { fontFamily: fonts[600], fontWeight: 'normal', color: muted ? colors.muted : colors.text },
      heading: { marginTop: 18, marginBottom: 10, borderBottomWidth: 0, paddingBottom: 0, letterSpacing: 0 },
      link: { textDecorationColor: '#8fb0ff55' },
      code_inline: { fontFamily: fonts.mono, fontSize: Math.round(size * 0.86) },
      blockquote: { borderLeftWidth: 3, borderLeftColor: LINE, paddingLeft: 16, marginBottom: 14, backgroundColor: 'transparent' },
      horizontal_rule: { backgroundColor: LINE, height: StyleSheet.hairlineWidth, marginVertical: 22 },
      list: { marginBottom: 14 },
    },
  }
}

export default React.memo(function Markdown({ text, size = 15, muted = false }: { text: string; size?: number; muted?: boolean }) {
  const { theme, styles } = useMemo(() => themeFor(size, muted), [size, muted])
  // Trailing paragraph spacing would push the message's action row away.
  const md = (text || '').replace(/\s+$/, '')
  if (!md) return null
  return (
    <NitroMarkdown
      theme={theme}
      styles={styles}
      renderers={renderers}
      options={{ gfm: true, math: false }}
      onLinkPress={openLink}
      style={{ marginBottom: -14 }}
      errorText={md}
    >
      {md}
    </NitroMarkdown>
  )
})

const st = StyleSheet.create({
  code: { marginBottom: 16, borderRadius: 12, overflow: 'hidden', backgroundColor: '#0b0d12', borderWidth: 1, borderColor: LINE },
  codeHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 34, paddingLeft: 14, paddingRight: 8, backgroundColor: '#161922' },
  codeLang: { fontSize: 12, color: textAlpha(40), fontFamily: fonts[400] },
  copy: { fontSize: 12, color: textAlpha(62), fontFamily: fonts[400], paddingHorizontal: 8, paddingVertical: 4 },
  codeText: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 21, color: '#cfd4de' },
})
