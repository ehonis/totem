// The web preview's uploads: a picked file's URI is a blob: URL there, so it
// goes through the web's own XHR upload. iOS never loads this file.
import { transcribe, uploadFile } from '../../lib/chat/api'
import type { Attachment } from '../../lib/chat/types'

export interface LocalFile { uri: string; name: string; mime: string; size?: number }

export async function uploadLocalFile(f: LocalFile, opts: { kind?: 'text'; onProgress?: (p: number) => void } = {}): Promise<Attachment> {
  const blob = await (await fetch(f.uri)).blob()
  const typed = blob.type ? blob : new Blob([blob], { type: f.mime })
  return uploadFile(typed, f.name, opts)
}

export async function transcribeFile(uri: string): Promise<string> {
  return transcribe(await (await fetch(uri)).blob())
}
