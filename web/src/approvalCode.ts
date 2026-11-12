// The approval code on this device (auth/approval-code.mjs on the bridge).
//
// The bridge stores only a hash; this browser keeps the code itself in
// localStorage and sends it as a header on the routes that confer approval, so an
// agent holding BRIDGE_SECRET cannot approve its own proposals. Each device holds
// its own copy: entering it here does nothing for the phone.

import { useEffect, useState } from 'react'

const KEY = 'totem_approval_code'
export const APPROVAL_CODE_HEADER = 'x-totem-approval-code'

// The routes in auth/approval-routes.mjs. Only these carry the code.
const APPROVAL_PATHS = new Set(['/api/inbox/resolve', '/api/approvals/approve', '/api/apple/send', '/api/totems/proposal', '/api/inbox/release', '/api/chat/approvals', '/api/chat/browser/input'])
const APPROVAL_PATTERN = /^\/api\/(recs\/[^/]+\/(decision|outcome)|away(\/[^/]+)?|cliproxy\/(accounts\/[a-z]+|login(\/[a-z]+)?|grants\/claim|credits\/consume))$/

export type ApprovalState = 'armed' | 'missing' | 'tampered' | 'legacy' | 'unset'

export interface ApprovalCodeStatus {
  state: ApprovalState
  setAt: string | null
  header: string
  mode: 'password' | 'proxy'
  /** Why it reads as tampered, when it does. */
  reason?: string
}

const listeners = new Set<() => void>()

export const getApprovalCode = () => localStorage.getItem(KEY) || ''

export function setApprovalCode(code: string) {
  const value = code.trim()
  if (value) localStorage.setItem(KEY, value)
  else localStorage.removeItem(KEY)
  listeners.forEach((fn) => fn())
}

/** The header for one request, when it goes to an approval route and this device holds a code. */
export function approvalHeaders(path: string, method = 'POST'): Record<string, string> {
  const code = getApprovalCode()
  // Every approval route is a write: a read never carries the code.
  if (!code || /^(GET|HEAD)$/i.test(method)) return {}
  const bare = path.split('?')[0]
  return APPROVAL_PATHS.has(bare) || APPROVAL_PATTERN.test(bare) ? { [APPROVAL_CODE_HEADER]: code } : {}
}

/** Whether this device holds a code, kept in step across components. */
export function useHasApprovalCode(): boolean {
  const [has, setHas] = useState(() => Boolean(getApprovalCode()))
  useEffect(() => {
    const update = () => setHas(Boolean(getApprovalCode()))
    listeners.add(update)
    window.addEventListener('storage', update)
    return () => { listeners.delete(update); window.removeEventListener('storage', update) }
  }, [])
  return has
}

// Refusal codes the gate answers with; the inbox uses them to point at the fix.
export const APPROVAL_REFUSALS = new Set([
  'APPROVAL_CODE_REQUIRED', 'APPROVAL_CODE_WRONG', 'APPROVAL_CODE_MISSING', 'APPROVAL_CODE_TAMPERED',
  'APPROVAL_CODE_NOT_SET', 'APPROVAL_NEEDS_OWNER', 'APPROVAL_RATE_LIMITED',
])

/**
 * The banner for this device, or null when nothing needs doing. Shared with the
 * iPhone app's copy (mobile/src/lib/approvalCode.ts), which says the same.
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
    return { tone: 'warn', text: 'Approvals here rely on your sign-in alone, which an agent reading the server’s files could forge. Set an approval code.' }
  }
  if (!hasCode) {
    return { tone: 'warn', text: 'This device has no approval code. Enter it to send, run or open proposals from here.' }
  }
  return null
}
