// dev/alerts.mjs — the record of alerts from outside (PostHog, other senders) and
// from the Dev tab's own GitHub watcher, in data/dev-alerts.json.
//
// Every alert is kept (the last MAX_ALERTS), but one is only pushed to the owner
// if the same source+key was not already pushed within DEDUPE_MS. The notify
// queue collapses only pending items, and these are delivered at once, so a
// webhook that fires every minute would otherwise buzz every minute.
//
// The file also holds the watcher's last-seen run ids and runner states, so a
// restart does not alert again about a failure it already reported.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const MAX_ALERTS = 200
export const DEDUPE_MS = 60 * 60_000

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const safeUrl = (value) => (/^https?:\/\//i.test(String(value || '')) ? String(value).slice(0, 2000) : null)

export function createAlertStore({ file, notify, now = () => Date.now(), log = () => {} }) {
  if (!file) throw new TypeError('createAlertStore requires file')
  let chain = Promise.resolve()
  // One writer at a time: an ingest and a watcher tick can land together.
  const locked = (fn) => {
    const result = chain.then(fn)
    chain = result.catch(() => {})
    return result
  }

  async function read() {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'))
      return { alerts: Array.isArray(raw.alerts) ? raw.alerts : [], seen: raw.seen && typeof raw.seen === 'object' ? raw.seen : {} }
    } catch {
      return { alerts: [], seen: {} }
    }
  }

  async function write(state) {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2))
    await rename(tmp, file)
  }

  async function list(limit = 50) {
    return (await read()).alerts.slice(0, limit)
  }

  /**
   * Record one alert and push it unless the same source+key went out within the
   * hour. `key` defaults to the title, so a sender that repeats itself without
   * one is still collapsed. Resolves to `{ alert, notified }`.
   */
  function record({ source, title, body = '', url = null, key = null }) {
    return locked(async () => {
      const state = await read()
      const at = now()
      const alert = {
        id: `a_${randomUUID().slice(0, 8)}`,
        source: clean(source, 32),
        title: clean(title, 160) || 'Alert',
        body: clean(body, 600),
        url: safeUrl(url),
        key: clean(key || title, 200),
        at: new Date(at).toISOString(),
        delivered: false,
      }
      const recent = state.alerts.some((a) => a.delivered && a.source === alert.source && a.key === alert.key
        && at - Date.parse(a.at) < DEDUPE_MS)
      if (!recent && notify) {
        try {
          // The push opens the Dev tab, not the sender's link: the notification
          // centre routes a url inside the dashboard. The link is on the alert there.
          const sent = await notify({ level: 'warn', title: alert.title, body: alert.body, category: 'alert.external', url: '/dev' })
          // Delivered means it reached a phone or the bell, as the notifier saw it.
          // A notify that reports nothing back (no notifier behind it) is taken at
          // its word, as before.
          const delivery = sent?.delivery
          alert.delivered = delivery
            ? Boolean(delivery.ok) || delivery.reason === 'not-configured' || delivery.reason === 'no-devices'
            : true
        } catch (e) {
          log('alert delivery failed', e?.message || e)
        }
      }
      state.alerts = [alert, ...state.alerts].slice(0, MAX_ALERTS)
      await write(state)
      return { alert, notified: alert.delivered }
    })
  }

  const getSeen = async (repo) => (await read()).seen[repo] || null

  function setSeen(repo, seen) {
    return locked(async () => {
      const state = await read()
      state.seen[repo] = seen
      await write(state)
    })
  }

  return { list, record, getSeen, setSeen }
}
