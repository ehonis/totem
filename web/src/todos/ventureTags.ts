// The install's venture tags (Settings -> Tasks). One shared store so the board,
// composer, detail sheet and settings page all see an edit at once.
import { useEffect, useState } from 'react'
import { getVentureTags, saveVentureTagList } from '../api'
import type { VentureTagConfig } from './types'

let tags: VentureTagConfig[] | null = null
let inflight: Promise<VentureTagConfig[]> | null = null
const listeners = new Set<(next: VentureTagConfig[]) => void>()

function publish(next: VentureTagConfig[]) {
  tags = next
  for (const listener of listeners) listener(next)
}

export function loadVentureTags(force = false): Promise<VentureTagConfig[]> {
  if (tags && !force) return Promise.resolve(tags)
  inflight ??= getVentureTags()
    .then((r) => { publish(r.ventureTags); return r.ventureTags })
    .finally(() => { inflight = null })
  return inflight
}

export async function saveVentureTags(next: (VentureTagConfig & { previousName?: string })[]) {
  const r = await saveVentureTagList(next)
  publish(r.ventureTags)
  return r.ventureTags
}

export function useVentureTags(): VentureTagConfig[] {
  const [value, setValue] = useState<VentureTagConfig[]>(tags ?? [])
  useEffect(() => {
    listeners.add(setValue)
    loadVentureTags().catch(() => {})
    return () => { listeners.delete(setValue) }
  }, [])
  return value
}

/** Inline style for a tag chip, from its colour; none for an uncoloured tag. */
export function ventureTagStyle(name: string | null | undefined, list: VentureTagConfig[]): React.CSSProperties | undefined {
  const color = list.find((t) => t.name === name)?.color
  if (!color) return undefined
  return { color, borderColor: `${color}45`, background: `${color}12` }
}
