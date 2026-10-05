// notify/updates.mjs — "2.1.275 is out" → something you can actually tap.
//
// A release notification tells you a version number and leaves you to go and do
// something about it, which usually means doing nothing. So for the two tools
// the owner actually runs, a release that this box is behind stages a confirm-only
// inbox proposal — the update command, screened and explained — and the push
// deep-links straight to it. Reading it and running it are one gesture.
//
// Two things keep that from being a bad idea:
//
//   1. THE BOX IS ASKED WHAT IT IS RUNNING. npm's `latest` tag is not what is
//      installed. Claude Code here is the native installer under
//      ~/.local/share/claude, not a global npm package, and the old feed line
//      ("you were on 2.1.273") actually meant "the previous version npm
//      published" — which is a different fact that happens to look the same.
//   2. THE CHANNEL IS RESPECTED. `t3 service update` writes the same
//      t3code.service unit whichever channel it is run from, so pointing the
//      stable tag at a nightly install is a silent downgrade off the channel he
//      chose. A build that is not on the source's channel raises no proposal.
//
// The decision is pure and the two version readers are injected, so all of this
// is testable without a box that has Claude Code on it.

/** Numeric-then-prerelease compare. Returns <0, 0, >0 like every other comparator. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre = ''] = String(v || '').trim().replace(/^v/, '').split('-')
    return { nums: core.split('.').map((n) => Number(n) || 0), pre }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const diff = (x.nums[i] || 0) - (y.nums[i] || 0)
    if (diff) return diff
  }
  // 1.0.0-nightly sorts *before* 1.0.0, as in semver: a prerelease is on the way
  // to the release, not past it.
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

/** The first version-shaped thing in a command's output. */
export function parseVersion(text) {
  const m = String(text || '').match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)
  return m ? m[0] : null
}

const isPrerelease = (version) => String(version || '').includes('-')

/**
 * What to do about one source, given what is published, what is installed, and
 * the update proposal (if any) already sitting open in the inbox.
 *
 * Actions:
 *   stage   — no open proposal and this box is behind. Make one.
 *   restage — an open proposal targets an older version than the one just out.
 *   reuse   — an open proposal already targets this version; link the push to it.
 *   resolve — an open proposal is pointless now, because the box is already there.
 *   none    — nothing to do, with a reason that is worth logging.
 */
export function decideUpdate({ source, released, installed, open = null } = {}) {
  if (!source?.update?.command) return { action: 'none', reason: 'source declares no update command' }
  if (!released) return { action: 'none', reason: 'no published version' }

  if (!installed) {
    return open
      ? { action: 'none', reason: 'installed version unknown; leaving the open proposal alone' }
      : { action: 'none', reason: 'installed version unknown' }
  }
  if (source.update.channel === 'stable' && isPrerelease(installed)) {
    // See the header: updating would swap the channel out from under him.
    const reason = `installed build ${installed} is off the ${source.update.channel} channel`
    // An open proposal from before he switched channels would swap him back.
    return open ? { action: 'resolve', reason, id: open.id } : { action: 'none', reason }
  }
  // An open proposal for a version this box has reached is worse than noise: it
  // is a button that re-runs an update that already happened.
  if (compareVersions(installed, released) >= 0) {
    return open
      ? { action: 'resolve', reason: `already on ${installed}`, id: open.id, installed }
      : { action: 'none', reason: `already on ${installed}`, installed }
  }
  if (open && compareVersions(open.target, released) >= 0) {
    return { action: 'reuse', reason: `proposal ${open.id} already targets ${open.target}`, id: open.id, installed }
  }
  if (open) {
    return { action: 'restage', reason: `proposal ${open.id} targets ${open.target}, superseded by ${released}`, id: open.id, installed }
  }
  return { action: 'stage', reason: `behind: ${installed} → ${released}`, installed }
}

/**
 * Read what this box is running. Two shapes, because the two tools answer
 * differently: one has a CLI, the other writes its state to a file.
 *
 * Never throws — an unreadable version means "no proposal", which is the safe
 * outcome, not a failed feed scan.
 */
export async function readInstalledVersion(spec, { exec, readFile, log = () => {} } = {}) {
  try {
    if (spec?.kind === 'command') return parseVersion(await exec(spec.command, spec))
    if (spec?.kind === 'json') {
      const parsed = JSON.parse(await readFile(spec.file))
      const raw = spec.key.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), parsed)
      return raw ? String(raw) : null
    }
  } catch (e) {
    log(`installed version unreadable (${spec?.kind}): ${e?.message || e}`)
  }
  return null
}

/** The proposal's title and the explanation the owner reads before saying yes. */
export function proposalFor(source, { released, installed }) {
  return {
    title: `Update ${source.label} to ${released}`,
    command: source.update.command,
    explanation: source.update.what
      || `Runs \`${source.update.command}\` to move ${source.label} from ${installed} to ${released}.`,
    why: `${source.label} ${released} is out and this box is on ${installed}.`,
    timeout: source.update.timeout || null,
    meta: { update: source.id, target: released, from: installed },
  }
}
