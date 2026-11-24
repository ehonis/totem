import { authHeaders } from '../../lib/api'
import { bridgeUrl, getBaseUrl } from '../../lib/connection'
import { headersFor } from '../../lib/links'

/** An image the bridge serves: signed URLs open anywhere; the bearer covers the rest, on the bridge's own origin only. */
export const imageSource = (url?: string, uploadId?: string) => {
  const uri = bridgeUrl(url || `/api/chat/uploads/${uploadId}`)
  return { uri, headers: headersFor(uri, getBaseUrl(), authHeaders()) }
}
