import { TodoDomainError } from './errors.mjs';

const SHEET_SHARED_PATCH_FIELDS = new Set(['title', 'priority', 'dueDate', 'ventureTag', 'tags']);
const SHEET_SHARED_BULK = new Set(['priority', 'addTag', 'removeTag']);

function requireDependency(value, name) {
  if (!value) throw new TypeError(`createTodoCommands requires ${name}`);
  return value;
}

function cleanSyncTarget(input) {
  const target = input.syncTarget ?? 'local';
  if (!['local', 'github', 'sheet'].includes(target)) {
    throw new TodoDomainError('INVALID_SYNC_TARGET', 'syncTarget must be local, github, or sheet.', {
      details: { syncTarget: target },
    });
  }
  const { syncTarget: _ignored, ...todo } = input;
  return { target, todo };
}

function sourceLink(todo, connector) {
  return todo.externalLinks.find(link => link.connector === connector) ?? null;
}

export function createTodoCommands({ service, github, sheet, maintenance } = {}) {
  requireDependency(service, 'service');
  requireDependency(github, 'github');
  requireDependency(sheet, 'sheet');
  requireDependency(maintenance, 'maintenance');

  async function create(input = {}, context) {
    const { target, todo } = cleanSyncTarget(input);
    if (target === 'github') return github.create(todo, context);
    if (target === 'sheet') return sheet.create(todo, context);
    return service.create(todo, context);
  }

  async function update(id, patch = {}, context) {
    service.validateUpdate(id, patch);
    const todo = service.get(id);
    if (sourceLink(todo, 'sheet') && Object.keys(patch).some(field => SHEET_SHARED_PATCH_FIELDS.has(field))) {
      return sheet.updateLinked(id, patch, context);
    }
    if (sourceLink(todo, 'github') && Object.hasOwn(patch, 'title')) {
      const { title, ...localPatch } = patch;
      let result = await github.rename(id, title, context);
      if (Object.keys(localPatch).length) result = service.update(id, localPatch, context);
      return result;
    }
    return service.update(id, patch, context);
  }

  async function addNote(id, body, context) {
    const todo = service.get(id);
    if (!todo) return service.addNote(id, body, context);
    if (sourceLink(todo, 'sheet')) return sheet.appendNote(id, body, context);
    return service.addNote(id, body, context);
  }

  async function bulk(input = {}) {
    const todos = Array.isArray(input.ids) ? input.ids.map(id => service.get(id)).filter(Boolean) : [];
    if (SHEET_SHARED_BULK.has(input.operation) && todos.some(todo => sourceLink(todo, 'sheet'))) {
      return sheet.bulk(input);
    }
    return service.bulk(input);
  }

  async function refresh(id) {
    const todo = service.get(id);
    if (!todo) return service.get(id);
    if (sourceLink(todo, 'github')) return github.refreshTask(id);
    if (sourceLink(todo, 'sheet')) return sheet.refreshTask(id);
    return todo;
  }

  async function share(id, target, context, options = {}) {
    if (target === 'github') {
      return github.create({ ...service.get(id), ...(options.github || options), existingTodoId: id }, context);
    }
    if (target === 'sheet') return sheet.share(id, context, options.sheet || options);
    throw new TodoDomainError('INVALID_SYNC_TARGET', 'Share target must be github or sheet.');
  }

  return {
    create,
    update,
    move: (id, status, context, options) => service.move(id, status, context, options),
    close: (id, context) => service.complete(id, context),
    archive: (id, context) => service.archive(id, context),
    unarchive: (id, context) => service.unarchive(id, context),
    softDelete: (id, context) => service.softDelete(id, context),
    restore: (id, context) => service.restore(id, context),
    purge: input => maintenance.purgeDeleted(input),
    addNote,
    linkRelated: (leftId, rightId, context) => service.linkRelated(leftId, rightId, context),
    unlinkRelated: (leftId, rightId, context) => service.unlinkRelated(leftId, rightId, context),
    reorder: input => service.reorder(input),
    bulk,
    attachExternalLink: (id, link, context) => service.attachExternalLink(id, link, context),
    detachExternalLink: (id, connector, context) => connector === 'sheet'
      ? sheet.unshare(id, context)
      : service.detachExternalLink(id, connector, context),
    share,
    refresh,
    sheetHealth: () => ({ health: sheet.getHealth(), settings: sheet.getSettings() }),
    sheetRefresh: () => sheet.reconcile(),
    sheetBootstrap: input => sheet.bootstrapSchema(input),
    githubHealth: () => ({ health: github.getHealth(), settings: github.getSettings() }),
    githubSearch: input => github.search(input),
    githubLink: (input, context) => github.link(input, context),
    githubRefresh: () => github.reconcile(),
    githubSettings: input => github.updateSettings(input),
    githubPublishFirstNote: id => github.publishFirstNote(id),
    getPreferences: () => service.getPreferences(),
    listVentureTags: () => service.listVentureTags(),
    saveVentureTags: (tags, context) => service.saveVentureTags(tags, context),
    updatePreferences: (patch, context) => service.updatePreferences(patch, context),
  };
}
