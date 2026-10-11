// Search: plain keyword search over memory, chats, journal, tasks, goals, lists,
// projects and totems (web SearchView.tsx + search.css, phone layout). A result's
// full text opens as a sheet rather than expanding in the list.
import React, { useEffect, useRef, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { AuthError, searchEverything, type SearchHit, type SearchResponse } from '../../lib/api'
import { Hi, MagnifyingGlassIcon, XMarkIcon, ChevronRightIcon, ArrowTopRightOnSquareIcon } from '../../lib/icons'
import { pushError } from '../../lib/toast'
import { Screen, FAB_CLEARANCE } from '../../shell/Screen'
import { colors, fonts, alpha } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { KINDS, KindLabel, Marked, AddToChatMenu, openHit, openResultSheet, st as shared } from './shared'

export default function SearchScreen() {
  const [query, setQuery] = useState('')
  const [kinds, setKinds] = useState<string[]>([])
  const [res, setRes] = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [focused, setFocused] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [nonce, setNonce] = useState(0)
  const input = useRef<TextInput>(null)
  const seq = useRef(0)

  // Search as you type, a beat after the last key. A stale reply never
  // overwrites a newer one.
  useEffect(() => {
    const q = query.trim()
    if (!q) { setRes(null); setLoading(false); setRefreshing(false); return }
    const mine = ++seq.current
    setLoading(true)
    const t = setTimeout(() => {
      searchEverything(q, kinds)
        .then((r) => { if (mine === seq.current) setRes(r) })
        .catch((e) => { if (!(e instanceof AuthError)) pushError(e.message) })
        .finally(() => { if (mine === seq.current) { setLoading(false); setRefreshing(false) } })
    }, 140)
    return () => clearTimeout(t)
  }, [query, kinds, nonce])

  const toggleKind = (id: string) => setKinds((k) => (k.includes(id) ? k.filter((x) => x !== id) : [...k, id]))

  const q = query.trim()
  const results = res?.results || []

  return (
    <Screen title="Search">
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: FAB_CLEARANCE }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={q ? <RefreshControl refreshing={refreshing} tintColor={colors.muted} onRefresh={() => { setRefreshing(true); setNonce((n) => n + 1) }} /> : undefined}
      >
        <View style={[st.box, focused && { borderColor: alpha(colors.accent, 0.6) }]}>
          <Hi icon={MagnifyingGlassIcon} size={18} color={colors.muted} />
          <TextInput
            ref={input}
            value={query}
            onChangeText={setQuery}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Search memory, chats, journal, tasks, goals, lists…"
            placeholderTextColor={colors.muted}
            selectionColor={colors.accent}
            keyboardAppearance="dark"
            accessibilityLabel="Search everything"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            returnKeyType="search"
            clearButtonMode="never"
            style={st.input}
          />
          {query ? (
            <Press onPress={() => { setQuery(''); input.current?.focus() }} accessibilityLabel="Clear" hitSlop={8} style={{ padding: 6 }}>
              <Hi icon={XMarkIcon} size={16} color={colors.muted} />
            </Press>
          ) : null}
        </View>

        <View style={st.kinds} accessibilityLabel="Filter by kind">
          {KINDS.map((k) => {
            const n = res?.counts?.[k.id] || 0
            const on = kinds.includes(k.id)
            const fg = on ? colors.text : colors.muted
            return (
              <Press
                key={k.id}
                onPress={() => { tap(); toggleKind(k.id) }}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                style={[st.kind, on && st.kindOn, q && !n && !on ? { opacity: 0.5 } : null]}
              >
                <Hi icon={k.icon} size={14} color={fg} />
                <T size={13} color={fg}>{k.label}</T>
                {q && n > 0 ? <T size={12} style={{ fontVariant: ['tabular-nums'] }}>{n}</T> : null}
              </Press>
            )
          })}
        </View>

        {!q ? (
          <T size={13} muted lineHeight={19} style={st.hint}>
            Plain keyword search, with no AI involved: every word has to match, and "watch" also finds "watches". Open a result, or add it to a chat as context.
          </T>
        ) : null}
        {q && res && !results.length && !loading ? <T size={13} muted style={st.hint}>Nothing matches “{q}”.</T> : null}
        {res?.loose && results.length > 0 ? <T size={13} muted style={st.hint}>Nothing has every word, so these match some of them.</T> : null}

        <View style={loading ? { opacity: 0.6 } : null}>
          {results.map((hit, i) => <ResultRow key={hit.id} hit={hit} first={i === 0} />)}
        </View>
        {res && res.total > results.length ? (
          <T size={13} muted lineHeight={19} style={st.hint}>Showing the top {results.length} of {res.total}. Add a word or pick a kind to narrow it down.</T>
        ) : null}
      </ScrollView>
    </Screen>
  )
}

function ResultRow({ hit, first }: { hit: SearchHit; first: boolean }) {
  return (
    <View style={[st.hit, !first && st.hitRule]}>
      {/* Phone layout: kind and date on one line, the title below it at full width. */}
      <View style={st.head}>
        <KindLabel kind={hit.kind} />
        <View style={{ flex: 1 }} />
        {hit.date ? <T size={12} muted style={{ fontVariant: ['tabular-nums'] }}>{hit.date}</T> : null}
      </View>
      <Press onPress={() => openResultSheet(hit)} accessibilityRole="button">
        <T size={15} weight={600} style={{ marginTop: 4 }}><Marked text={hit.titleMarked || hit.title} /></T>
      </Press>
      {hit.snippet ? (
        <T size={14} lineHeight={21} color="#c3c8d4" style={{ marginTop: 6 }}><Marked text={hit.snippet} /></T>
      ) : null}
      <View style={st.actions}>
        <Press haptic onPress={() => openResultSheet(hit)} style={[st.ghost, shared.sm]}>
          <Hi icon={ChevronRightIcon} size={14} color={colors.muted} />
          <T size={13} muted>Full text</T>
        </Press>
        <Press haptic onPress={() => openHit(hit)} style={[st.ghost, shared.sm]}>
          <Hi icon={ArrowTopRightOnSquareIcon} size={14} color={colors.muted} />
          <T size={13} muted>Open</T>
        </Press>
        <AddToChatMenu hit={hit} />
      </View>
    </View>
  )
}

const st = StyleSheet.create({
  box: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, marginBottom: 12,
    backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, borderRadius: 12,
  },
  input: { flex: 1, minWidth: 0, color: colors.text, fontSize: 16, fontFamily: fonts[400], paddingVertical: 13, paddingHorizontal: 10 },
  kinds: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 16 },
  kind: {
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 11,
    borderRadius: 999, borderWidth: 1, borderColor: colors.line,
  },
  kindOn: { borderColor: colors.accent, backgroundColor: alpha(colors.accent, 0.14) },
  hint: { marginTop: 4, marginHorizontal: 2, marginBottom: 14 },
  hit: { paddingVertical: 14, paddingHorizontal: 2 },
  hitRule: { borderTopWidth: 1, borderTopColor: colors.line },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  ghost: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: 'transparent' },
})
