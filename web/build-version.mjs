// The version the dashboard shows in the rail, worked out when the bundle is built.
//
// Nobody bumps a number by hand: every merged PR is one more first-parent commit
// on main, so `<major>.<minor>.<commits on main>` goes up by one with each merge
// and the deploy's build stamps it. The date is the day that commit was made,
// so a glance says which merge is running. The major and minor come from the
// root package.json.
//
// A copy without git history (a Docker image, a tarball) still builds: it shows
// the package version and the build date, with no count.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

export function formatVersion({ pkgVersion, count, date }) {
  const [major = '1', minor = '0'] = String(pkgVersion || '').split('.')
  return {
    version: count > 0 ? `${major}.${minor}.${count}` : `${major}.${minor}`,
    date,
  }
}

export function buildVersion(repoRoot) {
  let pkgVersion = '1.0.0'
  try {
    pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || pkgVersion
  } catch {}
  // A shallow clone (CI's checkout) counts what it has, which is wrong, so it gets no count.
  const shallow = git(['rev-parse', '--is-shallow-repository'], repoRoot) === 'true'
  const count = shallow ? 0 : Number(git(['rev-list', '--count', '--first-parent', 'HEAD'], repoRoot)) || 0
  const date = git(['log', '-1', '--format=%cs'], repoRoot) || new Date().toISOString().slice(0, 10)
  return { ...formatVersion({ pkgVersion, count, date }), commit: git(['rev-parse', '--short', 'HEAD'], repoRoot) }
}
