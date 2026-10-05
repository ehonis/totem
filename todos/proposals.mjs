import { TodoDomainError } from './errors.mjs';

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
  const value = String(item.meta?.sync || '').trim().toLowerCase();
  if (!value) return 'local';
  if (!['local', 'github', 'sheet'].includes(value)) {
    fail('INVALID_SYNC_TARGET', 'Proposal sync must be local, github, or sheet.', { sync: value });
  }
  return value;
}

function dueDate(when) {
  if (!when || /^none$/i.test(String(when).trim())) return {};
  const match = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(String(when).trim());
  if (!match) fail('INVALID_DATE', 'Inbox task proposals require an explicit YYYY-MM-DD date.');
  return { dueDate: match[1] };
}

export function todoCommandFromInboxProposal(item, { github } = {}) {
  if (!item || !['todo', 'sheet', 'github', 'agent'].includes(item.kind)) {
    fail('INVALID_PROPOSAL_KIND', 'Only todo, sheet, and github proposals create tasks.');
  }
  const githubKind = item.kind === 'github' || item.kind === 'agent';
  const sheetKind = item.kind === 'sheet';
  const requestedTarget = explicitSyncTarget(item);
  const impliedTarget = githubKind ? 'github' : sheetKind ? 'sheet' : 'local';
  if (requestedTarget !== 'local' && impliedTarget !== 'local' && requestedTarget !== impliedTarget) {
    fail('AMBIGUOUS_SYNC_TARGET', 'Proposal kind and sync marker disagree.');
  }
  const syncTarget = requestedTarget === 'local' ? impliedTarget : requestedTarget;
  const classified = classification(item.meta);
  const description = githubKind
    ? String(github?.body || '').trim()
    : item.src ? `From inbox ${item.id} (src: ${item.src})` : '';
  return {
    title: item.title,
    ...classified,
    ...dueDate(item.when),
    ...(description ? { description } : {}),
    syncTarget,
    ...(githubKind ? { github: { ...github } } : {}),
  };
}
