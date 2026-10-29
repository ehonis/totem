// Sheet detents: [0.6, 1] (formSheet, grabber, corner radius 22; registered in src/app/_layout.tsx).
//
// The agents a chat's agent handed work to (web chat/AgentsPanel.tsx, after T3
// Code's sub-agents): one row per agent with its status, model, time and what it
// is doing right now; a row opens into that agent's own log — what it thought,
// what it said and every tool it called, live while it runs. The bridge fills
// `part.agent` (chat/subagents.mjs); this only reads the thread. The web keeps
// it in a side panel; a phone opens it as a sheet from the reply's card or the
// header chip.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useChat, showAgents, focusAgent } from '../../lib/chat/store'
import type { AgentInfo, AgentStep, ChatThread, ToolPart } from '../../lib/chat/types'
import Markdown from '../../ui/Markdown'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { colors, fonts } from '../../theme'
import Spark, { Shimmer } from './Spark'
import { TI, ProviderLogo, toolApp, toolIcon, formatDuration, agentName, vc } from './ui'
import { IconCheck, IconChevronRight, IconChevronDown, IconChevronUp, IconBrain, IconRobot, IconX } from './icons'

export interface AgentEntry { toolId: string; agent: AgentInfo; part: ToolPart }

function collect(thread?: ChatThread): AgentEntry[] {
  const out: AgentEntry[] = []
  for (const m of thread?.messages || []) {
    for (const p of m.parts || []) if (p.type === 'tool' && p.agent) out.push({ toolId: p.id, agent: p.agent, part: p })
  }
  return out
}

export function useThreadAgents(threadId: string | null) {
  const thread = useChat((s) => (threadId ? s.threads.find((t) => t.id === threadId) : undefined))
  return useMemo(() => collect(thread), [thread])
}

const STATUS: Record<AgentInfo['status'], string> = { running: 'Working', done: 'Done', error: 'Failed', stopped: 'Stopped' }
const STATUS_COLOR: Record<AgentInfo['status'], string> = { running: colors.accent, done: '#6fcf8a', error: '#ff7a8f', stopped: vc.faint }

/** Re-render every second while something is running, for the elapsed clocks. */
function useTick(on: boolean) {
  const [, setT] = useState(0)
  useEffect(() => {
    if (!on) return
    const id = setInterval(() => setT((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [on])
}

const elapsedOf = (a: AgentInfo) => (a.startedAt ? (a.endedAt || Date.now()) - a.startedAt : 0)
const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const firstLine = (s?: string) => (s || '').split('\n').map((l) => l.trim()).find(Boolean) || ''

/** What it is doing right now, in one line. */
export function agentNow(a: AgentInfo) {
  const last = a.steps[a.steps.length - 1]
  if (last?.kind === 'tool') return [last.title, last.detail].filter(Boolean).join(' · ')
  if (last?.kind === 'thinking') return 'Thinking'
  if (last?.kind === 'text') return firstLine(last.text)
  return a.progress || 'Starting'
}

export const agentHeading = (a: AgentInfo) => (a.via === 'cli' ? `Asked ${agentName(a.provider)}` : `${agentName(a.provider)} sub-agent${a.name && a.name !== 'general-purpose' ? ` · ${a.name}` : ''}`)

/** Open the sheet, on one agent (its tool card id) or on whichever is working. */
export function openAgents(focus: string | null = null) {
  tap()
  showAgents(true, focus)
  router.push('/chat/agents')
}

export default function AgentsSheet() {
  const insets = useSafeAreaInsets()
  const threadId = useChat((s) => s.activeId)
  const focus = useChat((s) => s.agentFocus)
  const agents = useThreadAgents(threadId)
  const running = agents.filter((e) => e.agent.status === 'running').length
  useTick(running > 0)
  const scroller = useRef<ScrollView>(null)
  const atBottom = useRef(true)
  // The store's panel flag follows the sheet: closed when it goes.
  useEffect(() => () => showAgents(false), [])

  // Unchosen, the sheet opens the agent working now (or the latest one); '' means
  // he folded them all.
  const shown = focus === '' ? null
    : agents.find((e) => e.toolId === focus) || [...agents].reverse().find((e) => e.agent.status === 'running') || agents[agents.length - 1] || null
  const done = agents.length - running

  return (
    <ScrollView
      ref={scroller}
      style={{ backgroundColor: SHEET_BG }}
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 22, paddingBottom: insets.bottom + 28 }}
      scrollEventThrottle={64}
      onScroll={(e) => { const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent; atBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 40 }}
      // A live log stays pinned to its newest step unless he scrolled up to read.
      onContentSizeChange={() => { if (atBottom.current && shown?.agent.status === 'running') scroller.current?.scrollToEnd({ animated: false }) }}
    >
      <View style={st.head}>
        <TI icon={IconRobot} size={20} color={colors.text} />
        <T size={17} weight={600}>Agents</T>
        {agents.length > 0 ? (
          <T size={13} color={vc.soft} numberOfLines={1} style={{ flexShrink: 1 }}>
            {[running ? `${running} working` : '', done ? `${done} finished` : ''].filter(Boolean).join(' · ')}
          </T>
        ) : null}
      </View>
      {!agents.length ? (
        <View style={st.empty}>
          <TI icon={IconRobot} size={28} color={vc.faint} />
          <T size={15} weight={600}>No agents yet</T>
          <T size={13.5} lineHeight={20} color={vc.soft} align="center">When this chat hands work to another agent, such as a Claude sub-agent or Codex run from a command, it shows up here with its status and its own log.</T>
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          {agents.map((e) => (
            <AgentRow key={e.toolId} entry={e} open={shown?.toolId === e.toolId} onToggle={() => { tap(); focusAgent(shown?.toolId === e.toolId ? '' : e.toolId) }} />
          ))}
        </View>
      )}
    </ScrollView>
  )
}

function AgentRow({ entry, open, onToggle }: { entry: AgentEntry; open: boolean; onToggle: () => void }) {
  const a = entry.agent
  const ms = elapsedOf(a)
  const meta = [
    agentHeading(a),
    a.model,
    ms >= 1000 ? formatDuration(ms) : '',
    a.tokens ? `${compact(a.tokens)} tokens` : '',
    a.steps.length ? `${a.steps.length + (a.dropped || 0)} step${a.steps.length === 1 ? '' : 's'}` : a.toolUses ? `${a.toolUses} tool use${a.toolUses === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ')
  return (
    <View style={[st.agent, open && { borderColor: '#3a4152' }]}>
      <Press onPress={onToggle} style={st.agentHead} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <ProviderLogo driver={a.provider} name={agentName(a.provider)} size={22} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T size={15} weight={500} numberOfLines={2}>{a.title || firstLine(a.prompt) || agentHeading(a)}</T>
          <T size={12.5} color={vc.faint} numberOfLines={2}>{meta}</T>
          {a.status === 'running' ? <Shimmer text={agentNow(a)} size={12.5} /> : null}
        </View>
        <View style={st.status}>
          <View style={[st.dot, { backgroundColor: STATUS_COLOR[a.status] }]} />
          <T size={12} color={STATUS_COLOR[a.status] === vc.faint ? vc.soft : STATUS_COLOR[a.status]}>{STATUS[a.status]}</T>
        </View>
        <TI icon={IconChevronRight} size={15} color={vc.faint} style={open ? { transform: [{ rotate: '90deg' }] } : undefined} />
      </Press>
      {open ? <AgentLog agent={a} /> : null}
    </View>
  )
}

function AgentLog({ agent: a }: { agent: AgentInfo }) {
  const [prompt, setPrompt] = useState(false)
  const running = a.status === 'running'
  const lastText = [...a.steps].reverse().find((s) => s.kind === 'text')?.text?.trim()
  const showResult = !running && a.summary && a.summary.trim() !== lastText
  const name = agentName(a.provider)
  return (
    <View style={st.log}>
      {a.prompt ? (
        <View>
          <Press onPress={() => { tap(); setPrompt((p) => !p) }} style={st.disclosure} accessibilityState={{ expanded: prompt }}>
            <TI icon={IconChevronRight} size={13} color={vc.faint} style={prompt ? { transform: [{ rotate: '90deg' }] } : undefined} />
            <T size={13} color={vc.soft}>What it was asked</T>
          </Press>
          {prompt ? <T size={12.5} lineHeight={18} selectable style={st.pre}>{a.prompt}</T> : null}
        </View>
      ) : null}
      {a.dropped ? <T size={12.5} color={vc.faint}>{a.dropped} earlier step{a.dropped === 1 ? '' : 's'} not kept.</T> : null}
      {a.steps.map((s) => <StepRow key={s.id} step={s} />)}
      {running && !a.steps.length ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Spark size={13} />
          <T size={12.5} color={vc.faint} style={{ flexShrink: 1 }}>{a.log === 'none' || a.log === 'off' ? `${name} is working. Its steps aren't visible from here; what it hands back appears when it finishes.` : `Waiting for ${name}'s first step…`}</T>
        </View>
      ) : null}
      {(a.log === 'none' || a.log === 'off') && !running && !a.steps.length ? (
        <T size={12.5} color={vc.faint}>{a.log === 'off' ? `${name} was started without a session log, so only what it printed is shown.` : a.via === 'cli' && (a.provider === 'codex' || a.provider === 'claude') ? `${name}'s own log wasn't found, so only what it printed is shown.` : `${name} keeps no log Totem can read, so only what it printed is shown.`}</T>
      ) : null}
      {showResult ? (
        <View style={st.result}>
          <T size={11.5} weight={600} color={vc.faint}>{a.status === 'error' ? 'ERROR' : 'HANDED BACK'}</T>
          <Markdown text={a.summary!} size={14.5} />
        </View>
      ) : null}
    </View>
  )
}

function StepRow({ step }: { step: AgentStep }) {
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
      <Press onPress={() => { if (hasBody) { tap(); setOpen((o) => !o) } }} disabled={!hasBody} style={st.toolHead}>
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
}

const ROW_STATE: Record<AgentInfo['status'], string> = { running: 'Running', done: 'Done', error: 'Failed', stopped: 'Stopped' }
const DOT: Partial<Record<AgentInfo['status'], string>> = { running: '#6fa8ff', error: '#ff7a8f', stopped: vc.faint }

function AgentAvatar({ a, dot, overlap }: { a: AgentInfo; dot?: boolean; overlap?: boolean }) {
  return (
    <View style={[st.avatar, overlap && { marginLeft: -9 }]}>
      <ProviderLogo driver={a.provider} name={agentName(a.provider)} size={14} />
      {dot && DOT[a.status] ? <View style={[st.avatarDot, { backgroundColor: DOT[a.status] }]} /> : null}
    </View>
  )
}

/**
 * In the reply: the agents it started back to back, as one group the way T3
 * Code draws them (web AgentGroup): avatars, how many are working, the time
 * since the first started, folding open to one row per agent. A row opens the
 * sheet on it.
 */
export function AgentGroup({ tools }: { tools: ToolPart[] }) {
  const agents = tools.map((t) => t.agent!)
  const running = agents.filter((a) => a.status === 'running').length
  const failed = agents.filter((a) => a.status === 'error').length
  const [open, setOpen] = useState(true)
  useTick(running > 0)
  const starts = agents.map((a) => a.startedAt).filter((n): n is number => !!n)
  const ends = agents.map((a) => (a.status === 'running' ? Date.now() : a.endedAt)).filter((n): n is number => !!n)
  const ms = starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : 0
  const state = running ? `${running} working` : failed ? `${failed} failed` : 'Finished'
  const label = `${agents.length} ${agents.length === 1 ? 'subagent' : 'subagents'}`
  return (
    <View style={{ gap: 6 }}>
      <Press onPress={() => { tap(); setOpen((o) => !o) }} style={st.groupHead} accessibilityLabel={`${label}, ${state}`} accessibilityState={{ expanded: open }}>
        <View style={{ flexDirection: 'row' }}>
          {agents.slice(0, 3).map((a, i) => <AgentAvatar key={i} a={a} overlap={i > 0} />)}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={13.5} weight={600}>{label}</T>
          <T size={12} color={running ? '#6fa8ff' : failed ? '#ff7a8f' : vc.faint}>{state}</T>
        </View>
        {ms >= 1500 ? <T size={12.5} color={vc.faint} style={{ fontVariant: ['tabular-nums'] }}>{formatDuration(ms)}</T> : null}
        <TI icon={open ? IconChevronUp : IconChevronDown} size={15} color={vc.faint} />
      </Press>
      {open ? (
        <View style={st.rows}>
          {tools.map((t) => <GroupRow key={t.id} tool={t} />)}
        </View>
      ) : null}
    </View>
  )
}

function GroupRow({ tool }: { tool: ToolPart }) {
  const a = tool.agent!
  const running = a.status === 'running'
  const ms = elapsedOf(a)
  const name = a.title || firstLine(a.prompt) || tool.title || agentHeading(a)
  const now = running ? `Running ${agentNow(a)}` : firstLine(a.summary) || agentHeading(a)
  return (
    <Press onPress={() => openAgents(tool.id)} style={st.row} accessibilityLabel={`${name}, ${ROW_STATE[a.status]}`}>
      <AgentAvatar a={a} dot />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          <T size={13.5} weight={600} numberOfLines={1} style={{ flexShrink: 1 }}>{name}</T>
          <T size={11.5} color={a.status === 'error' ? '#ff7a8f' : vc.faint}>{ROW_STATE[a.status]}</T>
        </View>
        <T size={12.5} color={vc.soft} numberOfLines={1}>{now}</T>
      </View>
      {ms >= 1500 ? <T size={12} color={vc.faint} style={{ fontVariant: ['tabular-nums'] }}>{formatDuration(ms)}</T> : null}
      <TI icon={IconChevronRight} size={15} color={vc.faint} />
    </Press>
  )
}

/** The header chip that opens the sheet, while the chat has agents. */
export function AgentsChip({ threadId }: { threadId: string | null }) {
  const agents = useThreadAgents(threadId)
  if (!agents.length) return null
  const running = agents.filter((e) => e.agent.status === 'running').length
  return (
    <Press onPress={() => openAgents()} style={[st.chip, running > 0 && { borderColor: '#5b8cff66' }]} hitSlop={6} accessibilityLabel={running ? `${running} agents working` : `${agents.length} agents`}>
      <TI icon={IconRobot} size={15} color={running ? '#a9c1ff' : vc.soft} />
      <T size={12} color={running ? '#a9c1ff' : vc.soft} style={{ fontVariant: ['tabular-nums'] }}>{running || agents.length}</T>
    </Press>
  )
}

const SHEET_BG = colors.bg2

const st = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14, paddingHorizontal: 4 },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 36, paddingHorizontal: 20 },
  agent: { borderRadius: 14, borderWidth: 1, borderColor: vc.line, backgroundColor: '#1a1d26', overflow: 'hidden' },
  agentHead: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 60, paddingVertical: 10, paddingHorizontal: 12 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  log: { gap: 10, paddingHorizontal: 12, paddingBottom: 14, paddingTop: 2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: vc.line },
  disclosure: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36 },
  pre: { fontFamily: fonts.mono, color: '#cfd4de', backgroundColor: vc.code, borderRadius: 8, padding: 10, marginTop: 4, overflow: 'hidden' },
  thinking: { flexDirection: 'row', gap: 8 },
  tool: { borderRadius: 10, borderWidth: 1, borderColor: vc.line, backgroundColor: vc.surface },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40, paddingHorizontal: 10 },
  toolIcon: { width: 22, height: 22, borderRadius: 6, backgroundColor: vc.raise, alignItems: 'center', justifyContent: 'center' },
  result: { gap: 6, padding: 12, borderRadius: 10, backgroundColor: vc.surface },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingVertical: 4, paddingHorizontal: 4 },
  avatar: {
    width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    backgroundColor: vc.raise, borderWidth: 2, borderColor: vc.surface,
  },
  avatarDot: { position: 'absolute', right: -3, bottom: -3, width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: vc.surface },
  rows: { padding: 4, borderRadius: 14, borderWidth: 1, borderColor: vc.line, backgroundColor: vc.surface },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 56, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 26, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1, borderColor: vc.line, marginRight: 4 },
})
