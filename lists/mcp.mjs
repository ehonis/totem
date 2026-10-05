import { ListDomainError } from './errors.mjs';

const READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const EDIT = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
const S = { type: 'string' };
const B = { type: 'boolean' };
const N = { type: 'number' };
const O = { type: 'object' };
const output = (properties, required) => ({
  type: 'object', properties: { fetchedAt: { type: 'string' }, ...properties }, required: ['fetchedAt', ...required],
});
const itemSchema = {
  type: 'object', properties: { text: S, checked: B }, required: ['text'], additionalProperties: false,
};

export function createListMcpTools({ service, fetchedAt = () => new Date().toISOString() } = {}) {
  if (!service) throw new TypeError('createListMcpTools requires service');
  const required = (input, field) => {
    if (!input?.[field]) throw new ListDomainError(`MISSING_${field.toUpperCase()}`, `${field} is required.`);
    return input[field];
  };
  const context = (session, reason) => ({ actor: session?.actor ?? session?.client ?? 'mcp', reason: `mcp: ${reason}` });
  const stamp = (body) => ({ ...body, fetchedAt: fetchedAt() });
  return {
    async totem_get_lists(input = {}) {
      if (input.id) return stamp({ list: await service.getList(input.id) });
      const lists = await service.listLists();
      return stamp({ lists, count: lists.length });
    },
    async totem_create_list(input = {}, session) {
      return stamp({ ok: true, ...(await service.createList(input, context(session, 'create list'))) });
    },
    async totem_update_list(input = {}, session) {
      const { id, ...patch } = input;
      return stamp({ ok: true, ...(await service.updateList(required(input, 'id'), patch, context(session, 'update list'))) });
    },
    async totem_delete_list(input = {}, session) {
      return stamp(await service.deleteList(required(input, 'id'), context(session, 'delete list')));
    },
    async totem_add_list_items(input = {}, session) {
      const items = input.items ?? (input.text ? [{ text: input.text }] : null);
      return stamp({ ok: true, ...(await service.addItems(required(input, 'listId'), items, context(session, 'add list items'))) });
    },
    async totem_update_list_item(input = {}, session) {
      const { itemId, ...patch } = input;
      return stamp({ ok: true, ...(await service.updateItem(required(input, 'itemId'), patch, context(session, 'update list item'))) });
    },
    async totem_delete_list_item(input = {}, session) {
      return stamp({ ok: true, ...(await service.deleteItem(required(input, 'itemId'), context(session, 'delete list item'))) });
    },
    async totem_link_list_todo(input = {}, session) {
      return stamp({ ok: true, ...(await service.linkTodo(required(input, 'listId'), required(input, 'todoId'), context(session, 'link task to list'))) });
    },
    async totem_unlink_list_todo(input = {}, session) {
      return stamp({ ok: true, ...(await service.unlinkTodo(required(input, 'listId'), required(input, 'todoId'), context(session, 'unlink task from list'))) });
    },
  };
}

export const LIST_MCP_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'totem_get_lists', title: 'Read lists',
    description: 'Read all of the owner’s simple lists, or one list by id. Results include ordered checkable items and any related Totem tasks.',
    inputSchema: { type: 'object', properties: { id: S }, additionalProperties: false }, annotations: READ,
    outputSchema: output({ lists: { type: 'array', items: O }, list: O, count: N }, []),
  },
  {
    name: 'totem_create_list', title: 'Create a list',
    description: 'Create a named list such as Groceries or Packing. Items may be strings or {text, checked}; todoIds optionally links existing Totem tasks in the same call.',
    inputSchema: { type: 'object', properties: { title: S, items: { type: 'array', items: { anyOf: [S, itemSchema] } }, todoIds: { type: 'array', items: S } }, required: ['title'], additionalProperties: false },
    annotations: WRITE, outputSchema: output({ ok: B, list: O }, ['ok', 'list']),
  },
  {
    name: 'totem_update_list', title: 'Rename or reorder a list',
    description: 'Change a list title or its numeric position.',
    inputSchema: { type: 'object', properties: { id: S, title: S, position: N }, required: ['id'], additionalProperties: false },
    annotations: EDIT, outputSchema: output({ ok: B, list: O }, ['ok', 'list']),
  },
  {
    name: 'totem_delete_list', title: 'Delete a list',
    description: 'Permanently delete a list and its checklist items. Linked tasks are untouched.',
    inputSchema: { type: 'object', properties: { id: S }, required: ['id'], additionalProperties: false },
    annotations: EDIT, outputSchema: output({ ok: B, id: S, deleted: B }, ['ok', 'deleted']),
  },
  {
    name: 'totem_add_list_items', title: 'Add list items',
    description: 'Add one or several lines to a list. Use one call for a dictated grocery list.',
    inputSchema: { type: 'object', properties: { listId: S, text: S, items: { type: 'array', items: itemSchema } }, required: ['listId'], anyOf: [{ required: ['text'] }, { required: ['items'] }], additionalProperties: false },
    annotations: WRITE, outputSchema: output({ ok: B, itemIds: { type: 'array', items: S }, list: O }, ['ok', 'list']),
  },
  {
    name: 'totem_update_list_item', title: 'Edit or check a list item',
    description: 'Change an item’s text, checked state, or numeric position. Pass checked:false to put it back.',
    inputSchema: { type: 'object', properties: { itemId: S, text: S, checked: B, position: N }, required: ['itemId'], additionalProperties: false },
    annotations: EDIT, outputSchema: output({ ok: B, list: O }, ['ok', 'list']),
  },
  {
    name: 'totem_delete_list_item', title: 'Remove a list item',
    description: 'Permanently remove one line from a list.',
    inputSchema: { type: 'object', properties: { itemId: S }, required: ['itemId'], additionalProperties: false },
    annotations: EDIT, outputSchema: output({ ok: B, list: O }, ['ok', 'list']),
  },
  {
    name: 'totem_link_list_todo', title: 'Link a task to a list',
    description: 'Relate an existing Totem task to a list. This is a reference only; checking list items never completes the task.',
    inputSchema: { type: 'object', properties: { listId: S, todoId: S }, required: ['listId', 'todoId'], additionalProperties: false },
    annotations: WRITE, outputSchema: output({ ok: B, list: O }, ['ok', 'list']),
  },
  {
    name: 'totem_unlink_list_todo', title: 'Unlink a task from a list',
    description: 'Remove a list-to-task relationship without changing either record.',
    inputSchema: { type: 'object', properties: { listId: S, todoId: S }, required: ['listId', 'todoId'], additionalProperties: false },
    annotations: EDIT, outputSchema: output({ ok: B, list: O }, ['ok', 'list']),
  },
]);

export function createListMcpClient(options) {
  const tools = createListMcpTools(options);
  const definitions = LIST_MCP_TOOL_DEFINITIONS.map((tool) => ({ ...tool, name: tool.name.replace(/^totem_/, '') }));
  const names = new Set(definitions.map((tool) => tool.name));
  return {
    async start() {}, async listTools() { return definitions; },
    async callTool(name, args) {
      if (!names.has(name)) throw new Error(`unknown list tool: ${name}`);
      const payload = await tools[`totem_${name}`](args, { actor: 'mcp-gateway' });
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    },
    close() {},
  };
}
