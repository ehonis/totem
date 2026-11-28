// Sheet detents: [0.6, 1] (formSheet, grabber, corner radius 22; registered in src/app/_layout.tsx).
//
// The agents a chat's agent handed work to, drawn the way T3 Code's iPhone app draws
// them (ThreadSubagentGroup, SubagentRow, ThreadAgentsSheet): in the reply, one group
// of rows that folds open; each row its status dot and label, title, time, model and
// one line of what it is doing or handed back. A row opens that agent's own page
// (AgentScreen), which reads its log from the bridge, as T3 opens a child's thread.
//
// The chat itself never carries an agent's log here: the app reads chats and runs
// with `agents=brief` (chat/subagents.mjs), so a reply with four agents is rows and
// counts, not 500 KB of steps and an event per step.
import React, { useEffect, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useChat, showAgents } from '../../lib/chat/store'
import type { AgentInfo, ChatThread, ToolPart } from '../../lib/chat/types'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { colors } from '../../theme'
import { TI, ProviderLogo, formatDuration, agentName, vc } from './ui'
import { IconChevronRight, IconChevronDown, IconChevronUp, IconRobot } from './icons'
import { AGENT_STATUS_LABEL, agentMeta, agentTitle, agentTone, elapsedOf, groupElapsed, rowDetail, statusSummary, type AgentTone } from './agentRows'

/** `latest`: in the chat's last message, the only reply a run here can be writing. */
export interface AgentEntry { toolId: string; agent: AgentInfo; part: ToolPart; latest: boolean; messageId: string }

function collect(thread?: ChatThread): AgentEntry[] {
  const out: AgentEntry[] = []
  const msgs = thread?.messages || []
  msgs.forEach((m, i) => {
    for (const p of m.parts || []) if (p.type === 'tool' && p.agent) out.push({ toolId: p.id, agent: p.agent, part: p, latest: i === msgs.length - 1, messageId: m.id })
  })
  return out
}

export function useThreadAgents(threadId: string | null) {
  const thread = useChat((s) => (threadId ? s.threads.find((t) => t.id === threadId) : undefined))
  return useMemo(() => collect(thread), [thread])
}

/** T3's tones, in the chat's colours. */
export const TONE_COLOR: Record<AgentTone, string> = { working: '#6fa8ff', completed: '#6fcf8a', failed: '#ff7a8f', stopped: vc.faint }

/** Re-render every second while something is running, for the elapsed clocks. */
export function useTick(on: boolean) {
  const [, setT] = useState(0)
  useEffect(() => {
    if (!on) return
    const id = setInterval(() => setT((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [on])
}

export const agentHeading = (a: AgentInfo) => (a.via === 'cli' ? `Asked ${agentName(a.provider)}` : `${agentName(a.provider)} sub-agent${a.name && a.name !== 'general-purpose' ? ` · ${a.name}` : ''}`)

/** Open one agent's page (its log), as T3 opens a sub-agent's own thread. */
export function openAgent(threadId: string, toolId: string, { fromSheet = false } = {}) {
  tap()
  // From the sheet the page takes its place, as T3 replaces its agents sheet with the child.
  if (fromSheet) router.back()
  router.push({ pathname: '/chat/agent', params: { thread: threadId, tool: toolId } })
}

/** Open the sheet listing the chat's agents. */
export function openAgents() {
  tap()
  showAgents(true)
  router.push('/chat/agents')
}

/** The header chip's sheet: every agent in the chat, one row each (T3's ThreadAgentsSheet). */
export default function AgentsSheet() {
  const insets = useSafeAreaInsets()
  const threadId = useChat((s) => s.activeId)
  const agents = useThreadAgents(threadId)
  const live = useChat((s) => !!(threadId && s.runs[threadId]))
  useTick(live && agents.some((e) => e.latest && e.agent.status === 'running'))
  // The store's panel flag follows the sheet: closed when it goes.
  useEffect(() => () => showAgents(false), [])

  return (
    <ScrollView style={{ backgroundColor: colors.bg2 }} contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 22, paddingBottom: insets.bottom + 28 }}>
      <View style={st.head}>
        <TI icon={IconRobot} size={20} color={colors.text} />
        <T size={17} weight={600}>Agents</T>
        {agents.length > 0 ? <T size={13} color={vc.soft} numberOfLines={1} style={{ flexShrink: 1 }}>{statusSummary(agents.map((e) => e.agent))}</T> : null}
      </View>
      {!agents.length ? (
        <View style={st.empty}>
          <TI icon={IconRobot} size={28} color={vc.faint} />
          <T size={15} weight={600}>No agents yet</T>
          <T size={13.5} lineHeight={20} color={vc.soft} align="center">When this chat hands work to another agent, such as a Claude sub-agent or Codex run from a command, it shows up here with its status and its own log.</T>
        </View>
      ) : agents.map((e, i) => (
        <Press
          key={e.toolId}
          onPress={() => threadId && openAgent(threadId, e.toolId, { fromSheet: true })}
          style={[st.sheetRow, i > 0 && st.sheetDivider]}
          accessibilityRole="link"
          accessibilityHint="Opens this agent's log"
        >
          <AgentRow agent={e.agent} live={live && e.latest} fallback={e.part.title} />
        </Press>
      ))}
    </ScrollView>
  )
}

/**
 * One agent (T3's SubagentRow): status dot, title · status, its time and a chevron;
 * the provider and model; one line of what it is doing or handed back.
 */
export function AgentRow({ agent: a, live, fallback }: { agent: AgentInfo; live: boolean; fallback?: string }) {
  const tone = agentTone(a.status)
  const ms = elapsedOf(a, live)
  const detail = rowDetail(a)
  const name = agentName(a.provider)
  return (
    <View style={st.rowBody}>
      <View style={st.dotBox}><View style={[st.dot, { backgroundColor: TONE_COLOR[tone] }]} /></View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={st.titleLine}>
          <View style={st.titleRun}>
            <T size={14} weight={600} numberOfLines={1} style={{ flexShrink: 1 }}>{agentTitle(a, fallback || agentHeading(a))}</T>
            <T size={12} color={vc.faint}>·</T>
            <T size={12} weight={500} color={tone === 'stopped' ? vc.soft : TONE_COLOR[tone]}>{AGENT_STATUS_LABEL[a.status]}</T>
          </View>
          {ms >= 1000 ? <T size={12} color={vc.faint} style={{ fontVariant: ['tabular-nums'] }}>{formatDuration(ms)}</T> : null}
          <TI icon={IconChevronRight} size={13} color={vc.faint} />
        </View>
        <View style={st.meta}>
          <ProviderLogo driver={a.provider} name={name} size={12} />
          <T size={12} color={vc.faint} numberOfLines={1} style={{ flexShrink: 1 }}>{agentMeta(a, a.via === 'cli' ? `Asked ${name}` : name)}</T>
        </View>
        {detail ? <T size={12.5} lineHeight={17} color={a.status === 'error' ? TONE_COLOR.failed : vc.soft} numberOfLines={3}>{detail}</T> : null}
      </View>
    </View>
  )
}

function AgentAvatar({ a, overlap }: { a: AgentInfo; overlap?: boolean }) {
  return (
    <View style={[st.avatar, overlap && { marginLeft: -7 }]}>
      <ProviderLogo driver={a.provider} name={agentName(a.provider)} size={14} />
    </View>
  )
}

/**
 * In the reply: the agents it started back to back (T3's ThreadSubagentGroup). One
 * agent is its row; several are a line (avatars, "3 subagents", "2 working · 1 done",
 * the time) that folds open to their rows, folded at first as T3 has it.
 */
export function AgentGroup({ tools, live }: { tools: ToolPart[]; live: boolean }) {
  // A reply is only drawn in the chat that is open.
  const threadId = useChat((s) => s.activeId)
  const agents = tools.map((t) => t.agent!)
  const running = agents.some((a) => a.status === 'running')
  const failed = agents.some((a) => a.status === 'error')
  const grouped = agents.length > 1
  const [open, setOpen] = useState(false)
  useTick(running && live)
  const ms = groupElapsed(agents, live)
  const label = `${agents.length} subagents`
  const summary = statusSummary(agents)
  const rows = (
    <View style={st.rows}>
      {tools.map((t) => (
        <Press
          key={t.id}
          onPress={() => threadId && openAgent(threadId, t.id)}
          style={st.row}
          accessibilityRole="link"
          accessibilityHint="Opens this agent's log"
        >
          <AgentRow agent={t.agent!} live={live} fallback={t.title} />
        </Press>
      ))}
    </View>
  )
  if (!grouped) return rows
  return (
    <View style={{ gap: 6 }}>
      <Press onPress={() => { tap(); setOpen((o) => !o) }} style={st.groupHead} accessibilityRole="button" accessibilityLabel={`${label}, ${summary}`} accessibilityState={{ expanded: open }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {agents.slice(0, 3).map((a, i) => <AgentAvatar key={i} a={a} overlap={i > 0} />)}
          {agents.length > 3 ? <View style={[st.avatar, { marginLeft: -7 }]}><T size={10} color={vc.soft}>+{agents.length - 3}</T></View> : null}
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <T size={14} weight={600} numberOfLines={1}>{label}</T>
          <T size={12} numberOfLines={1} color={running ? TONE_COLOR.working : failed ? TONE_COLOR.failed : vc.faint}>{summary}</T>
        </View>
        {ms >= 1000 ? <T size={12} color={vc.faint} style={{ fontVariant: ['tabular-nums'] }}>{formatDuration(ms)}</T> : null}
        <TI icon={open ? IconChevronUp : IconChevronDown} size={13} color={vc.faint} />
      </Press>
      {open ? rows : null}
    </View>
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

const st = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 36, paddingHorizontal: 20 },
  sheetRow: { paddingVertical: 14 },
  sheetDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: vc.line },
  rowBody: { flexDirection: 'row', gap: 12 },
  dotBox: { height: 20, justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 20 },
  titleRun: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 8, paddingHorizontal: 2 },
  avatar: {
    width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: vc.surface, borderWidth: 1, borderColor: vc.line,
  },
  rows: { padding: 4, gap: 1, borderRadius: 14, borderWidth: 1, borderColor: vc.line, backgroundColor: vc.surface },
  row: { paddingVertical: 12, paddingHorizontal: 12, borderRadius: 10 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 26, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1, borderColor: vc.line, marginRight: 4 },
})
