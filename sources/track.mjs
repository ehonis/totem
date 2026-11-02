// sources/track.mjs — what a connector imports to write to the run log.
//
// No SQLite here, so a connector's CLI or test that never opens a run log does not
// load node:sqlite. A connector takes `runs` (the store from store.mjs) and calls
// `tracker(runs)(source, fn, opts)` around each logical operation on what it reads.
//
// A run is an operation, not a request. One Gmail search is a list call and up to
// fifty message reads, eight at a time; counted per request, a single search that
// hits a rate limit is eight failures in a row, which is a false outage. So a
// tracked call made inside another tracked call for the same source joins it
// (AsyncLocalStorage carries the operation through every await and through
// mapLimit's workers), and only the outermost one records a run.
import { AsyncLocalStorage } from 'node:async_hooks'

// A status that says the source answered and the request was wrong (a file that is
// not there, a bad query an agent wrote) is not the source failing. One that says
// it cannot be reached, refused us, or is not set up right is.
const FAULT_STATUSES = new Set([401, 403, 407, 408, 409, 429])

export function isSourceFault(error) {
  let status
  try { status = Number(error?.status ?? error?.statusCode) } catch { return true }
  if (!Number.isFinite(status) || status === 0) return true
  return status >= 500 || FAULT_STATUSES.has(status)
}

const operation = new AsyncLocalStorage()

/** `runs.track`, joined per operation; a pass-through when built without a run log. */
export function tracker(runs) {
  if (typeof runs?.track !== 'function') return (_source, fn) => fn()
  return (source, fn, opts) => {
    const open = operation.getStore()
    if (open?.has(source)) return fn()
    const inside = new Set(open || [])
    inside.add(source)
    return runs.track(source, () => operation.run(inside, fn), opts)
  }
}

/** `runs.record`, or nothing. For a result that arrives without a call to wrap. */
export function recorder(runs) {
  return typeof runs?.record === 'function' ? runs.record : () => null
}

/** `runs.markUnconfigured`, or nothing: the source answered that it is not set up. */
export function unconfiguredMarker(runs) {
  return typeof runs?.markUnconfigured === 'function' ? runs.markUnconfigured : () => null
}

// ---- connectors whose work is part local, part remote -------------------------
//
// The task syncs reconcile a pull from GitHub or the sheet with the local task
// database in one block. A local failure (a SQLite error, a domain rule) is the
// sync's problem, shown in its own health, not the source failing. `remoteClient`
// tags every error the remote client throws; `remoteFault` counts only those, by
// the usual rules, and skips the run for anything else (null: not recorded).

const REMOTE = Symbol('remote error')

export function remoteClient(client) {
  if (!client) return client
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      return function remoteCall(...args) {
        const tag = (error) => {
          if (error && typeof error === 'object') {
            try { Object.defineProperty(error, REMOTE, { value: true }) } catch {}
          }
          throw error
        }
        let out
        try { out = value.apply(target, args) } catch (error) { tag(error) }
        return out && typeof out.then === 'function' ? out.then((v) => v, tag) : out
      }
    },
  })
}

export const remoteFault = (error) => (error?.[REMOTE] ? isSourceFault(error) : null)

// ---- Google accounts (Gmail, Drive) -------------------------------------------

/** What a list call brought back, for the run log; null for anything that is not a list. */
export function listLength(result) {
  if (Array.isArray(result)) return result.length
  const list = ['messages', 'threads', 'labels', 'drafts', 'files', 'values', 'sheets'].map((k) => result?.[k]).find(Array.isArray)
  return list ? list.length : null
}

/**
 * Per-account operations for a Google connector: `op(account, fn)` is one run of
 * `<kind>:<account>`, the token refresh included, since a sign-in that stopped
 * working is the failure that matters most. Callers pass a resolved label
 * (requireAccount), so an unknown name never becomes a source.
 */
export function accountOperations(runs, kind) {
  const track = tracker(runs)
  return (account, fn) => track(`${kind}:${account}`, fn, { rows: listLength })
}

// ---- grants Bushido holds (Strava, WHOOP) -------------------------------------

const NOT_SET_UP = new Set(['disconnected', 'unconfigured'])

/**
 * What Bushido's `status` says about a grant, as health. `ready` records nothing:
 * only a call that reaches the provider proves the grant works, and a status poll
 * must not reset the streak of a sync that keeps failing. Disconnected means not
 * set up. Any other state (needs-reauth, an error) is the source failing, and so
 * is a Bushido that cannot be reached.
 */
export function noteGrantStatus(runs, source, { status = null, error = null } = {}) {
  if (error) return recorder(runs)({ source, ok: false, error })
  const state = status?.state
  if (state === 'ready') return null
  if (NOT_SET_UP.has(state)) return unconfiguredMarker(runs)(source, status?.detail || `not connected in Bushido (${state})`)
  return recorder(runs)({ source, ok: false, error: `Bushido reports the grant as ${state || 'unknown'}${status?.detail ? `: ${status.detail}` : ''}` })
}
