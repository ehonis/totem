import React from 'react'
import { Hi, UserGroupIcon } from '../icons'
import { initials } from './format'

/** A conversation's mark: initials for a person, a group glyph for a group. */
export default function Avatar({ title, group, size = 40 }: { title: string; group: boolean; size?: number }) {
  return (
    <span className="msgs-avatar" style={{ width: size, height: size, fontSize: size * 0.36 }} aria-hidden>
      {group ? <Hi icon={UserGroupIcon} size={size * 0.48} /> : initials(title)}
    </span>
  )
}
