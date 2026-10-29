// The working steps of a reply (web chat/WorkLog.tsx, workFold.ts). Collapsed it
// is one line: what the agent is doing right now while it works, a summary once
// it has finished, led by the logos of the connectors it used. Tap to open the
// steps, in order with what the agent said between them; tap a step for what
// went in and what came back.
import React, { useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import Animated, { LinearTransition } from 'react-native-reanimated'
import { Image } from 'expo-image'
import type { ToolPart } from '../../lib/chat/types'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { fonts } from '../../theme'
import Spark, { Shimmer } from './Spark'
import { TI, toolApp, toolIcon, formatDuration, vc } from './ui'
import { IconChevronRight, IconX, IconCheck } from './icons'
import Markdown from '../../ui/Markdown'
import { summarizeWork, workElapsed, workSources, type WorkItem, type WorkSource } from './workFold'

/** A connector's own logo, or its glyph when it has none or the image fails. */
function Logo({ logo, server, kind = 'mcp', detail, size, color = vc.soft }: { logo?: string; server?: string; kind?: string; detail?: string; size: number; color?: string }) {
  const [broken, setBroken] = useState(false)
  if (logo && !broken) return <Image source={{ uri: logo }} style={{ width: size, height: size, borderRadius: 3 }} contentFit="contain" onError={() => setBroken(true)} />
  return <TI icon={toolIcon(kind, server, detail)} size={size} color={color} />
}

const STACK = 3

/** The sources' marks overlapped, like T3 Code's, with a count past three. */
function SourceStack({ sources }: { sources: WorkSource[] }) {
  return (
    <View style={st.stack}>
      {sources.slice(0, STACK).map((s, i) => <View key={s.key} style={[st.mark, i > 0 && st.overlap]}><Logo logo={s.logo} server={s.server} size={12} /></View>)}
      {sources.length > STACK ? <View style={[st.mark, st.overlap]}><T size={10} color={vc.soft}>+{sources.length - STACK}</T></View> : null}
    </View>
  )
}

function Chevron({ open }: { open: boolean }) {
  return <TI icon={IconChevronRight} size={14} color={vc.faint} style={open ? { transform: [{ rotate: '90deg' }] } : undefined} />
}

function ToolCard({ tool }: { tool: ToolPart }) {
  const [open, setOpen] = useState(false)
  const app = tool.app || toolApp(tool.server)?.label
  const hasBody = !!(tool.input || tool.output)
  const ms = tool.endedAt && tool.startedAt ? tool.endedAt - tool.startedAt : 0
  const err = tool.status === 'error'
  return (
    <View>
      <Press disabled={!hasBody} onPress={() => { tap(); setOpen((o) => !o) }} style={st.toolHead} accessibilityState={{ expanded: open }}>
        <Logo logo={tool.logo} server={tool.server} kind={tool.kind} detail={tool.detail} size={15} color={err ? '#ff7a8f' : vc.soft} />
        <T size={13.5} weight={500} numberOfLines={1} style={{ flexShrink: 0, maxWidth: '55%' }}>{tool.title}</T>
        {app ? <View style={st.app}><T size={11.5} color={vc.soft}>{app}</T></View> : null}
        {tool.detail ? <T size={12.5} mono color={vc.faint} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>{tool.detail}</T> : <View style={{ flex: 1 }} />}
        <View style={{ flexShrink: 0 }}>
          {tool.status === 'running' ? <Spark size={13} />
            : err ? <TI icon={IconX} size={14} color="#ff7a8f" />
              : ms >= 1500 ? <T size={12} color={vc.faint}>{formatDuration(ms)}</T> : <TI icon={IconCheck} size={14} color={vc.faint} />}
        </View>
        {hasBody ? <Chevron open={open} /> : null}
      </Press>
      {open ? (
        <View style={st.toolBody}>
          {tool.input ? (
            <View>
              <T size={12} color={vc.faint} style={{ marginBottom: 4 }}>{tool.kind === 'command' ? 'Command' : 'Input'}</T>
              <ScrollView style={st.pre} nestedScrollEnabled><T style={st.preText} selectable>{tool.input}</T></ScrollView>
            </View>
          ) : null}
          {tool.output ? (
            <View>
              <T size={12} color={vc.faint} style={{ marginBottom: 4 }}>{err ? 'Error' : 'Result'}</T>
              <ScrollView style={st.pre} nestedScrollEnabled><T style={st.preText} selectable>{tool.output}</T></ScrollView>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

export default function WorkLog({ items, live }: { items: WorkItem[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  const tools = items.flatMap((i) => (i.kind === 'tools' ? i.tools : []))
  const { text, running } = summarizeWork(tools, live)
  const sources = workSources(tools)
  const ms = workElapsed(tools)
  const last = tools[tools.length - 1]
  return (
    <Animated.View layout={LinearTransition.duration(160)}>
      <Press onPress={() => { tap(); setOpen((o) => !o) }} style={st.head} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        {sources.length ? <SourceStack sources={sources} />
          : running ? <Spark size={15} />
            : <Logo logo={last.logo} server={last.server} kind={last.kind} detail={last.detail} size={15} />}
        {running ? <Shimmer text={text} size={14} /> : <T size={14} color={vc.soft} numberOfLines={1} style={{ flexShrink: 1 }}>{text}</T>}
        {running && sources.length ? <Spark size={13} /> : null}
        {!running && ms > 1500 ? <T size={12.5} color={vc.faint}>{formatDuration(ms)}</T> : null}
        <Chevron open={open} />
      </Press>
      {open ? (
        <View style={st.list}>
          {items.map((i) => i.kind === 'text'
            ? <View key={i.key} style={st.note}><Markdown text={i.text} size={13.5} muted /></View>
            : i.tools.map((t) => <ToolCard key={t.id} tool={t} />))}
        </View>
      ) : null}
    </Animated.View>
  )
}

const st = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', maxWidth: '100%', minHeight: 30, paddingRight: 8 },
  stack: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
  mark: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: vc.raise, borderWidth: 2, borderColor: vc.surface },
  overlap: { marginLeft: -6 },
  note: { paddingHorizontal: 8, paddingVertical: 2 },
  list: { gap: 4, marginTop: 6, marginBottom: 4, marginLeft: 7, paddingLeft: 14, borderLeftWidth: 1, borderLeftColor: vc.line },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 9 },
  app: { backgroundColor: vc.raise, paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999, flexShrink: 0 },
  toolBody: { marginTop: 2, marginBottom: 8, marginLeft: 31, gap: 8 },
  pre: { maxHeight: 280, borderRadius: 10, backgroundColor: vc.code, borderWidth: 1, borderColor: vc.line, paddingVertical: 10, paddingHorizontal: 12 },
  preText: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 18.6, color: '#cfd4de' },
})

