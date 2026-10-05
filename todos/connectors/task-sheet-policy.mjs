import { TodoDomainError } from '../errors.mjs';

// Google Sheet task sync: one shared spreadsheet of action items, mirrored with
// the Ventures tasks on the board. Nothing here names a particular sheet or
// person: the spreadsheet, its tab and whose rows count are configured once at
// startup through configureTaskSheet() (TASK_SHEET_* settings; docs/task-sheet.md).
//
// The layout is fixed: headers on row 4 starting at column B, in the order of
// ACTION_ITEM_HEADERS, with the Totem ID column hidden.
export const ACTION_ITEMS = {
  spreadsheetId: '',
  // Optional extra guard: when set, the spreadsheet's title must match exactly.
  spreadsheetTitle: '',
  tab: 'Action Items',
  sheetId: 0,
  headerRow: 4,
  firstColumnIndex: 1,
};
// Values of the Who column that mean "the owner's". The first is what a task
// shared from Totem is assigned to.
let ASSIGNEES = [];
// The install's venture tags; the Tag column must hold one of them.
let ventureTagNames = () => [];

export function configureTaskSheet({ spreadsheetId, spreadsheetTitle, tab, sheetId, assignees, ventureTags } = {}) {
  if (spreadsheetId !== undefined) ACTION_ITEMS.spreadsheetId = String(spreadsheetId || '').trim();
  if (spreadsheetTitle !== undefined) ACTION_ITEMS.spreadsheetTitle = String(spreadsheetTitle || '').trim();
  if (tab) ACTION_ITEMS.tab = String(tab).trim();
  if (sheetId !== undefined && sheetId !== '' && Number.isInteger(Number(sheetId))) ACTION_ITEMS.sheetId = Number(sheetId);
  if (assignees !== undefined) {
    ASSIGNEES = (Array.isArray(assignees) ? assignees : String(assignees || '').split(','))
      .map(name => String(name).trim()).filter(Boolean);
  }
  if (typeof ventureTags === 'function') ventureTagNames = ventureTags;
}

export function taskSheetSettings() {
  return { ...ACTION_ITEMS, assignees: [...ASSIGNEES], ventureTags: ventureTagNames() };
}

/** Is there enough configuration to sync (apart from the credentials file)? */
export function taskSheetConfigured() {
  return Boolean(ACTION_ITEMS.spreadsheetId && ASSIGNEES.length);
}

export function isOwnerAssignee(who) {
  return ASSIGNEES.includes(normalizedCell(who));
}

export const ACTION_ITEM_HEADERS = Object.freeze([
  'Task Name', 'Who', 'Priority', 'Status', 'Due Date', 'Notes & Links', 'Tag', 'Totem ID',
]);
const FIELD_BY_HEADER = Object.freeze({
  'Task Name': 'title',
  Who: 'who',
  Priority: 'priority',
  Status: 'status',
  'Due Date': 'dueDate',
  'Notes & Links': 'notes',
  Tag: 'tag',
  'Totem ID': 'totemId',
});
// Back-compat: the live sheet's id column was headed "Vesper ID" before the
// 2026-10-02 rename. Read either; new sheets are bootstrapped with "Totem ID".
// Can go once every synced sheet's header is renamed to "Totem ID".
const LEGACY_ID_HEADER = 'Vesper ID';
const PRIORITY_TO_LABEL = Object.freeze({ 4: 'High', 3: 'Medium', 2: 'Low', 1: 'Low' });
const LABEL_TO_PRIORITY = Object.freeze({ High: 4, Medium: 3, Low: 2 });

function policyError(code, message, details) {
  return new TodoDomainError(code, message, { details });
}

function normalizedCell(value) {
  return value == null ? '' : String(value).trim();
}

function exactSheet(metadata) {
  if (!ACTION_ITEMS.spreadsheetId) {
    throw policyError('TASK_SHEET_NOT_CONFIGURED', 'No task sheet is configured (TASK_SHEET_ID).');
  }
  if (metadata?.spreadsheetId !== ACTION_ITEMS.spreadsheetId) {
    throw policyError('WRONG_ACTION_ITEMS_SPREADSHEET', 'Refusing a different Google spreadsheet.');
  }
  if (ACTION_ITEMS.spreadsheetTitle && metadata?.properties?.title !== ACTION_ITEMS.spreadsheetTitle) {
    throw policyError('WRONG_ACTION_ITEMS_TITLE', 'Refusing a spreadsheet with a different title.');
  }
  const matches = (metadata.sheets ?? []).filter(sheet =>
    sheet?.properties?.sheetId === ACTION_ITEMS.sheetId &&
    sheet?.properties?.title === ACTION_ITEMS.tab);
  if (matches.length !== 1) {
    throw policyError('ACTION_ITEMS_SHEET_NOT_FOUND', 'The exact Action Items sheet id/title pair was not found.');
  }
  const timeZone = normalizedCell(metadata?.properties?.timeZone);
  if (!timeZone) throw policyError('ACTION_ITEMS_TIMEZONE_MISSING', 'Spreadsheet timezone is required.');
  return { sheet: matches[0], timeZone };
}

export function resolveActionItemSchema({ metadata, headerValues } = {}) {
  const { timeZone } = exactSheet(metadata);
  if (!Array.isArray(headerValues)) throw policyError('ACTION_ITEMS_HEADERS_INVALID', 'Header row must be an array.');
  const values = headerValues.map(normalizedCell);
  const columns = {};
  for (const header of ACTION_ITEM_HEADERS) {
    const names = header === 'Totem ID' ? ['Totem ID', LEGACY_ID_HEADER] : [header];
    const positions = values.flatMap((value, index) => names.includes(value) ? [index] : []);
    if (positions.length === 0) throw policyError('ACTION_ITEMS_HEADER_MISSING', `Missing exact header: ${header}`, { header });
    if (positions.length > 1) throw policyError('ACTION_ITEMS_HEADER_DUPLICATE', `Duplicate exact header: ${header}`, { header });
    columns[FIELD_BY_HEADER[header]] = positions[0];
  }
  return {
    spreadsheetId: ACTION_ITEMS.spreadsheetId,
    tab: ACTION_ITEMS.tab,
    sheetId: ACTION_ITEMS.sheetId,
    headerRow: ACTION_ITEMS.headerRow,
    dataStartRow: ACTION_ITEMS.headerRow + 1,
    firstColumnIndex: ACTION_ITEMS.firstColumnIndex,
    timeZone,
    headers: values,
    columns,
  };
}

function dateOnly(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400_000).toISOString().slice(0, 10);
  }
  const text = normalizedCell(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!match) throw policyError('INVALID_ACTION_ITEMS_DATE', `Unsupported Sheet date: ${text}`);
  const iso = `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  if (new Date(`${iso}T00:00:00.000Z`).toISOString().slice(0, 10) !== iso) {
    throw policyError('INVALID_ACTION_ITEMS_DATE', `Invalid Sheet date: ${text}`);
  }
  return iso;
}

export function parseActionItemRow({ headers, values = [] } = {}) {
  const columns = headers?.columns ?? headers;
  const read = field => values[columns[field]];
  const priorityLabel = normalizedCell(read('priority')) || 'Medium';
  if (!Object.hasOwn(LABEL_TO_PRIORITY, priorityLabel)) {
    throw policyError('INVALID_ACTION_ITEMS_PRIORITY', `Unsupported Sheet priority: ${priorityLabel}`);
  }
  return {
    title: normalizedCell(read('title')),
    who: normalizedCell(read('who')),
    priority: LABEL_TO_PRIORITY[priorityLabel],
    priorityLabel,
    status: normalizedCell(read('status')),
    dueDate: dateOnly(read('dueDate')),
    notes: normalizedCell(read('notes')),
    tag: normalizedCell(read('tag')),
    totemId: normalizedCell(read('totemId')),
  };
}

export function eligibleActionItem(row) {
  return isOwnerAssignee(row?.who) &&
    (row?.status === 'Not Started' || row?.status === 'In Progress') &&
    ventureTagNames().includes(row?.tag);
}

function requireTag(tag) {
  if (!ventureTagNames().includes(tag)) {
    throw policyError('INVALID_VENTURE_TAG', `Sheet tasks require one of the configured venture tags: ${ventureTagNames().join(', ') || 'none configured'}.`);
  }
  return tag;
}

function priorityLabel(priority = 3) {
  const value = PRIORITY_TO_LABEL[Number(priority)];
  if (!value) throw policyError('INVALID_ACTION_ITEMS_PRIORITY', 'Priority must be 1 through 4.');
  return value;
}

export function buildCreationRow(input = {}) {
  const row = {
    title: normalizedCell(input.title),
    who: ASSIGNEES[0] || '',
    priority: priorityLabel(input.priority),
    status: 'Not Started',
    dueDate: dateOnly(input.dueDate),
    notes: normalizedCell(input.notes ?? input.description),
    tag: requireTag(input.ventureTag ?? input.tag),
    totemId: normalizedCell(input.totemId),
  };
  if (!row.title || !row.totemId) throw policyError('INVALID_ACTION_ITEMS_CREATE', 'Title and Totem ID are required.');
  if (!row.who) throw policyError('TASK_SHEET_NOT_CONFIGURED', 'No sheet assignee is configured (TASK_SHEET_ASSIGNEES).');
  return { ...row, ownedAtCreate: { who: row.who, status: row.status } };
}

export function buildUpdateSet(input = {}) {
  const update = {};
  if (Object.hasOwn(input, 'title')) update.title = normalizedCell(input.title);
  if (Object.hasOwn(input, 'priority')) update.priority = priorityLabel(input.priority);
  if (Object.hasOwn(input, 'dueDate')) update.dueDate = dateOnly(input.dueDate);
  if (Object.hasOwn(input, 'notes') || Object.hasOwn(input, 'description')) update.notes = normalizedCell(input.notes ?? input.description);
  if (Object.hasOwn(input, 'ventureTag') || Object.hasOwn(input, 'tag')) update.tag = requireTag(input.ventureTag ?? input.tag);
  return update;
}

export function validateStableIds(rows) {
  const seen = new Set();
  for (const row of rows) {
    const id = normalizedCell(row?.totemId);
    if (!id) continue;
    if (seen.has(id)) throw policyError('DUPLICATE_TOTEM_ID', `Duplicate Totem ID: ${id}`, { id });
    seen.add(id);
  }
  return [...seen];
}

export function buildSchemaBootstrap({ metadata, headerValues } = {}) {
  exactSheet(metadata);
  const current = (headerValues ?? []).map(normalizedCell);
  const expectedExisting = ACTION_ITEM_HEADERS.slice(0, 6);
  if (current.length !== 6 || current.some((value, index) => value !== expectedExisting[index])) {
    throw policyError('ACTION_ITEMS_BOOTSTRAP_UNSAFE', 'Schema bootstrap requires the verified six-column Action Items header.');
  }
  return {
    headerValues: [{ range: `'${ACTION_ITEMS.tab}'!H4:I4`, values: [['Tag', 'Totem ID']] }],
    requests: [
      {
        setDataValidation: {
          range: { sheetId: ACTION_ITEMS.sheetId, startRowIndex: 4, startColumnIndex: 7, endColumnIndex: 8 },
          rule: {
            condition: { type: 'ONE_OF_LIST', values: ventureTagNames().map(userEnteredValue => ({ userEnteredValue })) },
            strict: true,
            showCustomUi: true,
          },
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: ACTION_ITEMS.sheetId, dimension: 'COLUMNS', startIndex: 8, endIndex: 9 },
          properties: { hiddenByUser: true },
          fields: 'hiddenByUser',
        },
      },
    ],
  };
}
