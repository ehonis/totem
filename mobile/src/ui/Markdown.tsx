// Markdown, the way the web's components/Markdown.tsx and chat.css `.vc .md`
// draw it: Inter at the reading size, links in soft blue that open where they
// belong (openLink below), inline code on a dark chip, fenced code in a panel with its
// language and a Copy button, GFM tables with hairline borders. Parsed natively
// (react-native-nitro-markdown, C++ md4c), rendered as real RN views.
//
//   <Markdown text={md} size={15} muted? />
//
// Like the web (marked, breaks: true), a single newline is a line break.
import React, { useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Image } from 'expo-image'
import { Markdown as NitroMarkdown, type CustomRenderers, type CustomRendererProps, type MarkdownNode, type PartialMarkdownTheme, type NodeStyleOverrides } from 'react-native-nitro-markdown'
import { colors, fonts, surfaces, textAlpha } from '../theme'
import { bridgeUrl, withAccess } from '../lib/connection'
import { tap } from './haptics'
import { followLink } from '../features/chat/openLink'

const LINK = '#8fb0ff'
const LINE = '#2a2f3c'

/**
 * A tapped link: the app follows every kind itself (features/chat/openLink.ts) and
 * returns false so the library never acts. Left to it, mailto: and tel: went to
 * Linking.canOpenURL, which says no for a scheme Info.plist doesn't list, and any
 * href it couldn't parse (a file path, file://) was dropped: a tap that did nothing.
 */
export function openLink(href: string) {
  void followLink(href)
  return false
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
      <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator={false}>
        <View {...OWN_TOUCHES} style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
          <Text style={st.codeText} selectable>{content.replace(/\n$/, '')}</Text>
        </View>
      </ScrollView>
    </View>
  )
}

/**
 * The content of a sideways scroller in a reply (a table, a code block) takes its
 * own touches. A finished reply sits in a long-press Pressable (Message.tsx
 * ReplyMenu), and on iOS a ScrollView refuses to start a drag while a view above
 * it holds the touch (RCTScrollViewComponentView's _shouldDisableScrollInteraction):
 * the Pressable took every touch that began on the scroller, so tables and code
 * stopped scrolling sideways. Claimed here, inside the scroller, the touch no
 * longer belongs to an ancestor. A link in a cell is deeper still, so it keeps its
 * tap. It must cover the whole content, padding included, or a swipe that starts
 * in the gap is blocked again.
 */
const OWN_TOUCHES = { onStartShouldSetResponder: () => true } as const

/** A node's words, for sizing its column. */
function plain(n: MarkdownNode): string {
  return n.children?.length ? n.children.map(plain).join('') : n.content || ''
}

/**
 * The room a cell's text wants: its whole length at about 0.6em a character (Inter),
 * capped so a long cell wraps, but never less than its longest word at 0.8em
 * (capitals and the header's semibold run wider), so a word never breaks mid-word.
 */
function cellRoom(n: MarkdownNode | undefined, font: number, header: boolean) {
  const text = n ? plain(n).trim() : ''
  const word = text.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0)
  return Math.max(Math.min(TABLE_TEXT_MAX, text.length * font * 0.6), Math.min(TABLE_WORD_MAX, word * font * (header ? 0.86 : 0.8)))
}

/**
 * A GFM table (the web's `.md table`), drawn here rather than by the library, so
 * its content can take its own touches (OWN_TOUCHES). Columns are sized from their
 * cells (cellRoom), so a long cell wraps in its column (the web's cells wrap too)
 * and a row's cells share its height. No measuring pass, so nothing re-lays out
 * after it draws. Not one VoiceOver element: a link in a cell stays focusable.
 */
function MdTable({ node, Renderer, size, muted }: CustomRendererProps & { size: number; muted: boolean }) {
  const font = Math.round(size * 0.93)
  const { head, rows, widths, align } = useMemo(() => {
    const head: MarkdownNode[] = []
    const rows: MarkdownNode[][] = []
    for (const part of node.children || []) {
      for (const row of part.children || []) {
        if (row.type !== 'table_row') continue
        if (part.type === 'table_head') head.push(...(row.children || []))
        else if (part.type === 'table_body') rows.push(row.children || [])
      }
    }
    const cols = Math.max(head.length, ...rows.map((r) => r.length))
    const widths = Array.from({ length: cols }, (_, c) =>
      Math.ceil(Math.max(TABLE_TEXT_MIN, cellRoom(head[c], font, true), ...rows.map((r) => cellRoom(r[c], font, false)))) + CELL_PAD)
    const align = Array.from({ length: cols }, (_, c) => head[c]?.align)
    return { head, rows, widths, align }
  }, [node, font])
  if (!widths.length) return null
  const cell = (n: MarkdownNode | undefined, c: number, header: boolean) => (
    <View key={c} style={[st.cell, { width: widths[c] }, c === widths.length - 1 && { borderRightWidth: 0 }]}>
      <Text style={[header ? st.headText : st.cellText, muted && { color: colors.muted }, { fontSize: font, lineHeight: Math.round(font * 1.45), textAlign: (align[c] as 'left' | 'center' | 'right') || 'left' }]}>
        {n?.children?.length ? n.children.map((child, i) => <Renderer key={i} node={child} depth={0} inListItem={false} parentIsText />) : n?.content || ''}
      </Text>
    </View>
  )
  return (
    <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator style={st.tableScroll}>
      <View {...OWN_TOUCHES} style={st.table} role="grid">
        {head.length ? <View style={[st.row, st.headRow]}>{widths.map((_, c) => cell(head[c], c, true))}</View> : null}
        {rows.map((r, i) => (
          <View key={i} style={[st.row, i === rows.length - 1 && { borderBottomWidth: 0 }]}>{widths.map((_, c) => cell(r[c], c, false))}</View>
        ))}
      </View>
    </ScrollView>
  )
}

// A column's text: at least TABLE_TEXT_MIN, wrapping past TABLE_TEXT_MAX, wider
// only for one long word (up to TABLE_WORD_MAX). CELL_PAD is st.cell's padding and border.
const TABLE_TEXT_MIN = 44
const TABLE_TEXT_MAX = 216
const TABLE_WORD_MAX = 300
const CELL_PAD = 26

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

const renderersFor = (size: number, muted: boolean): CustomRenderers => ({
  code_block: ({ content, language }) => <CodeBlock content={content} language={language} />,
  image: ({ url, alt }) => <MdImage url={url} alt={alt} />,
  table: (props) => <MdTable {...props} size={size} muted={muted} />,
  // A model's `<br>` (common in table cells) is a line break, as marked draws it on the web.
  html_inline: ({ node }) => (/^<br\s*\/?>$/i.test((node.content || '').trim()) ? <Text>{'\n'}</Text> : undefined),
  // marked's `breaks: true`: a newline inside a paragraph is a line break. Wrapped
  // in Text so it is safe whether its parent is a Text (a paragraph) or a View (a tight list item).
  soft_break: () => <Text>{'\n'}</Text>,
})

function themeFor(size: number, muted: boolean): { theme: PartialMarkdownTheme; styles: NodeStyleOverrides } {
  const body = muted ? colors.muted : textAlpha(94)
  return {
    theme: {
      colors: {
        text: body, textMuted: colors.muted, heading: muted ? colors.muted : colors.text, link: LINK,
        code: '#e9ecf3', codeBackground: '#262a36', codeLanguage: textAlpha(40),
        blockquote: LINE, border: LINE, surface: 'transparent', surfaceLight: surfaces.tableHead, accent: colors.accent,
        tableBorder: LINE, tableHeader: surfaces.tableHead, tableHeaderText: colors.text, tableRowEven: 'transparent', tableRowOdd: 'transparent',
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
  const renderers = useMemo(() => renderersFor(size, muted), [size, muted])
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
  codeHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 34, paddingLeft: 14, paddingRight: 8, backgroundColor: surfaces.codeHead },
  codeLang: { fontSize: 12, color: textAlpha(40), fontFamily: fonts[400] },
  copy: { fontSize: 12, color: textAlpha(62), fontFamily: fonts[400], paddingHorizontal: 8, paddingVertical: 4 },
  codeText: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 21, color: '#cfd4de' },
  tableScroll: { flexGrow: 0, marginBottom: 16 },
  table: { borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: LINE },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: LINE },
  headRow: { backgroundColor: surfaces.tableHead },
  cell: { paddingVertical: 9, paddingHorizontal: 12, borderRightWidth: 1, borderRightColor: LINE, justifyContent: 'center' },
  headText: { fontFamily: fonts[600], color: colors.text },
  cellText: { fontFamily: fonts[400], color: textAlpha(94) },
})
