import { afterEach, describe, expect, it, vi } from 'vitest'
import { APPROVAL_CODE_HEADER, approvalBanner, approvalHeaders, getApprovalCode, setApprovalCode } from './approvalCode'

// The code rides only on the approval routes, and the banner says what this
// device is missing. A slip here either leaks the code into every request or
// leaves the owner unable to approve without knowing why.
describe('approval code on this device', () => {
  afterEach(() => { setApprovalCode(''); vi.unstubAllGlobals() })

  it('is sent on the approval routes only', () => {
    expect(approvalHeaders('/api/inbox/resolve')).toEqual({})
    setApprovalCode(' ABCDE-FGHJK-MNPQR-STVWX ')
    expect(getApprovalCode()).toBe('ABCDE-FGHJK-MNPQR-STVWX')
    for (const path of ['/api/inbox/resolve', '/api/approvals/approve', '/api/apple/send', '/api/totems/proposal', '/api/inbox/release', '/api/chat/approvals', '/api/recs/r1/decision', '/api/recs/r1/outcome', '/api/away', '/api/away/a1', '/api/inbox/resolve?x=1', '/api/cliproxy/accounts/delete', '/api/cliproxy/login', '/api/cliproxy/login/callback', '/api/cliproxy/grants/claim', '/api/cliproxy/credits/consume']) {
      expect(approvalHeaders(path)).toEqual({ [APPROVAL_CODE_HEADER]: 'ABCDE-FGHJK-MNPQR-STVWX' })
    }
    for (const path of ['/api/inbox', '/api/todos', '/api/approvals', '/api/approvals/deny', '/api/auth/approval-code', '/api/recs', '/api/recs/ledger', '/api/away/a1/x', '/api/cliproxy', '/api/cliproxy/status']) {
      expect(approvalHeaders(path)).toEqual({})
    }
    // A read never carries it, even on an approval route's path.
    expect(approvalHeaders('/api/away', 'GET')).toEqual({})
    expect(approvalHeaders('/api/away/a1', 'DELETE')).toEqual({ [APPROVAL_CODE_HEADER]: 'ABCDE-FGHJK-MNPQR-STVWX' })
  })

  it('goes out with resolveInboxItem, and not with getInbox', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: init.body as string | undefined })
      return new Response('{}', { status: 200 })
    })
    const { getInbox, resolveInboxItem } = await import('./api')
    setApprovalCode('ABCDE-FGHJK-MNPQR-STVWX')
    await getInbox()
    await resolveInboxItem('P1', 'accept', 'digest-shown')
    expect(calls[0].headers[APPROVAL_CODE_HEADER]).toBeUndefined()
    expect(calls[1].headers[APPROVAL_CODE_HEADER]).toBe('ABCDE-FGHJK-MNPQR-STVWX')
    // The digest of the proposal as it was shown, so a changed one is refused.
    expect(JSON.parse(calls[1].body!).digest).toBe('digest-shown')
  })

  it('banners: unset, missing and legacy installs, and an armed one this device cannot use yet', () => {
    const status = (state: any) => ({ state, setAt: null, header: APPROVAL_CODE_HEADER, mode: 'password' as const })
    expect(approvalBanner(null, false)).toBeNull()
    expect(approvalBanner(status('unset'), false)?.tone).toBe('warn')
    expect(approvalBanner(status('missing'), true)?.text).toMatch(/missing/)
    // Legacy is a warning: sign-in alone is forgeable by anything that reads the server's files.
    expect(approvalBanner(status('legacy'), false)?.tone).toBe('warn')
    expect(approvalBanner(status('tampered'), true)?.text).toMatch(/changed outside Totem/)
    expect(approvalBanner(status('armed'), false)?.text).toMatch(/no approval code/)
    expect(approvalBanner(status('armed'), true)).toBeNull()
  })
})
