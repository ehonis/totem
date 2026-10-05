/**
 * Where a metric's number comes from.
 *
 * A metric is `manual` by default — you type the number in, or ask an agent to. Any other
 * source means the number is read from a connector at display time and the stored column
 * stays at zero, which the schema enforces (`sourced_metric_stores_no_value`). One number,
 * one owner: the same rule that stops a GitHub-owned task being completed locally.
 *
 * This is the split habits already run — `HABIT_METRIC_SOURCES` in bridge.mjs, where a
 * habit's metric is `manual` or filled by the WHOOP sleep job. Goals differ in one way
 * that matters: a habit's sourced value is *written* into the file by a job, while a
 * goal's is *resolved on read*. That is deliberate. A written value is a second copy that
 * can go stale without saying so; resolving means the number is either current or
 * explicitly unavailable, and there is no third state where it is quietly wrong.
 *
 * "Current" means current with the local cache, which lags Strava by however long it has
 * been since `strava-sync` last ran — so every resolved value carries the cache's own
 * `updatedAt` as its `readAt`, and the UI prints it. An activity finished this morning is
 * not missing from a goal; it is not synced yet, and those are different problems.
 *
 * ## Reads never touch the network
 *
 * `strava_distance` resolves out of the local activity cache that the seeded `strava-sync`
 * job already keeps current, so listing your goals is a disk read however many metrics are
 * on them. Nothing here calls `sync()`: a dashboard poll must not be able to spend an API
 * quota. The one exception is the gear odometer, which Strava only exposes live — that
 * gets a short TTL memo so a page of goals costs at most one call per bike.
 *
 * ## Unavailable is a real answer, and it is not zero
 *
 * Strava may not be connected at all. When a source cannot be read, the metric comes back
 * `available: false` with a reason, and `goals/progress.mjs` drops it from the mean rather
 * than scoring it zero. Zero is a number that looks exactly like data and isn't — a
 * disconnected connector would otherwise render as a week where you did nothing.
 */

import { cachedActivities } from '../strava/cache.mjs';
import { SPORT_FAMILIES, mileage, summarizeActivity } from '../strava/shape.mjs';

export const GOAL_METRIC_SOURCES = ['manual', 'strava_distance', 'strava_gear_odometer'];

/**
 * What a `strava_distance` metric may filter its sport by.
 *
 * Derived from the connector's own families rather than restated, so a sport type added
 * to `SPORT_FAMILIES` is offered here without a second edit. `matchesSport` accepts an
 * exact `sport_type` too — this is the shortlist a picker shows, not a validation set.
 */
export const GOAL_SPORT_FILTERS = Object.keys(SPORT_FAMILIES);

/**
 * Which `sport_type` values each family covers, handed to clients as-is.
 *
 * A filter of "run" already counts the trail run and the treadmill run — `matchesSport`
 * resolves the family — but nothing said so where a person could read it, and a metric
 * an agent stored against the exact type "Run" then rendered in the picker as "Any
 * sport". Publishing the map is what lets a UI show that metric under Running, and what
 * lets it tell you a running goal counts more than one kind of workout.
 */
export const GOAL_SPORT_FAMILIES = SPORT_FAMILIES;

/**
 * How a sport family reads inside "Strava, ___ in this period".
 *
 * Pluralising by appending an "s" works for the four families that are really verbs and
 * produces "mobilitys" for the rest, which is the sort of thing that makes a considered
 * feature look unfinished.
 */
const SPORT_PHRASES = {
  ride: 'rides', run: 'runs', walk: 'walks', hike: 'hikes', swim: 'swims',
  lift: 'lifting sessions', climbing: 'climbs', mobility: 'mobility sessions',
  ski: 'snow days', water: 'paddles', sport: 'games', other: 'workouts',
};

export function isGoalMetricSource(value) {
  return typeof value === 'string' && GOAL_METRIC_SOURCES.includes(value);
}

/**
 * Which number off a Strava rollup a metric is counting.
 *
 * These are the field names `mileage()` already produces, not a translation layer — so a
 * goal counting hours and a goal counting miles differ by one string, and neither needs
 * arithmetic here that the connector has already done.
 */
export const STRAVA_MEASURES = ['distanceMi', 'distanceKm', 'movingMin', 'movingHours', 'elevationFt', 'count'];

const DEFAULT_MEASURE = 'distanceMi';
const GEAR_TTL_MS = 10 * 60 * 1000;

const str = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * Validate and shape what gets stored in `goal_metrics.source_config`.
 *
 * Throws a plain Error; the service turns it into a domain error. A manual metric stores
 * `{}` rather than null so the column is never a second way of saying "manual".
 */
export function normalizeSourceConfig(kind, raw = {}) {
  if (!isGoalMetricSource(kind)) throw new Error(`unknown metric source: ${kind}`);
  if (kind === 'manual') return {};

  const config = raw && typeof raw === 'object' ? raw : {};
  const measure = str(config.measure) ?? DEFAULT_MEASURE;
  if (!STRAVA_MEASURES.includes(measure)) {
    throw new Error(`unknown measure "${measure}" — use one of ${STRAVA_MEASURES.join(', ')}`);
  }

  if (kind === 'strava_gear_odometer') {
    const gearId = str(config.gearId);
    // Without a bike there is no odometer to read, and the metric would sit unavailable
    // forever with nothing saying why. Refuse it at write time instead.
    if (!gearId) throw new Error('a gear odometer metric needs a gearId');
    if (measure !== 'distanceMi' && measure !== 'distanceKm') {
      throw new Error('a gear odometer only measures distance');
    }
    return { gearId, measure };
  }

  return { sport: str(config.sport), gearId: str(config.gearId), measure };
}

const unavailable = (reason) => ({ available: false, value: null, reason, readAt: null });
const available = (value, readAt) => ({ available: true, value, reason: null, readAt });

/**
 * Build the resolver the service uses.
 *
 * `strava` is the client the bridge already constructs (`createStravaClient`), or null
 * when the connector was never wired up — in which case every sourced metric reports
 * unavailable, which is the correct degraded state rather than an error that breaks the
 * whole list.
 */
export function createGoalMetricSources({ strava = null, gearTtlMs = GEAR_TTL_MS, now = () => Date.now() } = {}) {
  const gearMemo = new Map();

  async function readGear(gearId) {
    const hit = gearMemo.get(gearId);
    if (hit && now() - hit.at < gearTtlMs) return hit;
    const entry = { at: now(), gear: null, error: null };
    try {
      entry.gear = await strava.gear(gearId);
    } catch (error) {
      entry.error = error?.message || 'could not read the odometer';
    }
    gearMemo.set(gearId, entry);
    return entry;
  }

  /**
   * Resolve a batch of sourced metrics.
   *
   * `requests` are `{ id, sourceKind, sourceConfig, period }`, where `period` is the
   * window the metric's goal belongs to — a sub-goal's metric is handed its parent's,
   * since a sub-goal has no window of its own. Returns a Map keyed by metric id.
   */
  async function resolve(requests) {
    const out = new Map();
    const sourced = requests.filter((r) => r.sourceKind && r.sourceKind !== 'manual');
    if (sourced.length === 0) return out;

    if (!strava || !strava.configured?.()) {
      for (const r of sourced) out.set(r.id, unavailable('Strava is not connected'));
      return out;
    }

    const distance = sourced.filter((r) => r.sourceKind === 'strava_distance');
    if (distance.length > 0) {
      let activities = null;
      let cacheError = null;
      // When the CACHE was last filled, which is what the number is actually as of.
      // Reporting the moment of the read instead would claim a run finished ten minutes
      // ago is already counted, when `strava-sync` runs every three hours — exactly the
      // confusion that reads as "my trail run didn't count".
      let syncedAt = null;
      try {
        // One cache read for the whole batch. Every metric below is then in-memory
        // arithmetic over the same array, however many goals are on the page.
        const cache = await strava.readCache();
        syncedAt = typeof cache?.updatedAt === 'string' ? cache.updatedAt : null;
        activities = cachedActivities(cache).map(summarizeActivity).filter(Boolean);
      } catch (error) {
        cacheError = error?.message || 'could not read the Strava cache';
      }

      for (const r of distance) {
        if (cacheError) { out.set(r.id, unavailable(cacheError)); continue; }
        if (activities.length === 0) { out.set(r.id, unavailable('no Strava activities cached yet')); continue; }
        const { sport = null, gearId = null, measure = DEFAULT_MEASURE } = r.sourceConfig ?? {};
        // The period is a pair of local day keys and Strava's shaped `date` is a local
        // day key too, so this comparison needs no conversion in either direction.
        const report = mileage(activities, {
          group: 'all', sport, gearId, from: r.period?.start ?? null, to: r.period?.end ?? null,
        });
        const value = Number(report.total?.[measure]);
        out.set(r.id, Number.isFinite(value)
          ? available(value, syncedAt ?? new Date(now()).toISOString())
          : unavailable(`Strava reports no ${measure}`));
      }
    }

    for (const r of sourced.filter((x) => x.sourceKind === 'strava_gear_odometer')) {
      const { gearId, measure = DEFAULT_MEASURE } = r.sourceConfig ?? {};
      if (!gearId) { out.set(r.id, unavailable('no gear selected')); continue; }
      const entry = await readGear(gearId);
      if (entry.error) { out.set(r.id, unavailable(entry.error)); continue; }
      const value = Number(entry.gear?.[measure]);
      out.set(r.id, Number.isFinite(value)
        ? available(value, new Date(entry.at).toISOString())
        : unavailable('that gear has no odometer reading'));
    }

    return out;
  }

  return { resolve };
}

/** Human wording for a source, used by the UI chip and the MCP descriptions. */
export function describeSource(kind, config = {}) {
  if (kind === 'strava_distance') {
    const parts = [config.sport ? SPORT_PHRASES[config.sport] ?? `${config.sport}s` : 'activities'];
    if (config.gearId) parts.push('on one bike');
    return `Strava, ${parts.join(' ')} in this period`;
  }
  if (kind === 'strava_gear_odometer') return "Strava's odometer for this gear (lifetime, not this period)";
  return 'logged by hand';
}
