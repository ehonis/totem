// One sub-agent's page, pushed over the chat from its row (T3 Code opens a
// sub-agent's own thread the same way): what it is, what it was asked, its log
// (what it thought, said and every tool it called) and what it handed back.
//
// The chat holds the agent only as a row (`agents=brief`, chat/subagents.mjs), so
// the log is read here from the bridge (GET /api/threads/<id>/agents/<tool id>),
// again every few seconds while the agent works, and drawn in a virtualized list:
// an agent's log runs to hundreds of steps. Its status comes from the chat's row,
// which the reply's stream keeps current.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useChat } from '../../lib/chat/store'
import { getAgentLog } from '../../lib/chat/api'
import type { AgentInfo, AgentStep } from '../../lib/chat/types'
import Markdown from '../../ui/Markdown'
import { T } from '../../ui/Text'
import { Press, Spinner } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { colors, fonts } from '../../theme'
import Spark, { Shimmer } from './Spark'
import { TI, ProviderLogo, toolApp, toolIcon, formatDuration, agentName, vc } from './ui'
import { IconCheck, IconChevronRight, IconBrain, IconX } from './icons'
import { TONE_COLOR, agentHeading, useTick } from './AgentsPanel'
import { AGENT_STATUS_LABEL, agentMeta, agentNowOf, agentTitle, agentTone, elapsedOf, stepCountOf } from './agentRows'

// How often a working agent's log is read again while its page is open.
const POLL_MS = 3000
// The facts the chat's row has fresher than a log read a few seconds ago.
const ROW_KEYS = ['status', 'title', 'model', 'progress', 'summary', 'tokens', 'toolUses', 'endedAt', 'now', 'stepCount', 'lastAt'] as const

const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

export default function AgentScreen() {
  const { thread: threadId = '', tool: toolId = '' } = useLocalSearchParams<{ thread: string; tool: string }>()
  // Selectors return what the store holds (the part, a boolean), never a new object, or every read differs.
  const part = useChat((s) => {
    const t = s.threads.find((x) => x.id === threadId)
    for (const m of t?.messages || []) for (const p of m.parts || []) if (p.type === 'tool' && p.id === toolId && p.agent) return p
    return null
  })
  const latest = useChat((s) => {
    const msgs = s.threads.find((x) => x.id === threadId)?.messages
    return !!msgs?.[msgs.length - 1]?.parts?.some((p) => p.type === 'tool' && p.id === toolId)
  })
  const row = useMemo(() => (part?.type === 'tool' && part.agent ? { agent: part.agent, title: part.title, latest } : null), [part, latest])
  const runHere = useChat((s) => !!s.runs[threadId])
  const [log, setLog] = useState<AgentInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)

  const load = useCallback(async () => {
    if (!threadId || !toolId) return
    try {
      const r = await getAgentLog(threadId, toolId)
      setLog(r.agent)
      setError(null)
    } catch (e: any) {
      if (e?.status === 404) setMissing(true)
      else setError(e?.message || 'Could not load this agent')
    }
  }, [threadId, toolId])

  // The row is fresher for what it carries while the agent works; the log alone has the
  // steps. A row still "running" over a log that has ended is a copy that missed the end.
  const agent: AgentInfo | null = useMemo(() => {
    if (!log && !row) return null
    const out = { ...(log || row!.agent) } as AgentInfo
    const rowNewer = log && row && (log.status === 'running' || row.agent.status !== 'running')
    if (rowNewer) for (const k of ROW_KEYS) if (row!.agent[k] !== undefined) (out as any)[k] = row!.agent[k]
    return out
  }, [log, row])
  const running = agent?.status === 'running'
  const live = running && runHere && !!row?.latest
  useTick(live)

  useFocusEffect(useCallback(() => {
    void load()
    if (!running) return
    const t = setInterval(() => { void load() }, POLL_MS)
    return () => clearInterval(t)
  }, [load, running]))
  // The row says it ended: read the log once more for its last steps and what it handed back.
  const ended = !!log && log.status === 'running' && !!row && row.agent.status !== 'running'
  useEffect(() => { if (ended) void load() }, [ended, load])

  const list = useRef<FlatList<AgentStep>>(null)
  const atBottom = useRef(true)
  const steps = log?.steps || []

  if (!agent) {
    return (
      <View style={st.page}>
        <Stack.Screen options={{ title: 'Agent' }} />
        {missing ? <T size={14} color={vc.soft} style={{ padding: 20 }}>This agent is no longer in the chat.</T>
          : error ? <T size={14} color={colors.red} style={{ padding: 20 }}>{error}</T> : <Spinner />}
      </View>
    )
  }

  return (
    <View style={st.page}>
      <Stack.Screen options={{ title: agentTitle(agent, row?.title || agentHeading(agent)) }} />
      <FlatList
        ref={list}
        data={steps}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => <StepRow step={item} />}
        ItemSeparatorComponent={Gap}
        initialNumToRender={14}
        windowSize={9}
        contentContainerStyle={st.content}
        scrollEventThrottle={64}
        onScroll={(e) => { const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent; atBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 60 }}
        // A working agent's log stays on its newest step unless he scrolled up to read.
        onContentSizeChange={() => { if (running && atBottom.current && steps.length) list.current?.scrollToEnd({ animated: false }) }}
        ListHeaderComponent={<Head agent={agent} live={live} log={log} rowPrompt={row?.agent.prompt} failed={!!error} />}
        ListFooterComponent={<Foot agent={agent} log={log} error={error} />}
      />
    </View>
  )
}

const Gap = () => <View style={{ height: 10 }} />

function Head({ agent: a, live, log, rowPrompt, failed }: { agent: AgentInfo; live: boolean; log: AgentInfo | null; rowPrompt?: string; failed: boolean }) {
  const [prompt, setPrompt] = useState(false)
  const tone = agentTone(a.status)
  const ms = elapsedOf(a, live)
  const name = agentName(a.provider)
  const count = stepCountOf(a)
  const facts = [
    ms >= 1000 ? formatDuration(ms) : '',
    count ? `${count} step${count === 1 ? '' : 's'}` : a.toolUses ? `${a.toolUses} tool use${a.toolUses === 1 ? '' : 's'}` : '',
    a.tokens ? `${compact(a.tokens)} tokens` : '',
  ].filter(Boolean).join(' · ')
  const asked = log?.prompt || rowPrompt
  return (
    <View style={{ gap: 14, marginBottom: 14 }}>
      <View style={st.card}>
        <View style={st.statusLine}>
          <View style={[st.dot, { backgroundColor: TONE_COLOR[tone] }]} />
          <T size={13} weight={600} color={tone === 'stopped' ? vc.soft : TONE_COLOR[tone]}>{AGENT_STATUS_LABEL[a.status]}</T>
          {facts ? <T size={12.5} color={vc.faint} numberOfLines={1} style={{ flexShrink: 1, fontVariant: ['tabular-nums'] }}>{facts}</T> : null}
        </View>
        <View style={st.metaLine}>
          <ProviderLogo driver={a.provider} name={name} size={14} />
          <T size={13} color={vc.soft} numberOfLines={1} style={{ flexShrink: 1 }}>{agentMeta(a, a.via === 'cli' ? `Asked ${name}` : `${name} sub-agent`)}</T>
        </View>
        {a.status === 'running' ? <Shimmer text={agentNowOf(a)} size={13} /> : null}
      </View>
      {asked ? (
        <View>
          <Press onPress={() => { tap(); setPrompt((p) => !p) }} style={st.disclosure} accessibilityRole="button" accessibilityState={{ expanded: prompt }}>
            <TI icon={IconChevronRight} size={13} color={vc.faint} style={prompt ? { transform: [{ rotate: '90deg' }] } : undefined} />
            <T size={13} color={vc.soft}>What it was asked</T>
          </Press>
          {prompt ? <T size={12.5} lineHeight={18} selectable style={st.pre}>{asked}</T> : null}
        </View>
      ) : null}
      <HandedBack agent={a} log={log} failed={failed} />
      {a.dropped && log ? <T size={12.5} color={vc.faint}>{a.dropped} earlier step{a.dropped === 1 ? '' : 's'} not kept.</T> : null}
    </View>
  )
}

/** What a finished agent handed back, first on its page: what he opened it for. */
function HandedBack({ agent: a, log, failed }: { agent: AgentInfo; log: AgentInfo | null; failed: boolean }) {
  const summary = (a.summary || '').trim()
  // Decided once the log is here (it can be the agent's last words), so it never shows and then
  // goes; a log that could not be read leaves the row's summary to show.
  if ((!log && !failed) || a.status === 'running' || !summary || summary === a.title?.trim()) return null
  const lastText = [...(log?.steps || [])].reverse().find((s) => s.kind === 'text')?.text?.trim()
  if (summary === lastText) return null
  return (
    <View style={st.result}>
      <T size={11.5} weight={600} color={vc.faint}>{a.status === 'error' ? 'ERROR' : 'HANDED BACK'}</T>
      <Markdown text={summary} size={14.5} />
    </View>
  )
}

function Foot({ agent: a, log, error }: { agent: AgentInfo; log: AgentInfo | null; error: string | null }) {
  const running = a.status === 'running'
  const name = agentName(a.provider)
  const steps = log?.steps || []
  const noLog = a.log === 'none' || a.log === 'off'
  return (
    <View style={{ gap: 12, marginTop: steps.length ? 14 : 0 }}>
      {!log ? (error ? <T size={13} color={colors.red}>{error}</T> : <Spinner label="Reading its log" />) : null}
      {error && log ? <T size={12.5} color={colors.amber}>Couldn’t refresh: {error}</T> : null}
      {log && running && !steps.length ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Spark size={13} />
          <T size={12.5} color={vc.faint} style={{ flexShrink: 1 }}>{noLog ? `${name} is working. Its steps aren't visible from here; what it hands back appears when it finishes.` : `Waiting for ${name}'s first step…`}</T>
        </View>
      ) : null}
      {log && noLog && !running && !steps.length ? (
        <T size={12.5} color={vc.faint}>{a.log === 'off' ? `${name} was started without a session log, so only what it printed is shown.` : a.via === 'cli' && (a.provider === 'codex' || a.provider === 'claude') ? `${name}'s own log wasn't found, so only what it printed is shown.` : `${name} keeps no log Totem can read, so only what it printed is shown.`}</T>
      ) : null}
    </View>
  )
}

const StepRow = React.memo(function StepRow({ step }: { step: AgentStep }) {
  const [open, setOpen] = useState(false)
  if (step.kind === 'thinking') {
    return (
      <Press onPress={() => { tap(); setOpen((o) => !o) }} style={st.thinking} accessibilityState={{ expanded: open }}>
        <TI icon={IconBrain} size={14} color={vc.faint} style={{ marginTop: 2 }} />
        <T size={13} lineHeight={19} color={vc.faint} numberOfLines={open ? undefined : 2} style={{ flex: 1, fontStyle: 'italic' }}>{step.text}</T>
      </Press>
    )
  }
  if (step.kind === 'text') return <Markdown text={step.text || ''} size={14.5} />
  const hasBody = !!(step.input || step.output)
  const app = toolApp(step.server)
  const ms = step.endedAt && step.at ? step.endedAt - step.at : 0
  return (
    <View style={st.tool}>
      <Press onPress={() => { if (hasBody) { tap(); setOpen((o) => !o) } }} disabled={!hasBody} style={st.toolHead} accessibilityState={hasBody ? { expanded: open } : undefined}>
        <View style={st.toolIcon}><TI icon={toolIcon(step.tool || 'tool', step.server, step.detail)} size={14} /></View>
        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <T size={13} weight={500} numberOfLines={1} style={{ flexShrink: 0, maxWidth: '60%' }}>{step.title || 'Tool call'}</T>
          {app ? <T size={12} color={vc.faint} numberOfLines={1}>{app.label}</T> : null}
          {step.detail ? <T size={12} color={vc.faint} numberOfLines={1} style={{ flexShrink: 1 }}>{step.detail}</T> : null}
        </View>
        {step.status === 'running' ? <Spark size={12} />
          : step.status === 'error' ? <TI icon={IconX} size={13} color="#ff7a8f" />
            : ms >= 1500 ? <T size={12} color={vc.faint}>{formatDuration(ms)}</T> : <TI icon={IconCheck} size={13} color={vc.faint} />}
        {hasBody ? <TI icon={IconChevronRight} size={13} color={vc.faint} style={open ? { transform: [{ rotate: '90deg' }] } : undefined} /> : null}
      </Press>
      {open ? (
        <View style={{ gap: 8, paddingHorizontal: 10, paddingBottom: 10 }}>
          {step.input ? <View><T size={11.5} weight={600} color={vc.faint}>{step.tool === 'command' ? 'COMMAND' : 'INPUT'}</T><T size={12} lineHeight={17} selectable style={st.pre}>{step.input}</T></View> : null}
          {step.output ? <View><T size={11.5} weight={600} color={vc.faint}>{step.status === 'error' ? 'ERROR' : 'RESULT'}</T><T size={12} lineHeight={17} selectable numberOfLines={40} style={st.pre}>{step.output}</T></View> : null}
        </View>
      ) : null}
    </View>
  )
})

const st = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 48 },
  card: { gap: 8, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: vc.line, backgroundColor: vc.surface },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  metaLine: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  disclosure: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36 },
  pre: { fontFamily: fonts.mono, color: '#cfd4de', backgroundColor: vc.code, borderRadius: 8, padding: 10, marginTop: 4, overflow: 'hidden' },
  thinking: { flexDirection: 'row', gap: 8 },
  tool: { borderRadius: 10, borderWidth: 1, borderColor: vc.line, backgroundColor: vc.surface },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40, paddingHorizontal: 10 },
  toolIcon: { width: 22, height: 22, borderRadius: 6, backgroundColor: vc.raise, alignItems: 'center', justifyContent: 'center' },
  result: { gap: 6, padding: 12, borderRadius: 10, backgroundColor: vc.surface },
})
