import { assertSyncTarget, issueLinkRouteRequired, TodoDomainError } from './errors.mjs';

export { assertSyncTarget };

function requireDependency(value, name) {
  if (!value) throw new TypeError(`createTodoCommands requires ${name}`);
  return value;
}

function cleanSyncTarget(input) {
  assertSyncTarget(input.syncTarget);
  const { syncTarget: _ignored, ...todo } = input;
  return todo;
}

export function createTodoCommands({ service, maintenance } = {}) {
  requireDependency(service, 'service');
  requireDependency(maintenance, 'maintenance');

  return {
    create: async (input = {}, context) => service.create(cleanSyncTarget(input), context),
    async update(id, patch = {}, context) {
      // A syncTarget is checked (and refused) before the patch is validated, so it is
      // named for what it is rather than as an unknown field, and nothing is written.
      if (patch && typeof patch === 'object' && Object.hasOwn(patch, 'syncTarget')) {
        return service.update(id, cleanSyncTarget(patch), context);
      }
      return service.update(id, patch, context);
    },
    move: (id, status, context, options) => service.move(id, status, context, options),
    close: (id, context) => service.complete(id, context),
    archive: (id, context) => service.archive(id, context),
    unarchive: (id, context) => service.unarchive(id, context),
    softDelete: (id, context) => service.softDelete(id, context),
    restore: (id, context) => service.restore(id, context),
    purge: input => maintenance.purgeDeleted(input),
    addNote: async (id, body, context) => service.addNote(id, body, context),
    linkRelated: (leftId, rightId, context) => service.linkRelated(leftId, rightId, context),
    unlinkRelated: (leftId, rightId, context) => service.unlinkRelated(leftId, rightId, context),
    reorder: input => service.reorder(input),
    bulk: async input => service.bulk(input),
    // GitHub links go through setIssueLink, which validates the URL and keeps one per task.
    attachExternalLink: (id, link, context) => {
      if (String(link?.connector ?? '').trim().toLowerCase() === 'github') throw issueLinkRouteRequired();
      return service.attachExternalLink(id, link, context);
    },
    // A link left by the retired connectors (or an issue link) is removed locally like any other.
    detachExternalLink: (id, connector, context) => service.detachExternalLink(id, connector, context),
    // Sharing is gone. A target that once existed is refused with its own reason
    // (assertSyncTarget); anything else, `local` included, is not a share target.
    async share(_id, target) {
      assertSyncTarget(target);
      throw new TodoDomainError('INVALID_SYNC_TARGET', 'There is nothing to share a task to: tasks stay in Totem.', {
        details: { target: target ?? null },
      });
    },
    // Nothing syncs a task any more, so a refresh is a re-read.
    refresh: async id => service.get(id),
    setIssueLink: (id, url, context) => service.setIssueLink(id, url, context),
    getPreferences: () => service.getPreferences(),
    listVentureTags: () => service.listVentureTags(),
    saveVentureTags: (tags, context) => service.saveVentureTags(tags, context),
    updatePreferences: (patch, context) => service.updatePreferences(patch, context),
  };
}
