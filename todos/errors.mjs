export class TodoDomainError extends Error {
  constructor(code, message, { status = 400, details = {} } = {}) {
    super(message);
    this.name = 'TodoDomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * GitHub sharing went with the GitHub task connector. A task can still carry a plain
 * issue link (PUT /api/todos/:id/issue-link); creating or syncing an issue is gone.
 */
export function githubSharingRemoved() {
  return new TodoDomainError(
    'GITHUB_SHARING_REMOVED',
    'Creating GitHub issues from tasks was removed. Create the issue on GitHub and set it as the task\'s issue link.',
    { details: { syncTarget: 'github' } },
  );
}

/** The shared task sheet is read-only now (todos/connectors/task-sheet-feed.mjs). */
export function sheetSharingRemoved() {
  return new TodoDomainError(
    'SHEET_SHARING_REMOVED',
    'Sharing tasks to the sheet was removed. The sheet is read-only in Totem: edit it in Google Sheets.',
    { details: { syncTarget: 'sheet' } },
  );
}

// Sync targets that existed once, each refused with its own reason. Matched without
// regard to case or surrounding space, so "GitHub" is named for what it was rather
// than as a typo.
const RETIRED_SYNC_TARGETS = Object.freeze({ github: githubSharingRemoved, sheet: sheetSharingRemoved });

/**
 * The one check every path that takes a `syncTarget` makes before it writes anything
 * (create, update, PATCH, share, the MCP tools, inbox proposals): absent or `local`
 * is local, a retired target is refused with its reason, anything else is unknown.
 * Tasks stay local; nothing syncs one out any more.
 */
export function assertSyncTarget(target) {
  if (target === undefined || target === null || target === '' || target === 'local') return 'local';
  const named = typeof target === 'string' ? target.trim().toLowerCase() : null;
  if (named && Object.hasOwn(RETIRED_SYNC_TARGETS, named)) throw RETIRED_SYNC_TARGETS[named]();
  throw new TodoDomainError('INVALID_SYNC_TARGET', 'syncTarget must be local: tasks are not shared out of Totem.', {
    details: { syncTarget: target },
  });
}

/** The issue link has its own validated route; the generic external-link route refuses it. */
export function issueLinkRouteRequired() {
  return new TodoDomainError(
    'USE_ISSUE_LINK_ROUTE',
    'Set a GitHub issue link with PUT /api/todos/:id/issue-link.',
    { details: { connector: 'github' } },
  );
}
