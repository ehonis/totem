// Settings → Activity's detail sheet: a run's live tail (polled on a `since`
// cursor, as the web's RunPanel does, so it survives a dropped connection), a
// finished command's stdout and stderr, or one log entry's why, error and detail.
import React, { useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ApiError, getOutput, getRun, stopRun } from '../../../lib/api'
import { StopSolidIcon } from '../../../lib/icons'
import { pushError, pushSuccess } from '../../../lib/toast'
import { colors, fonts } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn } from '../../../ui/kit'
import { Loading, Pill } from '../ui'
import { clockTime, elapsed, heldEntry, prettyDetail } from './format'

// What an agent did (tool, activity) reads apart from what it is saying (text).
const STREAM_COLOR: Record<string, string> = {
  stderr: colors.red,
  activity: colors.accent,
  tool: colors.accent,
  system: colors.muted,
}

function Mono({ children, color }: { children: React.ReactNode; color?: string }) {
  return <T size={12} lineHeight={17} selectable color={color} style={{ fontFamily: fonts.mono }}>{children}</T>
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <T size={12} weight={600} muted style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</T>
      <View style={st.pre}>{children}</View>
    </View>
  )
}

function RunView({ id, onRetry }: { id: string; onRetry: () => void }) {
  const [live, setLive] = useState<any>(null)
  const [chunks, setChunks] = useState<any[]>([])
  // Why polling stopped: the run aged out (404), or Totem stopped answering.
  const [gone, setGone] = useState<'' | 'aged' | 'unreachable'>('')
  const [retrying, setRetrying] = useState(false)
  const [stopping, setStopping] = useState(false)
  const since = useRef(0)
  const scroll = useRef<ScrollView>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let misses = 0
    const tick = async () => {
      try {
        const d = await getRun(id, since.current)
        if (cancelled) return
        misses = 0
        setRetrying(false)
        if (d.chunks?.length) {
          since.current = d.lastSeq
          setChunks((prev) => [...prev, ...d.chunks])
        }
        setLive(d)
        if (d.status === 'running') timer = setTimeout(tick, 1500)
      } catch (e) {
        if (cancelled) return
        // A 404 is a run aged out of the live registry (its durable copy is under
        // Command outputs). Anything else is the network: keep trying, slower,
        // and stop claiming it is live once a few in a row have failed.
        misses += 1
        if ((e instanceof ApiError && e.status === 404) || misses >= 5) {
          setGone(e instanceof ApiError && e.status === 404 ? 'aged' : 'unreachable')
          setLive((p: any) => (p && p.status === 'running' ? { ...p, status: 'gone' } : p))
        } else {
          setRetrying(true)
          timer = setTimeout(tick, 1500 * 2 ** misses)
        }
      }
    }
    void tick()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [id])

  const stop = async () => {
    setStopping(true)
    try { await stopRun(id); pushSuccess(`Stopping ${id}`) } catch (e: any) { pushError(e?.message || 'Could not stop that run.') } finally { setStopping(false) }
  }

  if (gone && !live) {
    if (gone === 'aged') return <Loading error="This run is no longer in the live list. Finished commands stay under Command outputs." />
    return (
      <View style={{ gap: 12, alignItems: 'center', paddingVertical: 24 }}>
        <T size={14} color={colors.red} style={{ textAlign: 'center' }}>Totem isn’t answering, so this run can’t be shown.</T>
        <Btn title="Try again" onPress={onRetry} />
      </View>
    )
  }
  if (!live) return <Loading label={retrying ? 'Totem isn’t answering. Trying again…' : undefined} />
  const running = live.status === 'running'
  return (
    <>
      <Stack.Screen options={{ title: live.label || id }} />
      <View style={st.head}>
        <View style={{ flex: 1, gap: 2 }}>
          <T size={16} weight={600} numberOfLines={2}>{live.label || id}</T>
          <T size={12.5} muted>{[id, live.provider ? `${live.provider}${live.model ? `/${live.model}` : ''}` : '', live.actor].filter(Boolean).join(' · ')}</T>
        </View>
        {running
          ? <Pill label={`Running · ${elapsed(live.ms)}`} tone="warn" />
          : live.status === 'gone'
            ? <Pill label="Not live any more" />
            : <Pill label={`${live.status === 'ok' ? 'Done' : live.error || live.status}${live.exitCode != null ? ` · exit ${live.exitCode}` : ''} · ${elapsed(live.ms)}`} tone={live.status === 'ok' ? 'ok' : 'error'} />}
      </View>
      {gone && live.status === 'gone' ? (
        <T size={12.5} muted lineHeight={17}>
          {gone === 'aged' ? 'This run left the live list. If it finished, its output is under Command outputs.' : 'Totem stopped answering, so this is the last of the run it sent.'}
        </T>
      ) : null}
      {gone === 'unreachable' && live.status === 'gone' ? <Btn compact title="Try again" onPress={onRetry} style={{ alignSelf: 'flex-start' }} /> : null}
      {running && live.canStop ? (
        <Btn kind="danger" icon={StopSolidIcon} title={stopping ? 'Stopping…' : 'Stop'} disabled={stopping} onPress={stop} style={{ alignSelf: 'flex-start' }} />
      ) : null}
      {live.truncated ? <T size={12.5} muted>Earlier output was dropped; this is the most recent 256 KB.</T> : null}
      <View style={st.pre}>
        {chunks.length ? (
          <ScrollView ref={scroll} style={{ maxHeight: 520 }} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
            <T size={12} lineHeight={17} selectable style={{ fontFamily: fonts.mono }}>
              {chunks.map((c) => (
                <T key={c.seq} size={12} color={STREAM_COLOR[c.stream]} style={{ fontFamily: fonts.mono }}>
                  {c.stream === 'activity' || c.stream === 'tool' ? `▸ ${c.text}` : c.text}
                </T>
              ))}
              {running ? '▋' : ''}
            </T>
          </ScrollView>
        ) : <T size={13} muted>{running ? 'Waiting for output…' : 'No output.'}</T>}
      </View>
    </>
  )
}

function OutputView({ id }: { id: string }) {
  const [body, setBody] = useState<any>(null)
  const [error, setError] = useState('')
  useEffect(() => { getOutput(id).then(setBody).catch((e) => setError(e?.message || 'Could not read that output.')) }, [id])
  if (!body) return <Loading error={error} />
  return (
    <>
      <Stack.Screen options={{ title: body.label || id }} />
      <View style={st.head}>
        <View style={{ flex: 1, gap: 2 }}>
          <T size={15} weight={600} style={{ fontFamily: fonts.mono }} numberOfLines={3}>{body.label || id}</T>
          <T size={12.5} muted>{[body.id, body.cwd, body.ms != null ? `${body.ms}ms` : ''].filter(Boolean).join(' · ')}</T>
        </View>
        <Pill label={`exit ${body.exitCode ?? '—'}${body.timedOut ? ' · timed out' : ''}`} tone={body.ok ? 'ok' : 'error'} />
      </View>
      {body.stdout ? <Block label="stdout"><Mono>{body.stdout}</Mono></Block> : null}
      {body.stderr ? <Block label="stderr"><Mono color={colors.red}>{body.stderr}</Mono></Block> : null}
      {!body.stdout && !body.stderr ? <T muted>No output.</T> : null}
    </>
  )
}

function EntryView({ id }: { id: string }) {
  const e = heldEntry(id)
  if (!e) return <Loading error="This entry is no longer open. Go back to the log and tap it again." />
  const detail = prettyDetail(e.detail)
  return (
    <>
      <Stack.Screen options={{ title: e.action }} />
      <View style={st.head}>
        <View style={{ flex: 1, gap: 2 }}>
          <T size={15} weight={600} style={{ fontFamily: fonts.mono }}>{e.action}</T>
          <T size={12.5} muted>{[clockTime(e.iso, e.timezone), e.actor, e.channel, e.ms != null ? `${e.ms}ms` : ''].filter(Boolean).join(' · ')}</T>
        </View>
        <Pill label={e.status} tone={e.status === 'ok' ? 'ok' : e.status === 'error' ? 'error' : undefined} />
      </View>
      {e.summary || e.target ? <T size={14} lineHeight={20}>{e.summary || e.target}</T> : null}
      {e.why ? <Block label="Why"><T size={13} lineHeight={19} selectable>{e.why}</T></Block> : null}
      {e.error ? <Block label="Error"><Mono color={colors.red}>{e.error}</Mono></Block> : null}
      {e.correlationId ? <T size={12.5} muted selectable>Chain {e.correlationId}</T> : null}
      {detail ? <Block label="Detail"><Mono>{detail}</Mono></Block> : null}
    </>
  )
}

export default function LogSheet() {
  const { kind, id } = useLocalSearchParams<{ kind?: string; id?: string }>()
  const insets = useSafeAreaInsets()
  // Bumped by Try again: a fresh RunView starts polling from the beginning.
  const [attempt, setAttempt] = useState(0)
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg2 }} contentContainerStyle={[st.body, { paddingBottom: insets.bottom + 28 }]}>
      {!id ? <Loading error="Nothing to show." />
        : kind === 'run' ? <RunView key={attempt} id={id} onRetry={() => setAttempt((n) => n + 1)} />
          : kind === 'output' ? <OutputView id={id} />
            : <EntryView id={id} />}
    </ScrollView>
  )
}

const st = StyleSheet.create({
  body: { padding: 18, paddingTop: 24, gap: 14 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  pre: { padding: 12, borderRadius: 10, backgroundColor: colors.bg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
})
