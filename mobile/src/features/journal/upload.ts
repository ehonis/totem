// Upload a take from expo-audio's file to the bridge. Same request as the web's
// uploadJournalAudio (lib/api.ts): the bytes as the body, Content-Type and the
// facts in the query string. On iOS the file goes up as an expo-file-system File
// through expo/fetch, so the recording is never read into JS memory.
import { Platform } from 'react-native'
import { fetch as expoFetch } from 'expo/fetch'
import { File } from 'expo-file-system'
import { ApiError, AuthError, authHeaders, uploadJournalAudio } from '../../lib/api'
import { bridgeUrl } from '../../lib/connection'
import type { JournalEntry } from '../../lib/journal/types'

/** expo-audio's HIGH_QUALITY preset writes AAC in an .m4a container. */
export const RECORDING_MIME = 'audio/mp4'

export async function uploadJournalRecording(
  uri: string,
  { recordedAt, durationSec, mime = RECORDING_MIME }: { recordedAt: string; durationSec: number; mime?: string },
): Promise<{ ok: true; entry: JournalEntry }> {
  // The web preview's recorder hands back a blob: URL; the web path takes a Blob.
  if (Platform.OS === 'web') {
    const blob = await (await fetch(uri)).blob()
    return uploadJournalAudio(blob, { recordedAt, durationSec })
  }
  const q = [
    `recordedAt=${encodeURIComponent(recordedAt)}`,
    `duration=${encodeURIComponent(String(durationSec))}`,
    `mime=${encodeURIComponent(mime)}`,
  ].join('&')
  const response = await expoFetch(bridgeUrl(`/api/journal/entries?${q}`), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': mime }),
    body: new File(uri) as any,
  })
  const body: any = await response.json().catch(() => ({}))
  if (response.status === 401) throw new AuthError()
  if (!response.ok) {
    const error = body?.error
    throw new ApiError(
      typeof error === 'object' ? error?.message ?? `HTTP ${response.status}` : error || `HTTP ${response.status}`,
      response.status,
      typeof error === 'object' ? error?.code ?? 'HTTP_ERROR' : 'HTTP_ERROR',
    )
  }
  return body
}

/** Remove a take's temporary file once it is saved or discarded. */
export function deleteLocalRecording(uri: string | null | undefined) {
  if (!uri || Platform.OS === 'web') return
  try {
    const f = new File(uri)
    if (f.exists) f.delete()
  } catch { /* the cache is cleared by the OS eventually */ }
}
