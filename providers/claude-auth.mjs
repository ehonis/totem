// Reads `claude auth status --json`, the CLI's own answer to "is this account
// signed in". It knows where the login really lives (the macOS Keychain, a
// CLAUDE_CONFIG_DIR, a credentials file) and when it still works, which a copy of
// `.credentials.json` does not: on macOS that file can be hours stale while the
// Keychain login runs every chat, and its `refreshTokenExpiresAt` passes while
// the CLI still reports `loggedIn: true` and answers.
//
// Returns { state, detail } or null when the output isn't that JSON (an older
// CLI without `auth status`), so the caller can fall back to the file.
export function parseClaudeAuthStatus(stdout) {
  let status
  try {
    status = JSON.parse(String(stdout || '').trim())
  } catch {
    return null
  }
  if (!status || typeof status !== 'object' || typeof status.loggedIn !== 'boolean') return null
  if (!status.loggedIn) return { state: 'logged-out', detail: 'Claude Code reports no signed-in account' }
  const method = status.authMethod === 'claude.ai' ? 'claude.ai login' : status.authMethod || 'signed in'
  const plan = status.subscriptionType ? `${status.subscriptionType} plan` : null
  return { state: 'ready', detail: [plan, method].filter(Boolean).join(', ') }
}
