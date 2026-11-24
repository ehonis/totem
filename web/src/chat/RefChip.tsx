// An attachment named inside a message (refs.ts): T3 Code's inline chip, coloured
// text rather than a pill. The composer's editor draws it as a node view and the
// transcript draws it from the message's own attachments; an id the message does
// not carry draws as unavailable.
import React from 'react'
import { TI } from './ui'
import { IconClipboardText, IconFileOff, IconFileText, IconFileTypePdf, IconPhoto } from './icons'
import { formatSize, middleTruncate, splitRefs } from './refs'
import { splitMentions } from './mentions'
import type { Attachment } from './types'

/** What a chip shows about its upload. `thumb` is the image's own URL (an object URL while drafting). */
export interface ChipInfo {
  kind: 'image' | 'file' | 'text'
  name: string
  size: number
  mime: string
  thumb?: string
  /** The composer's remove confirm is asking about this file. */
  asking?: boolean
}

// Why a name in the text has no file: the message was sent without it (or from elsewhere).
const GONE = 'This file was not sent with this message, so the agent did not get it.'

export const chipInfo = (a: Attachment): ChipInfo => ({ kind: a.kind, name: a.name, size: a.size, mime: a.mime, thumb: a.kind === 'image' ? a.url : undefined })

export function RefChip({ info, label, onOpen }: { info: ChipInfo | undefined; label: string; onOpen?: () => void }) {
  if (!info) {
    return (
      <span className="vc-ref gone" title={GONE} aria-label={`${label}, not attached. ${GONE}`}>
        <TI icon={IconFileOff} size={14} /><span className="vc-ref-name">{middleTruncate(label)}</span><span className="vc-ref-size">not attached</span>
      </span>
    )
  }
  const icon = info.kind === 'text' ? IconClipboardText : info.kind === 'image' ? IconPhoto : /pdf/.test(info.mime) ? IconFileTypePdf : IconFileText
  const size = formatSize(info.size)
  const body = (
    <>
      {info.kind === 'image' && info.thumb ? <img className="vc-ref-thumb" src={info.thumb} alt="" draggable={false} /> : <TI icon={icon} size={14} />}
      <span className="vc-ref-name">{middleTruncate(info.name)}</span>
      <span className="vc-ref-size">{size}</span>
    </>
  )
  const what = info.kind === 'image' ? 'Image' : info.kind === 'text' ? 'Pasted text' : 'File'
  const className = `vc-ref ${info.kind}${info.asking ? ' asking' : ''}`
  return onOpen
    ? <button type="button" className={className} onClick={onOpen} title={info.name} aria-label={`${what}, ${info.name}, ${size}`}>{body}</button>
    : <span className={className} title={info.name} aria-label={`${what}, ${info.name}, ${size}`}>{body}</span>
}

/**
 * A message's text as he wrote it: each reference a chip, resolved against the
 * message's `attachments`, and each skill he cited tinted.
 */
export function RefText({ text, attachments, known, describe, onOpen }: {
  text: string
  attachments?: Attachment[]
  known: Set<string>
  describe?: (cmd: string) => string | undefined
  onOpen?: (a: Attachment) => void
}) {
  return (
    <>
      {splitRefs(text).map((part, i) => {
        if (part.ref) {
          const a = attachments?.find((x) => x.id === part.ref.id)
          return <RefChip key={i} info={a && chipInfo(a)} label={part.ref.label} onOpen={a && onOpen ? () => onOpen(a) : undefined} />
        }
        return splitMentions(part.text, known).map((p, j) => (p.mention
          ? <span key={`${i}-${j}`} className="vc-mention" title={describe?.(p.mention)}>{p.text}</span>
          : <React.Fragment key={`${i}-${j}`}>{p.text}</React.Fragment>))
      })}
    </>
  )
}
