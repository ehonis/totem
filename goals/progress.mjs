/**
 * How far through a goal is.
 *
 * Pure — no SQLite, no React, no network. The service shapes rows into the inputs below
 * (resolving any sourced metric first), the UI renders the output, and the tests assert
 * the arithmetic.
 *
 * ## The one rule that matters: a contribution is counted exactly once
 *
 * A metric's `currentValue` is its OWN contribution. What gets displayed for it is that
 * number plus the values of every metric naming it in `rollsUpToMetricId`. So a "miles
 * run" metric on a parent shows 30 when you logged 10 against the parent directly and 20
 * against a sub-goal that feeds it.
 *
 * Keeping the stored number own-only is what makes that work. The rejected design was
 * writing the total onto the parent whenever a child changed — the same value living in
 * two rows, and two rows holding one fact are two rows that can disagree, usually after
 * a partial failure nobody saw.
 *
 * ## What a goal's overall fraction is
 *
 * The unweighted mean of its components, where a component is either one of its own
 * metrics (as a fraction of target) or, if it has any sub-goals, the share of them
 * earned — see `stepShare`: a step with no numbers is worth its tick, a step with
 * numbers is worth how far through them it is. A goal with neither is 0 or 1 depending
 * on whether somebody marked it done.
 *
 * ## A step you decided against is out of scope, not a zero
 *
 * A sub-goal carrying `abandonedAt` was resolved by a decision rather than by doing it.
 * It leaves the steps fraction entirely — neither numerator nor denominator — so a goal
 * with three steps, two done and one he said out loud he is not getting to, reads 2 of 2
 * and can finish at 100%. Counting it as undone would make the goal permanently
 * unfinishable over a thing he decided not to do; counting it as done would claim work
 * that never happened. `subGoalsAbandoned` reports how many left, so the card can say so.
 *
 * ## An unreadable metric is not a zero
 *
 * A sourced metric whose connector cannot be read (Strava not connected, the cache
 * empty) arrives here with `available: false`. It is dropped from the mean rather than
 * counted as zero progress, because zero is a number that looks exactly like data and
 * isn't. If every component is unavailable the goal's fraction is null, and the UI says
 * so instead of drawing an empty bar.
 *
 * ## Completion is not computed
 *
 * Nothing in this file sets or infers completion. A goal reading 100% is still not
 * complete until a person marks it: the point of a goal is noticing that you finished it,
 * and a row that ticks itself is a row you never look at again.
 */

function clampFraction(value, target) {
  // A zero or negative target cannot express "how far through". The schema forbids one,
  // so this is a guard against a caller passing raw numbers, not a live case.
  if (!(target > 0)) return value > 0 ? 1 : 0;
  const raw = value / target;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(Math.max(raw, 0), 1);
}

/**
 * Resolve one goal's metrics against every metric in scope.
 *
 * `scope` is the goal's own metrics plus those of its sub-goals — the only rows that may
 * feed it, since rollup edges are constrained to parent/child in the service.
 */
function resolveMetrics(own, scope) {
  const feedersBySource = new Map();
  for (const metric of scope) {
    if (!metric.rollsUpToMetricId) continue;
    const bucket = feedersBySource.get(metric.rollsUpToMetricId);
    if (bucket) bucket.push(metric);
    else feedersBySource.set(metric.rollsUpToMetricId, [metric]);
  }

  return own.map((metric) => {
    const feeders = feedersBySource.get(metric.id) ?? [];
    // An unreadable feeder contributes nothing and says so, rather than dragging the
    // parent's total down to a number that looks deliberate.
    const readable = feeders.filter((feeder) => feeder.available !== false);
    const rolledUpValue = readable.reduce((sum, feeder) => sum + feeder.currentValue, 0);
    const available = metric.available !== false;
    const value = available ? metric.currentValue + rolledUpValue : null;
    return {
      id: metric.id,
      label: metric.label,
      unit: metric.unit ?? null,
      targetValue: metric.targetValue,
      sourceKind: metric.sourceKind ?? 'manual',
      available,
      unavailableReason: available ? null : (metric.unavailableReason ?? 'unavailable'),
      ownValue: available ? metric.currentValue : null,
      rolledUpValue: available ? rolledUpValue : null,
      value,
      fraction: available ? clampFraction(value, metric.targetValue) : null,
      feederCount: feeders.length,
      unreadableFeederCount: feeders.length - readable.length,
    };
  });
}

/**
 * How much of the steps component one step has earned.
 *
 * A step with no numbers is a tick: it counts when somebody ticks it, and nothing else
 * it could do would say otherwise. A step that *does* carry numbers counts how far
 * through those numbers it is — "2 bike rides" with one ride logged is half a step, and
 * reading it as zero until the tick is what made attaching a number to a step pointless.
 * Ticking it still wins outright: a step marked done is done at 1 whatever its numbers
 * say, because completion is a person's statement and a bar is not.
 *
 * Numbers that ROLL UP to one of the goal's own metrics are left out, and that is the
 * counted-exactly-once rule from the top of this file applied to the mean rather than to
 * a value: those miles are already inside the parent metric's bar, which is its own
 * component. Counting them here as well would move the goal twice for one ride. A step
 * whose numbers all feed the parent therefore contributes only its tick — unchanged from
 * before rollup metrics on steps could stand alone.
 *
 * An unreadable number is not evidence of anything, so it is dropped here too; a step
 * left with none falls back to its tick rather than to a zero that looks deliberate.
 */
function stepShare(sub) {
  if (sub.completedAt !== null && sub.completedAt !== undefined) return 1;
  const own = (sub.metrics ?? []).filter((m) => m.available !== false && !m.rollsUpToMetricId);
  if (own.length === 0) return 0;
  return own.reduce((sum, m) => sum + clampFraction(m.currentValue, m.targetValue), 0) / own.length;
}

/** The whole picture for one goal and its sub-goals. */
export function goalProgress(goal) {
  const subGoals = goal.subGoals ?? [];
  const scope = [...goal.metrics, ...subGoals.flatMap((sub) => sub.metrics ?? [])];
  const metrics = resolveMetrics(goal.metrics, scope);

  // `subGoalsTotal` counts the steps still in play. An abandoned step is reported on its
  // own rather than folded into the total, because "2 of 3, one of which I am not doing"
  // and "2 of 3" are different weeks.
  const abandoned = (sub) => sub.abandonedAt !== null && sub.abandonedAt !== undefined;
  const live = subGoals.filter((sub) => !abandoned(sub));
  const subGoalsTotal = live.length;
  const subGoalsAbandoned = subGoals.length - live.length;
  const subGoalsDone = live.filter((sub) => sub.completedAt !== null && sub.completedAt !== undefined).length;

  const components = metrics.filter((m) => m.available).map((m) => m.fraction);
  if (subGoalsTotal > 0) {
    components.push(live.reduce((sum, sub) => sum + stepShare(sub), 0) / subGoalsTotal);
  }

  const hasUnreadable = metrics.some((m) => !m.available);
  let fraction;
  if (components.length > 0) {
    fraction = components.reduce((sum, part) => sum + part, 0) / components.length;
  } else if (hasUnreadable) {
    // Every component is a metric nobody can read. Reporting 0 here would be a lie.
    fraction = null;
  } else {
    fraction = goal.completedAt ? 1 : 0;
  }

  return {
    metrics,
    subGoalsTotal,
    subGoalsDone,
    subGoalsAbandoned,
    fraction,
    complete: Boolean(goal.completedAt),
  };
}

/**
 * A sub-goal's own progress, in its own right.
 *
 * A sub-goal has no children — one level, enforced in the schema and the service — so its
 * scope is just its own metrics. A metric that rolls up to the parent still counts fully
 * here: it is this sub-goal's number, and feeding a total elsewhere doesn't make it less
 * so.
 */
export function subGoalProgress(subGoal) {
  return goalProgress({ ...subGoal, subGoals: [] });
}

/** Percent for display, or null when there is nothing honest to show. */
export function percent(fraction) {
  return fraction === null || fraction === undefined ? null : Math.round(fraction * 100);
}
