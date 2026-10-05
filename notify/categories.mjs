// notify/categories.mjs — the routing table.
//
// One row per kind of thing Totem interrupts for. This file is the product: it
// decides what is allowed to wake a phone at 11pm, what collapses into a digest,
// and what can never be learned into silence.
//
// `pinned` is the important column. A pinned category ignores learned weights
// entirely — no amount of feedback stops a birthday or an approval code, because
// a system that quietly learns to stop telling you things is indistinguishable
// from one that is broken.

const HOUR = 60

export const CATEGORIES = {
  'reminder.adhoc': {
    label: 'Reminders you set',
    quietHours: 'override',
    defaultEnabled: true,
    pinned: true,
    dedupeWindowMinutes: 0,
    slot: null, // has its own time
  },
  'reminder.task': {
    label: 'Task reminders',
    quietHours: 'defer',
    defaultEnabled: true,
    pinned: true,
    dedupeWindowMinutes: 0,
    slot: null,
    // Deferred until the local task core lands; declared here so the queue, the
    // settings UI and the feedback log already know the shape.
    deferred: true,
  },
  'task.due': {
    label: 'Tasks due today',
    quietHours: 'defer',
    defaultEnabled: true,
    dedupeWindowMinutes: 12 * HOUR,
    slot: 'morning',
    deferred: true,
  },
  'task.overdue': {
    label: 'Overdue tasks',
    quietHours: 'defer',
    defaultEnabled: true,
    dedupeWindowMinutes: 24 * HOUR,
    slot: 'morning',
    deferred: true,
  },
  // The phone's two halves of a Shortcut request. Both override quiet hours and
  // are pinned, because he is standing there holding the phone: a receipt that
  // waits until 07:00 is not a receipt, and a learned weight that quietly stops
  // answering him is the exact failure this column exists to prevent.
  'shortcut.received': {
    label: 'Request received',
    quietHours: 'override',
    defaultEnabled: true,
    pinned: true,
    dedupeWindowMinutes: 0,
    slot: null,
  },
  'shortcut.answered': {
    label: 'Answers to your requests',
    quietHours: 'override',
    defaultEnabled: true,
    pinned: true,
    dedupeWindowMinutes: 0,
    slot: null,
  },
  'calendar.event': {
    label: 'Before an event',
    quietHours: 'override',
    defaultEnabled: true,
    leadMinutes: 10,
    dedupeWindowMinutes: 0,
    slot: null,
  },
  'digest.morning': {
    label: 'Morning digest',
    quietHours: 'defer',
    defaultEnabled: true,
    dedupeWindowMinutes: 12 * HOUR,
    slot: 'morning',
  },
  'digest.evening': {
    label: 'Evening digest',
    quietHours: 'defer',
    defaultEnabled: true,
    dedupeWindowMinutes: 12 * HOUR,
    slot: 'night',
  },
  'person.birthday': {
    label: 'Birthdays',
    quietHours: 'defer',
    defaultEnabled: true,
    pinned: true,
    dedupeWindowMinutes: 24 * HOUR,
    slot: 'morning',
  },
  'habit.slipping': {
    label: 'Habits slipping',
    quietHours: 'defer',
    defaultEnabled: true,
    dedupeWindowMinutes: 24 * HOUR,
    slot: 'evening',
  },
  'goal.nearcomplete': {
    label: 'Nearly there',
    quietHours: 'defer',
    defaultEnabled: true,
    dedupeWindowMinutes: 24 * HOUR,
    slot: 'evening',
  },
  'goal.slipping': {
    label: 'Goals slipping',
    quietHours: 'defer',
    defaultEnabled: true,
    dedupeWindowMinutes: 7 * 24 * HOUR,
    slot: 'night',
  },
  // ---- the outside world (notify/feed.mjs) --------------------------------
  // Time-sensitive and not about him: a model release at 2pm is stale by the
  // evening digest, so these go out on the scan that finds them rather than
  // waiting for a plan.
  'news.release': {
    label: 'New releases',
    quietHours: 'defer',
    defaultEnabled: true,
    dedupeWindowMinutes: 0,
    slot: null,
  },
  'news.model': {
    label: 'AI models',
    quietHours: 'defer',
    defaultEnabled: true,
    dedupeWindowMinutes: 0,
    slot: null,
  },
  'news.creator': {
    label: 'People you follow',
    quietHours: 'defer',
    defaultEnabled: true,
    dedupeWindowMinutes: 0,
    slot: null,
  },
  'news.big': {
    label: 'Big news',
    quietHours: 'defer',
    defaultEnabled: true,
    dedupeWindowMinutes: 0,
    slot: null,
  },
  // The two bundled ones, which behave nothing like the four above. They are not
  // "something happened, here it is" — they are a fixed appointment with the
  // world, three headlines at 07:15 and 18:00 and two good stories at 12:30. The
  // whole point is that they are bounded and predictable, so they are the easiest
  // thing here to leave on.
  'news.world': {
    label: 'World news',
    quietHours: 'defer',
    defaultEnabled: true,
    // Bundles carry an explicit dedupe key (one per delivery hour), which always
    // replaces. A time window on top of that would collapse the morning bundle
    // into the evening one.
    dedupeWindowMinutes: 0,
    slot: 'morning',
  },
  // Deliberately unpinned and deliberately separate from the hard news: good news
  // that cannot be turned off is advertising, and good news stapled to the bottom
  // of a world bundle is a story nobody reads.
  'news.good': {
    label: 'Good news',
    quietHours: 'defer',
    defaultEnabled: true,
    dedupeWindowMinutes: 0,
    slot: 'midday',
  },
  // ---- what the subscriptions are doing (notify/usage.mjs) ----------------
  // A quota is a number he can act on — stop, switch provider, or spend the rest
  // of it — but only while the window is still open, so none of these override
  // quiet hours: at 3am there is nothing to do about it.
  'usage.limit': {
    label: 'AI quota running low',
    quietHours: 'defer',
    defaultEnabled: true,
    dedupeWindowMinutes: 12 * HOUR,
    slot: 'afternoon',
  },
  'usage.blocked': {
    label: 'AI quota spent',
    quietHours: 'defer',
    defaultEnabled: true,
    dedupeWindowMinutes: 6 * HOUR,
    slot: 'midday',
  },
  // Deliberately not pinned and deliberately quiet: "you are not using what you
  // pay for" is the most reasonable thing here to get tired of hearing.
  'usage.idle': {
    label: 'AI quota going unused',
    quietHours: 'suppress',
    defaultEnabled: true,
    dedupeWindowMinutes: 24 * HOUR,
    slot: 'evening',
  },
  'job.failed': {
    label: 'Something broke',
    quietHours: 'defer',
    defaultEnabled: true,
    dedupeWindowMinutes: 60,
    slot: null,
  },
  'approval.pending': {
    label: 'Approval codes',
    quietHours: 'override',
    defaultEnabled: true,
    pinned: true,
    dedupeWindowMinutes: 0,
    slot: null,
  },
  'inbox.proposal': {
    label: 'Queued proposals',
    quietHours: 'suppress',
    defaultEnabled: true,
    dedupeWindowMinutes: 2 * HOUR,
    slot: null,
  },
  // The voice journal, a few minutes after he saved an entry: what the digest
  // filed and where. He is usually still holding the phone, so it is not deferred;
  // not pinned either, because a morning ritual he already knows happened is the
  // one thing here he might reasonably learn to silence.
  'journal.ingested': {
    label: 'Journal digested',
    quietHours: 'defer',
    defaultEnabled: true,
    dedupeWindowMinutes: 0,
    slot: null,
  },
  'journal.failed': {
    label: 'Journal problems',
    quietHours: 'defer',
    defaultEnabled: true,
    pinned: true,
    dedupeWindowMinutes: 0,
    slot: null,
  },
}

export const CATEGORY_NAMES = Object.keys(CATEGORIES)

// Unknown categories resolve to the most conservative row rather than throwing.
// A notification raised by code this table has not caught up with should still be
// delivered, quietly and deferrably, not lost.
//
// `table` is a parameter because this module is shared with Bushido, which has its
// own categories (a logged workout, a morning readiness score) and none of
// Totem's. The default keeps every existing caller unchanged.
export function categoryDef(name, table = CATEGORIES) {
  return table[name] || {
    label: name,
    quietHours: 'defer',
    defaultEnabled: true,
    dedupeWindowMinutes: 60,
    slot: null,
  }
}

export const isPinned = (name, table = CATEGORIES) => Boolean(categoryDef(name, table).pinned)

export function defaultCategorySettings(table = CATEGORIES) {
  const out = {}
  for (const [name, def] of Object.entries(table)) {
    out[name] = { enabled: def.defaultEnabled, ...(def.leadMinutes ? { leadMinutes: def.leadMinutes } : {}) }
  }
  return out
}
