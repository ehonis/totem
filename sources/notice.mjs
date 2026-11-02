// sources/notice.mjs — telling the owner a source is failing.
//
// The notice goes through the notification queue (notifyStore.enqueue). Two
// things about it matter:
//
// - No error text. A push lands on a lock screen and in the bell, and an error is
//   the one part of a run that can carry something private even after scrubbing
//   (a file name, an address). The notice says which source and for how long, and
//   Settings → Connections shows the error.
// - It is still true when it is delivered. Quiet hours can hold a notice for the
//   night; a source that recovered by then should not wake anyone. The notice
//   carries a revalidation fact key, and the bridge adds one fact per source that
//   is still failing to what the revalidator reads at delivery (failingFacts). A
//   source that recovered has no fact, and the queued notice is dropped as stale.
import { describeSourceId, failingNoticeKey } from './health.mjs'

function duration(fromIso, toIso) {
  const ms = Date.parse(toIso) - Date.parse(fromIso)
  if (!Number.isFinite(ms) || ms < 0) return null
  const min = Math.round(ms / 60_000)
  if (min < 90) return `${Math.max(1, min)} min`
  const h = Math.round(min / 60)
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`
}

/** The enqueue input for a failing source. `feeds` are the titles of goals it feeds. */
export function failingNotice(health, { feeds = [] } = {}) {
  const { label } = describeSourceId(health.source)
  const key = failingNoticeKey(health)
  const span = duration(health.failingSince, health.lastRunAt)
  const reads = `${health.failures} failed ${health.failures === 1 ? 'read' : 'reads'} in a row${span ? ` over ${span}` : ''}.`
  const goals = feeds.length ? ` It feeds ${feeds.join(', ')}.` : ''
  return {
    category: 'job.failed',
    title: `${label} is failing`,
    body: `${reads}${goals} See Settings → Connections for the error.`,
    url: '/settings/connections',
    dedupeKey: key,
    revalidate: { factKey: key },
    source: { kind: 'source-health', id: health.source },
  }
}

/** One revalidation fact per source still failing: what keeps its notice deliverable. */
export function failingFacts(healthList = []) {
  return healthList
    .filter((h) => h?.state === 'failing' && h.failingSince)
    .map((h) => ({ kind: 'source-failing', revalidate: { factKey: failingNoticeKey(h) } }))
}
