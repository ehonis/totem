// The approval code on this phone (web/src/approvalCode.ts, ported). The code
// itself lives in the keychain (connection.ts); the bridge keeps only a hash. It
// is sent as a header on the approval routes only, where the bearer secret the
// app signs in with is not enough on its own.

import { getStoredApprovalCode, saveApprovalCode, useConnection } from './connection'

export const APPROVAL_CODE_HEADER = 'x-totem-approval-code'

// The routes in auth/approval-routes.mjs. Only these carry the code.
const APPROVAL_PATHS = new Set(['/api/inbox/resolve', '/api/approvals/approve', '/api/apple/send', '/api/totems/proposal', '/api/inbox/release', '/api/chat/approvals'])
const APPROVAL_PATTERN = /^\/api\/(recs\/[^/]+\/(decision|outcome)|away(\/[^/]+)?)$/

export type ApprovalState = 'armed' | 'missing' | 'tampered' | 'legacy' | 'unset'

export interface ApprovalCodeStatus {
  state: ApprovalState
  setAt: string | null
  header: string
  mode: 'password' | 'proxy'
  /** Why it reads as tampered, when it does. */
  reason?: string
}

export const getApprovalCode = () => getStoredApprovalCode()
export const setApprovalCode = (code: string) => saveApprovalCode(code)

/** The header for one request, when it goes to an approval route and this phone holds a code. */
export function approvalHeaders(path: string, method = 'POST'): Record<string, string> {
  const code = getApprovalCode()
  // Every approval route is a write: a read never carries the code.
  if (!code || /^(GET|HEAD)$/i.test(method)) return {}
  const bare = path.split('?')[0]
  return APPROVAL_PATHS.has(bare) || APPROVAL_PATTERN.test(bare) ? { [APPROVAL_CODE_HEADER]: code } : {}
}

export function useHasApprovalCode(): boolean {
  return Boolean(useConnection().approvalCode)
}

export const APPROVAL_REFUSALS = new Set([
  'APPROVAL_CODE_REQUIRED', 'APPROVAL_CODE_WRONG', 'APPROVAL_CODE_MISSING', 'APPROVAL_CODE_TAMPERED',
  'APPROVAL_CODE_NOT_SET', 'APPROVAL_NEEDS_OWNER', 'APPROVAL_RATE_LIMITED',
])

/**
 * The banner for this phone, or null. The app signs in with the bridge secret,
 * which approves nothing alone, so on a legacy install it needs the code too.
 */
export function approvalBanner(status: ApprovalCodeStatus | null, hasCode: boolean): { tone: 'warn' | 'info'; text: string } | null {
  if (!status) return null
  if (status.state === 'unset') {
    return { tone: 'warn', text: 'Set an approval code to send emails and messages, run commands and open prompts from here. Until then, those wait.' }
  }
  if (status.state === 'missing') {
    return { tone: 'warn', text: 'This Totem’s approval code file is missing, so sends, commands and prompts are refused. Set a new code.' }
  }
  if (status.state === 'tampered') {
    return { tone: 'warn', text: 'This Totem’s approval code changed outside Totem, so sends, commands and prompts are refused. Set a new code.' }
  }
  if (status.state === 'legacy') {
    return { tone: 'warn', text: 'Approving from the phone needs an approval code. Set one in Settings, and an agent can never approve its own proposal.' }
  }
  if (!hasCode) {
    return { tone: 'warn', text: 'This device has no approval code. Enter it to send, run or open proposals from here.' }
  }
  return null
}
