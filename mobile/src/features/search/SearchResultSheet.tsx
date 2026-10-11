// One search result's full text (the web's "Full text" expander), as a sheet:
// where it lives, the document rendered as Markdown, and Open / Add to chat.
import React, { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AuthError, getSearchDoc, type SearchHit } from '../../lib/api'
import { ArrowTopRightOnSquareIcon } from '../../lib/icons'
import { pushError } from '../../lib/toast'
import Markdown from '../../ui/Markdown'
import { colors, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Spinner } from '../../ui/kit'
import { AddToChatMenu, KindLabel, Marked, openHit, recallHit } from './shared'

export default function SearchResultSheet() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const insets = useSafeAreaInsets()
  const [doc, setDoc] = useState<(SearchHit & { body: string; location: string }) | null>(null)
  const [failed, setFailed] = useState('')
  const known = id ? recallHit(id) : undefined
  const hit: SearchHit | null = known || (doc ? { ...doc } : null)

  useEffect(() => {
    if (!id) return
    let alive = true
    getSearchDoc(id)
      .then((d) => { if (alive) setDoc(d) })
      .catch((e) => {
        if (!alive || e instanceof AuthError) return
        setFailed(e.message)
        pushError(e.message)
      })
    return () => { alive = false }
  }, [id])

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg2 }}>
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 24, paddingBottom: insets.bottom + 28 }}>
        {hit ? <KindLabel kind={hit.kind} /> : null}
        <T size={19} weight={700} lineHeight={25} style={{ marginTop: 6 }} selectable>
          {hit ? <Marked text={hit.titleMarked || hit.title} /> : ''}
        </T>
        {hit?.date ? <T size={12} muted style={{ marginTop: 4, fontVariant: ['tabular-nums'] }}>{hit.date}</T> : null}

        {hit ? (
          <View style={st.actions}>
            <Btn compact title="Open" icon={ArrowTopRightOnSquareIcon} onPress={() => { router.back(); openHit(hit) }} />
            <AddToChatMenu hit={hit} onDone={() => router.back()} />
          </View>
        ) : null}

        {doc ? (
          <View style={st.full}>
            <T size={12} muted style={{ fontFamily: fonts.mono, marginBottom: 8 }} selectable>{doc.location}</T>
            <Markdown text={doc.body} size={14} />
          </View>
        ) : failed ? (
          <T muted style={{ marginTop: 16 }}>{failed}</T>
        ) : (
          <Spinner />
        )}
      </ScrollView>
    </View>
  )
}

const st = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 8, marginTop: 14, flexWrap: 'wrap' },
  // .search-hit-full
  full: { marginTop: 16, paddingVertical: 12, paddingHorizontal: 14, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line, borderRadius: 10 },
})
