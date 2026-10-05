/**
 * macOS Keychain access for the usage readers.
 *
 * On Linux, Claude Code and cursor-agent keep their logins in files
 * (`~/.claude/.credentials.json`, `~/.config/cursor/auth.json`). On macOS both
 * keep them in the login Keychain instead, so without this the poller finds no
 * accounts at all on a Mac. Items are read and written with the `security` CLI,
 * which is also what Claude Code itself uses, so its items allow it without a
 * prompt.
 *
 * The login Keychain is only unlocked inside the user's desktop session. A
 * plain SSH shell sees it as locked (exit 36); the bridge's launchd job runs in
 * the desktop session and does not.
 *
 * Secrets never go on the command line: a write pipes the value to `security`'s
 * own prompt on stdin, so it never shows in a process listing, and a failure
 * is reported without the arguments or output, which could contain it.
 */
import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';

export const CLAUDE_SERVICE = 'Claude Code-credentials';
export const CURSOR_ACCESS_SERVICE = 'cursor-access-token';
export const CURSOR_ACCOUNT = 'cursor-user';

let runner = (args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile('security', args, { timeout: 10_000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (!err) return resolve(stdout);
      // Node's own message repeats the full argv; report only what failed.
      const why = err.killed ? 'timed out' : `exit ${err.code ?? 'unknown'}`;
      reject(Object.assign(new Error(`security ${args[0]} failed (${why})`), { code: err.code }));
    });
    child.stdin.end(input ?? '');
  });

/** Tests swap the `security` call for a fake; returns the previous runner. */
export function setKeychainRunner(fn) {
  const prev = runner;
  runner = fn;
  return prev;
}

export const keychainSupported = () => process.platform === 'darwin';

export function defaultAccount() {
  return process.env.USER || userInfo().username;
}

/** The secret stored under `service`, or null when there is none (or no Keychain). */
export async function readKeychain(service, account = defaultAccount()) {
  if (!keychainSupported()) return null;
  try {
    const out = await runner(['find-generic-password', '-s', service, '-a', account, '-w']);
    return String(out).replace(/\n$/, '') || null;
  } catch {
    return null;
  }
}

/** Create or replace the secret under `service`. Throws if the Keychain refuses. */
export async function writeKeychain(service, value, account = defaultAccount()) {
  if (!keychainSupported()) throw new Error('no Keychain on this platform');
  // A trailing -w with no value makes `security` prompt for it, twice, on stdin.
  if (String(value).includes('\n')) throw new Error('Keychain value cannot contain a newline');
  await runner(['add-generic-password', '-U', '-s', service, '-a', account, '-w'], `${value}\n${value}\n`);
}
