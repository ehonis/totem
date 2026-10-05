import React from 'react'
import { THREAD_ICONS } from './threadIcons.gen'
import type { Project } from './types'
import { TI } from './ui'
import { IconFolder } from './icons'

/** Icons a project can wear: a short list from the chat icon set, so the picker stays one glance wide. */
export const PROJECT_ICONS = [
  'folder', 'briefcase', 'building', 'code', 'chart-line', 'report-analytics', 'school', 'book', 'notebook', 'writing',
  'bulb', 'target', 'trophy', 'heartbeat', 'barbell', 'bike', 'run', 'home', 'plane', 'map', 'coin', 'wallet',
  'shopping-cart', 'gift', 'palette', 'camera', 'music', 'robot', 'flask', 'leaf', 'paw', 'chef-hat',
].filter((name) => THREAD_ICONS[name])

export default function ProjectIcon({ p, size = 16, className = '' }: { p?: Pick<Project, 'icon'> | null; size?: number; className?: string }) {
  const icon = (p?.icon && THREAD_ICONS[p.icon]) || IconFolder
  return <TI icon={icon} size={size} className={`vc-proj-icon ${className}`.trim()} />
}
