// The icon the title model picked for a chat (web chat/ThreadIcon.tsx and
// ProjectIcon.tsx). A temporary chat keeps its ghost; a chat with none yet
// shows a plain bubble; a project without one, a folder.
import React, { useEffect } from 'react'
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import { THREAD_ICONS } from '../../lib/chat/threadIcons.gen'
import type { ChatThread, Project } from '../../lib/chat/types'
import { TI } from './ui'
import { IconGhost2, IconMessage, IconFolder } from './icons'
import { textAlpha } from '../../theme'

export function ThreadIcon({ t, size = 16, busy = false, color }: { t: Pick<ChatThread, 'icon' | 'kind'>; size?: number; busy?: boolean; color?: string }) {
  const icon = t.kind === 'temporary' ? IconGhost2 : (t.icon && THREAD_ICONS[t.icon]) || IconMessage
  const pulse = useSharedValue(1)
  useEffect(() => {
    pulse.value = busy ? withRepeat(withTiming(0.35, { duration: 600 }), -1, true) : withTiming(1, { duration: 150 })
  }, [busy, pulse])
  const style = useAnimatedStyle(() => ({ opacity: pulse.value }))
  return (
    <Animated.View style={style}>
      <TI icon={icon} size={size} color={color || (t.icon ? textAlpha(78) : textAlpha(62))} />
    </Animated.View>
  )
}

export function ProjectIcon({ p, size = 16, color = textAlpha(70) }: { p?: Pick<Project, 'icon'> | null; size?: number; color?: string }) {
  const icon = (p?.icon && THREAD_ICONS[p.icon]) || IconFolder
  return <TI icon={icon} size={size} color={color} />
}
