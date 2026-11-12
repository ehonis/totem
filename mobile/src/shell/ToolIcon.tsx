// Each Productivity tool's mark: the web's brand art (connection-icons, as on the
// old tab strip), and Tabler's bulb for Recs, which has none (ProductivityView.tsx).
// Drawn by the drawer and the hub, so a tool looks the same everywhere it is offered.
import React from 'react'
import { Image } from 'expo-image'
import IconBulb from '@tabler/icons-react-native/dist/esm/icons/IconBulb.mjs'
import { colors } from '../theme'
import type { ProductivityApp } from './routes'

const ART: Partial<Record<ProductivityApp, number>> = {
  todos: require('../../assets/images/connection-icons/totem-todos.png'),
  calendar: require('../../assets/images/connection-icons/google-calendar.png'),
  habits: require('../../assets/images/connection-icons/habits.png'),
  goals: require('../../assets/images/connection-icons/goals.png'),
  lists: require('../../assets/images/connection-icons/lists.png'),
  journal: require('../../assets/images/connection-icons/journal.png'),
}

export function ToolIcon({ app, size = 22 }: { app: ProductivityApp; size?: number }) {
  const art = ART[app]
  if (art) return <Image source={art} style={{ width: size, height: size, borderRadius: Math.round(size * 0.18) }} accessibilityIgnoresInvertColors />
  return <IconBulb size={size} strokeWidth={1.75} color={colors.amber} />
}
