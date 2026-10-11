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
 * Secrets never go on the command line: a write feeds an `add-generic-password`
 * command to `security -i` on stdin, the way Claude Code does, so it never
 * shows in a process listing, and a failure is reported without the arguments
 * or output, which could contain it.
 *
 * Not `add-generic-password -w` with the value on its prompt: that prompt reads
 * at most 128 characters and silently stores the truncated value, which
 * destroyed a Claude login (a ~470-character JSON blob) on its first refresh.
 * `security -i` has a limit too: a command line over ~4 KB fails and can leave
 * a mangled item behind, so a write that long is refused before it starts.
 */
import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';

export const CLAUDE_SERVICE = 'Claude Code-credentials';
export const CURSOR_ACCESS_SERVICE = 'cursor-access-token';
export const CURSOR_ACCOUNT = 'cursor-user';

// `security -i` reads one command per line; measured on macOS 15, a line over
// ~4,090 bytes fails. Stay well under it.
const INTERACTIVE_LINE_MAX = 4000;

// `name` labels errors: under `-i` the real command is on stdin, not in args.
let runner = (args, input, name = args[0]) =>
  new Promise((resolve, reject) => {
    const child = execFile('security', args, { timeout: 10_000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (!err) return resolve(stdout);
      // Node's own message repeats the full argv; report only what failed.
      const why = err.killed ? 'timed out' : `exit ${err.code ?? 'unknown'}`;
      reject(Object.assign(new Error(`security ${name} failed (${why})`), { code: err.code }));
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

/** The `security -i` line that stores `value`, hex-encoded so no quoting can break it. */
function addCommand(service, value, account) {
  for (const name of [service, account]) {
    if (/["\\\n]/.test(name)) throw new Error('Keychain service and account names cannot contain quotes, backslashes or newlines');
  }
  const hex = Buffer.from(String(value), 'utf8').toString('hex');
  return `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"`;
}

/**
 * Whether `value` is small enough to save under `service`. Check this before
 * doing anything that cannot be undone, such as spending a refresh token.
 */
export function keychainCanStore(service, value, account = defaultAccount()) {
  return keychainSupported() && addCommand(service, value, account).length <= INTERACTIVE_LINE_MAX;
}

/**
 * Create or replace the secret under `service`, then read it back. Throws if
 * the Keychain refuses, the value is too long to write safely, or what was
 * stored is not what was sent.
 */
export async function writeKeychain(service, value, account = defaultAccount()) {
  if (!keychainSupported()) throw new Error('no Keychain on this platform');
  const command = addCommand(service, value, account);
  if (command.length > INTERACTIVE_LINE_MAX) throw new Error('Keychain value is too long to write safely');
  await runner(['-i'], `${command}\n`, 'add-generic-password');
  if ((await readKeychain(service, account)) !== String(value)) {
    throw new Error('Keychain write did not round-trip: the stored value differs from the one sent');
  }
}
