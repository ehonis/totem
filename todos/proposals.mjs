import { assertSyncTarget, sheetSharingRemoved, TodoDomainError } from './errors.mjs';

function fail(code, message, details = {}) {
  throw new TodoDomainError(code, message, { details });
}

// `project:` is Personal, Ventures (with `venture:`), or a venture tag name on its
// own. Tags are configured per install; the service checks the name and fixes its
// case when the proposal is accepted.
function classification(meta = {}) {
  const project = String(meta.project ?? meta.area ?? 'Personal').trim();
  if (/^work$/i.test(project)) {
    fail('FUTURE_WORK_TASK_UNSUPPORTED', 'New Work tasks are not tracked in Totem. Use Personal if this is the owner\'s own follow-up.');
  }
  if (/^personal$/i.test(project)) {
    if (meta.venture || meta.venturetag) {
      fail('VENTURE_TAG_NOT_ALLOWED', 'Personal proposals cannot carry a venture classification.');
    }
    return { area: 'Personal', ventureTag: null };
  }
  const namedVenture = /^ventures$/i.test(project) ? '' : project;
  const ventureTag = String(namedVenture || meta.venture || meta.venturetag || '').trim();
  if (!ventureTag) {
    fail('VENTURE_TAG_REQUIRED', 'Ventures proposals require a venture tag (venture: <tag>).');
  }
  return { area: 'Ventures', ventureTag };
}

function explicitSyncTarget(item) {
  const raw = String(item.raw || '');
  const markers = raw.match(/(?:^|\|)\s*sync\s*:/gi) || [];
  if (markers.length > 1) {
    fail('AMBIGUOUS_SYNC_TARGET', 'A proposal may contain exactly one sync marker.', { count: markers.length });
  }
  // Refused like any other syncTarget: a retired one (github, sheet) with its reason.
  return assertSyncTarget(String(item.meta?.sync || '').trim().toLowerCase());
}

function dueDate(when) {
  if (!when || /^none$/i.test(String(when).trim())) return {};
  const match = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(String(when).trim());
  if (!match) fail('INVALID_DATE', 'Inbox task proposals require an explicit YYYY-MM-DD date.');
  return { dueDate: match[1] };
}

/**
 * The task command an accepted `todo` proposal runs: always a local task. A `sheet`
 * proposal (which shared to the sheet) is refused, as a `sync:` marker naming a retired
 * target is. A `github` proposal files an issue and makes no task (bridge.mjs), so it
 * is not one of these.
 */
export function todoCommandFromInboxProposal(item) {
  if (!item || !['todo', 'sheet'].includes(item.kind)) {
    fail('INVALID_PROPOSAL_KIND', 'Only todo proposals create tasks.');
  }
  explicitSyncTarget(item);
  if (item.kind === 'sheet') throw sheetSharingRemoved();
  const classified = classification(item.meta);
  const description = item.src ? `From inbox ${item.id} (src: ${item.src})` : '';
  return {
    title: item.title,
    ...classified,
    ...dueDate(item.when),
    ...(description ? { description } : {}),
  };
}
