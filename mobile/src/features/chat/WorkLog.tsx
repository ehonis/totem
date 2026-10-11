// A run of consecutive tool calls inside a reply (web chat/WorkLog.tsx).
// Collapsed it is one line: what the agent is doing right now while it works, a
// summary once it has finished. Tap to open the steps; tap a step for what went
// in and what came back.
import React, { useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import Animated, { LinearTransition } from 'react-native-reanimated'
import type { ToolPart } from '../../lib/chat/types'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { fonts } from '../../theme'
import Spark, { Shimmer } from './Spark'
import { TI, toolApp, toolIcon, formatDuration, vc } from './ui'
import { IconChevronRight, IconX, IconCheck } from './icons'

function summarize(tools: ToolPart[], live: boolean) {
  const running = tools.find((t) => t.status === 'running')
  if (live && running) return { text: running.title + (running.detail ? ` · ${running.detail}` : ''), running: true }
  const apps = [...new Set(tools.map((t) => toolApp(t.server)?.label).filter(Boolean))] as string[]
  const failed = tools.filter((t) => t.status === 'error').length
  const steps = `${tools.length} step${tools.length === 1 ? '' : 's'}`
  let text: string
  if (tools.length === 1) text = tools[0].title + (tools[0].detail ? ` · ${tools[0].detail}` : '')
  else if (apps.length) text = `Used ${apps.slice(0, 3).join(', ')}${apps.length > 3 ? ` and ${apps.length - 3} more` : ''} · ${steps}`
  else text = `Worked through ${steps}`
  if (failed) text += ` · ${failed} failed`
  return { text, running: false }
}

function elapsed(tools: ToolPart[]) {
  const start = Math.min(...tools.map((t) => t.startedAt || Infinity))
  const end = Math.max(...tools.map((t) => t.endedAt || 0))
  return Number.isFinite(start) && end > start ? end - start : 0
}

function Chevron({ open }: { open: boolean }) {
  return <TI icon={IconChevronRight} size={14} color={vc.faint} style={open ? { transform: [{ rotate: '90deg' }] } : undefined} />
}

function ToolCard({ tool }: { tool: ToolPart }) {
  const [open, setOpen] = useState(false)
  const app = toolApp(tool.server)
  const hasBody = !!(tool.input || tool.output)
  const ms = tool.endedAt && tool.startedAt ? tool.endedAt - tool.startedAt : 0
  const err = tool.status === 'error'
  return (
    <View>
      <Press disabled={!hasBody} onPress={() => { tap(); setOpen((o) => !o) }} style={st.toolHead} accessibilityState={{ expanded: open }}>
        <TI icon={toolIcon(tool.kind, tool.server, tool.detail)} size={15} color={err ? '#ff7a8f' : vc.soft} />
        <T size={13.5} weight={500} numberOfLines={1} style={{ flexShrink: 0, maxWidth: '55%' }}>{tool.title}</T>
        {app ? <View style={st.app}><T size={11.5} color={vc.soft}>{app.label}</T></View> : null}
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

export default function WorkLog({ tools, live }: { tools: ToolPart[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  const { text, running } = summarize(tools, live)
  const ms = elapsed(tools)
  const last = tools[tools.length - 1]
  return (
    <Animated.View layout={LinearTransition.duration(160)}>
      <Press onPress={() => { tap(); setOpen((o) => !o) }} style={st.head} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        {running ? <Spark size={15} /> : <TI icon={toolIcon(last.kind, last.server, last.detail)} size={15} />}
        {running ? <Shimmer text={text} size={14} /> : <T size={14} color={vc.soft} numberOfLines={1} style={{ flexShrink: 1 }}>{text}</T>}
        {!running && ms > 1500 ? <T size={12.5} color={vc.faint}>{formatDuration(ms)}</T> : null}
        <Chevron open={open} />
      </Press>
      {open ? <View style={st.list}>{tools.map((t) => <ToolCard key={t.id} tool={t} />)}</View> : null}
    </Animated.View>
  )
}

const st = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', maxWidth: '100%', minHeight: 30, paddingRight: 8 },
  list: { gap: 4, marginTop: 6, marginBottom: 4, marginLeft: 7, paddingLeft: 14, borderLeftWidth: 1, borderLeftColor: vc.line },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 9 },
  app: { backgroundColor: vc.raise, paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999, flexShrink: 0 },
  toolBody: { marginTop: 2, marginBottom: 8, marginLeft: 31, gap: 8 },
  pre: { maxHeight: 280, borderRadius: 10, backgroundColor: vc.code, borderWidth: 1, borderColor: vc.line, paddingVertical: 10, paddingHorizontal: 12 },
  preText: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 18.6, color: '#cfd4de' },
})

