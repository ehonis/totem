// Uploads and dictation on a phone. The web posts a Blob through XHR; here the
// file is already on disk (the photo picker, the document picker, the recorder
// all hand back a file:// URI), so the OS uploads it straight from there with
// progress, as raw bytes. The bridge's contract is unchanged: the body is
// application/octet-stream (one of the few non-JSON types its cross-site guard
// accepts) and the real type travels in `mime`.
import { File, UploadType } from 'expo-file-system'
import { authHeaders, AuthError } from '../../lib/api'
import { bridgeUrl } from '../../lib/connection'
import type { Attachment } from '../../lib/chat/types'

export interface LocalFile { uri: string; name: string; mime: string; size?: number }

export async function uploadLocalFile(f: LocalFile, { kind, onProgress }: { kind?: 'text'; onProgress?: (p: number) => void } = {}): Promise<Attachment> {
  const q = new URLSearchParams({ name: f.name, mime: f.mime || 'application/octet-stream' })
  if (kind) q.set('kind', kind)
  const task = new File(f.uri).createUploadTask(bridgeUrl(`/api/chat/uploads?${q}`), {
    httpMethod: 'POST',
    uploadType: UploadType.BINARY_CONTENT,
    mimeType: 'application/octet-stream',
    headers: authHeaders({ 'content-type': 'application/octet-stream' }),
    sessionType: 'foreground',
    onProgress: ({ bytesSent, totalBytes }) => { if (totalBytes > 0) onProgress?.(bytesSent / totalBytes) },
  })
  let r
  try { r = await task.uploadAsync() } catch { throw new Error('Upload failed — check the connection') }
  let body: any = {}
  try { body = JSON.parse(r.body || '{}') } catch {}
  if (r.status === 401) throw new AuthError()
  if (r.status < 200 || r.status >= 300) throw new Error(body?.error || `Upload failed (${r.status})`)
  return body as Attachment
}

/** A recorded clip to text, on the box's whisper.cpp (the same endpoint the web's dictation uses). */
export async function transcribeFile(uri: string, mime = 'audio/mp4'): Promise<string> {
  const task = new File(uri).createUploadTask(bridgeUrl('/api/chat/transcribe'), {
    httpMethod: 'POST',
    uploadType: UploadType.BINARY_CONTENT,
    mimeType: mime,
    headers: authHeaders({ 'content-type': mime }),
    sessionType: 'foreground',
  })
  let r
  try { r = await task.uploadAsync() } catch { throw new Error('Transcription failed — check the connection') }
  let body: any = {}
  try { body = JSON.parse(r.body || '{}') } catch {}
  if (r.status === 401) throw new AuthError()
  if (r.status < 200 || r.status >= 300) throw new Error(body?.error || `Transcription failed (${r.status})`)
  return String(body.text || '').trim()
}

