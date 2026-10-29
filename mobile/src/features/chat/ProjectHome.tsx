// A project's page, shown in the chat when the drawer is scoped to a project
// and no chat is open (web chat/ProjectHome.tsx, the Chats tab). The name and
// icon, its folders, and its chats newest first; the composer below starts a
// new chat in it. Files, Instructions and Memory tabs are web-only for now.
import React, { useEffect, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import { useChat, loadProject, openProject, setActive, threadTitle, foldersOf } from '../../lib/chat/store'
import { shelfOf, ago } from '../../lib/chat/settle'
import type { ChatThread } from '../../lib/chat/types'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { colors } from '../../theme'
import { ProjectIcon, ThreadIcon } from './ThreadIcon'
import { TI, vc } from './ui'
import { IconArrowLeft } from './icons'

export default function ProjectHome({ projectId }: { projectId: string }) {
  const project = useChat((s) => s.projectDetail[projectId] || s.projects.find((p) => p.id === projectId))
  const projects = useChat((s) => s.projects)
  const all = useChat((s) => s.threads) as ChatThread[]
  const runs = useChat((s) => s.runs)
  const autoDays = useChat((s) => s.prefs.autoSettleDays ?? 3)
  useEffect(() => { loadProject(projectId) }, [projectId])
  const folders = useMemo(() => foldersOf(projects, projectId), [projects, projectId])
  const chats = useMemo(() => all.filter((t) => t.projectId === projectId && t.messages.length > 0), [all, projectId])
  if (!project) return null
  const now = Date.now()
  return (
    <View style={st.page}>
      {/* Back to Home, out of every project, without opening the drawer. */}
      <Press style={st.home} onPress={() => { tap(); openProject(null) }} hitSlop={8} accessibilityLabel="Back to all chats">
        <TI icon={IconArrowLeft} size={15} color={vc.soft} />
        <T size={13.5} color={vc.soft}>All chats</T>
      </Press>
      <View style={st.hero}>
        <ProjectIcon p={project} size={26} color={vc.soft} />
        <T size={26} weight={500} lineHeight={34} style={{ flexShrink: 1 }}>{project.name}</T>
      </View>
      {project.instructions ? <T size={14} lineHeight={21} color={vc.soft} numberOfLines={3} style={{ marginBottom: 14 }}>{project.instructions}</T> : null}
      {folders.length ? (
        <View style={{ marginBottom: 10 }}>
          <T size={12} color={vc.faint} style={st.group}>Folders</T>
          {folders.map((f) => (
            <Press key={f.id} style={st.row} onPress={() => { tap(); openProject(f.id) }}>
              <ProjectIcon p={f} size={17} />
              <T size={15} numberOfLines={1} style={{ flex: 1 }}>{f.name}</T>
              {f.chatCount ? <T size={12} color={vc.faint}>{f.chatCount}</T> : null}
            </Press>
          ))}
        </View>
      ) : null}
      <T size={12} color={vc.faint} style={st.group}>Chats</T>
      {!chats.length ? <T size={14} lineHeight={21} color={vc.soft} style={{ paddingVertical: 10 }}>Chats in this project will show up here. Start one below.</T> : null}
      {chats.map((t) => {
        const shelf = shelfOf(t, now, autoDays, !!runs[t.id])
        return (
          <Press key={t.id} style={[st.row, shelf === 'settled' && { opacity: 0.6 }]} onPress={() => { tap(); setActive(t.id) }}>
            <ThreadIcon t={t} size={17} />
            <T size={15} weight={t.needsReply ? 600 : 400} numberOfLines={1} style={{ flex: 1 }}>{threadTitle(t)}</T>
            {runs[t.id] || t.needsReply ? <View style={st.dot} /> : <T size={12} color={vc.faint}>{ago(t.updatedAt, now)}</T>}
          </Press>
        )
      })}
    </View>
  )
}

const st = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingBottom: 24 },
  home: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', height: 32, marginBottom: 6 },
  hero: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  group: { paddingTop: 12, paddingBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 46, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: vc.line },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
})
