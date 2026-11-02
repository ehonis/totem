// Settings → Connections: the web's Source health panel (web/src/sources/
// SourceHealthPanel.tsx), each source with its dot, last OK, "failing since" and
// error, grouped under the goals it feeds. Adding, removing and signing in to
// connections stays on the web dashboard, one tap away.
import React, { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'
import { ApiError, AuthError } from '../../../lib/api'
import { getSourceHealth, groupSources, sourceSummary, type SourceHealth, type SourceHealthPayload } from '../../../lib/sources/health'
import { colors, fonts } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn, Spinner } from '../../../ui/kit'
import { Note, PaneHead, SectionTitle, SettingList, openDashboard, st } from '../ui'

const STATE_LABEL = { ok: 'OK', degraded: 'Erroring', failing: 'Failing', unconfigured: 'Not set up', unknown: 'Not read' }
const DOT = { ok: colors.green, degraded: colors.amber, failing: colors.red, unconfigured: colors.muted, unknown: colors.muted }

function SourceRow({ source }: { source: SourceHealth }) {
  return (
    <View style={[st.row, { alignItems: 'flex-start', gap: 12 }]}>
      <View
        accessibilityLabel={STATE_LABEL[source.state]}
        style={{ width: 8, height: 8, borderRadius: 4, marginTop: 6, backgroundColor: DOT[source.state], opacity: source.state === 'unknown' || source.state === 'unconfigured' ? 0.55 : 1 }}
      />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T size={14} weight={600}>{source.label}</T>
        <T size={12} muted lineHeight={17}>{sourceSummary(source)}</T>
        {(source.state === 'failing' || source.state === 'degraded') && source.error
          ? <T size={11} color={colors.red} lineHeight={16} style={{ fontFamily: fonts.mono }}>{source.error}</T>
          : null}
      </View>
      <T size={11} color={source.state === 'failing' ? colors.red : source.state === 'degraded' ? colors.amber : colors.muted}>
        {STATE_LABEL[source.state]}
      </T>
    </View>
  )
}

export default function ConnectionsPane() {
  const [data, setData] = useState<SourceHealthPayload | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    getSourceHealth().then((d) => { setData(d); setError('') }).catch((e) => {
      if (!(e instanceof AuthError)) setError(e instanceof ApiError || e instanceof Error ? e.message : String(e))
    })
  }, [])
  useEffect(() => { load() }, [load])

  const { goals, other } = groupSources(data)
  const failing = data?.sources.filter((s) => s.state === 'failing').length ?? 0

  return (
    <>
      <PaneHead desc="Every read Totem makes from a connected source, and whether it worked. Add, remove and sign in to connections on the web dashboard." />
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
        <Btn compact title="Refresh" onPress={load} />
        <Btn compact title="Manage on the web" onPress={() => openDashboard('/settings/connections')} />
      </View>
      <Note text={error} error />
      {data?.disabled ? <Note text={`Source health is off until Totem restarts: ${data.disabled}`} error /> : null}
      {!data ? (error ? null : <Spinner />) : data.disabled ? null : !goals.length && !other.length ? (
        <Note text="Nothing has been read from a connected source yet." />
      ) : (
        <>
          <Note text={failing ? `${failing} ${failing === 1 ? 'source is' : 'sources are'} failing.` : 'Nothing is failing.'} />
          {goals.map(({ goal, sources }) => (
            <React.Fragment key={goal.id}>
              <SectionTitle title={goal.title} />
              <SettingList>{sources.map((s) => <SourceRow key={s.source} source={s} />)}</SettingList>
            </React.Fragment>
          ))}
          {other.length ? (
            <>
              <SectionTitle title={goals.length ? 'Other sources' : 'Sources'} />
              <SettingList>{other.map((s) => <SourceRow key={s.source} source={s} />)}</SettingList>
            </>
          ) : null}
        </>
      )}
    </>
  )
}
