// dev/watcher.mjs — tells the owner when CI on a repo's default branch newly
// fails, or a self-hosted runner goes offline, without the Dev tab being open.
//
// Compares each workflow's newest finished run id and each runner's status with
// what it saw last (kept in the alert store, so a restart does not re-alert).
// The first look at a repo only records: enabling the tab should not replay
// every failure already on the dashboard.
const MINUTE = 60_000

export function createDevWatcher({ config, github, alerts, log = () => {} }) {
  let timer = null

  async function checkRepo(repo) {
    const now = await github.watchStatus(repo)
    const seen = await alerts.getSeen(repo)
    const next = { runs: { ...(seen?.runs || {}) }, runners: {} }
    for (const run of now.ci) {
      // An unfinished run is left for a later tick, when it has a verdict.
      if (run.state === 'pending') continue
      if (seen && run.state === 'failure' && seen.runs?.[run.workflow] !== run.runId) {
        await alerts.record({
          source: 'github',
          title: `${repo}: ${run.workflow} failed on ${now.defaultBranch}`,
          body: `The newest ${run.workflow} run on ${now.defaultBranch} ended ${run.conclusion}.`,
          url: run.url,
          key: `run:${repo}:${run.runId}`,
        })
      }
      next.runs[run.workflow] = run.runId
    }
    for (const runner of now.runners) {
      if (seen && runner.status === 'offline' && seen.runners?.[runner.name] === 'online') {
        await alerts.record({
          source: 'github',
          title: `${repo}: runner ${runner.name} went offline`,
          body: `The self-hosted runner ${runner.name} stopped answering GitHub.`,
          url: `https://github.com/${repo}/settings/actions/runners`,
          key: `runner:${repo}:${runner.name}:offline`,
        })
      }
      next.runners[runner.name] = runner.status
    }
    await alerts.setSeen(repo, next)
  }

  /** One pass over every configured repo. A repo that fails is logged and skipped. */
  async function check() {
    const cfg = config()
    if (!cfg.enabled) return
    for (const repo of cfg.repos) {
      try { await checkRepo(repo) } catch (e) { log(`dev watcher: ${repo}: ${e?.message || e}`) }
    }
  }

  // The interval is re-read each pass, so a changed pollMinutes applies without a restart.
  function start() {
    if (timer) return
    const loop = async () => {
      await check().catch((e) => log(`dev watcher failed: ${e?.message || e}`))
      if (!timer) return
      timer = setTimeout(loop, config().pollMinutes * MINUTE)
      timer.unref?.()
    }
    timer = setTimeout(loop, 0)
    timer.unref?.()
  }

  function stop() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  return { check, start, stop }
}
