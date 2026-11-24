# The Tasks page (web)

Productivity → Tasks in the dashboard answers one question: what needs doing now. It is
one grouped list beside a detail pane, built for a keyboard and a mouse; the iPhone app
draws the same list its own way (`mobile/AGENTS.md`).

Code: `web/src/components/TodosView.tsx` (the page and its keys),
`web/src/todos/useTaskBoard.ts` (data and every change), `TaskRow.tsx`, `TaskPane.tsx`,
`QuickAdd.tsx`, `TaskMenus.tsx`, `Menu.tsx`, `todos.css`. The grouping, ordering, date
words and quick-add parser are the shared pure modules `web/src/todos/{board,format,parse,types}.ts`,
mirrored byte for byte to `mobile/src/lib/todos/`.

## The list

- **Header**: "Tasks", a live line (`2 overdue · 4 today · 3 done today`), search (`/`),
  `New task` (focuses the quick-add line) and a "…" menu: Select tasks, Snoozed, Archive,
  Recycle bin (with their counts), Group by folder, read the task sheet again, Task settings.
- **Folders.** Every task is filed under one of the owner's chat projects or the folders
  inside them (`folderId` on the task, a chat project id), or under none, which every
  client calls **Personal**. They replaced Personal/Ventures and venture tags (migration
  013; see "From areas to folders" below). A chat card in the chats panel names its linked
  task, and a change in either place shows in the other at once (`web/src/todos/bus.ts`).
- **Scope chips**: All, Personal (the unfiled), one per top-level project with something
  open in it (its own tasks, its folders' tasks and sheet rows filed there), and the task
  sheet by its own name (only once it is set up), each with its open count. A project
  with folders in use gets a second row: "All in <project>" and one chip per folder
  (`web/src/todos/byFolder.ts`).
- **Quick add**: the line at the top. `parseQuickAdd` turns "Renew passport fri p1 #home"
  into a title plus due date, priority and folder, shown as chips under the line; a chip's
  × keeps the word as text. `#folder` takes a project's or folder's name, the name run
  together (`#worknorthwind`), its path (`#Work - Northwind / r+d`) or a whole word of a
  project's name (`#northwind`); a word that fits several folders stays text. Looking at a
  folder's chip, the new task is filed there unless another `#folder` is typed.
  Enter adds through `POST /api/todos/board` (the canonical shape; words typed after the sent
  text while it is out stay on the line as the next task, and a line edited any other
  way is left as it is), keeps focus on the
  line, and scrolls to and flashes the new row, widening the scope or clearing the search
  only if the task falls outside them.
- **Groups** come from `buildList(todos, sheetItems, { now })`: Overdue, Today, Upcoming,
  No date, with sticky headings and counts; then Snoozed (with when the next one is back)
  and Completed (today) folded at the foot. "Group by folder" (the "…" menu) draws one
  group per folder instead, projects in the chats panel's order with each folder after its
  project, then Personal, keeping the day order inside each (`groupByFolder`). Which folds
  are open, the scope and the grouping are kept per browser (`totem.tasks.view`).
- **Rows** are about 40 px: a check circle, the title, and right-aligned marks drawn only
  when they say something: the due word unless the group already says it (`dueText`), a
  P1–P3 flag (nothing for P4), the folder (its icon and path; not for Personal, nor where the
  chip or the group heading already says it), repeat, a note count, and the GitHub issue link
  with its live open/closed state (`GET /api/todos/issue-states`). Snooze and due-date
  buttons appear on hover and on keyboard focus. At phone width the marks drop under the
  title, as the app draws them.
- **Sheet rows** (the read-only task sheet, `docs/task-sheet.md`) sit in the same groups,
  with the sheet's mark where a task has its check circle (its name, the feed's `title`
  or "Task sheet", is in the mark's tooltip), and snooze and open-in-sheet buttons. The
  mark turns into a check on hover: pressing it, `x` or Space marks the row done **for the
  owner only**, and `s` snoozes it; both are kept in Totem and never written to the sheet
  (`docs/task-sheet.md` → Done and snooze, for you only). A snoozed row waits in the
  Snoozed fold and a done one in Completed, where its check puts it back. Their flag keeps the
  sheet's word and takes the colour of what it means beside a task's: one mapping,
  `sheetAsTaskPriority` in `board.ts`, ranks, filters and colours them on the web and
  in the app: High as P2 (amber), Medium as P3 (blue), Low in the P3 band but muted. Their "In Progress" shows only
  in the pane: a task is open or done. In every scope that shows sheet rows, a failed
  read with no rows yet ("its rows are missing") or rows kept from an earlier read while
  the latest failed ("showing rows read at …") is said once,
  quietly, at the top of the list with Try again; "nothing assigned to you" is said in
  the sheet's own scope, and a sheet that is not set up is offered once, in the summary.

## Changing a task

- **Complete** with one click on the circle, `x` or Space. The row stays a beat, checked,
  then leaves for Completed; a toast offers Undo. The keyboard cursor moves on to the next
  row at once, so `x x x` finishes three in a row; whenever a row leaves the list (done,
  snoozed, binned, rescheduled into another group) the cursor and focus stay at its place,
  and a pane showing that task follows to the same row. A pane showing another task stays put. A repeating task with a due date
  rolls its next occurrence on the bridge whatever it links (`rollsOnCompletion`; nothing
  owns completion), so it reads the next one in and says when it is due instead of
  offering Undo (`afterDone`): reopening would leave two copies.
- **Select tasks** (the "…" menu) acts on many at once. Done's Undo reopens only the
  tasks it finished that did not roll (never one already done before); the toast says how
  many repeating tasks rolled to their next date.
- **Snooze** (`s`, or the hover button) offers `snoozeTimes` plus a picked time; Undo
  wakes it. **Not doing** and **delete** (Delete/Backspace) offer Undo too.
- **The pane** opens the selected row on the right (Enter or a click) and follows the
  keyboard cursor. Everything saves as it changes, with no Save button: title (Enter or
  leaving the field), description, Due, Priority, Folder (the chats panel's folder picker,
  with Personal first), Repeat, Snooze, the issue link (`PUT /api/todos/:id/issue-link`),
  notes (composer on top, newest first; an unsent note is kept per task until sent), the
  chats linked to the task with New chat, related tasks, and Chat about this. Esc in the title
  or description puts the saved text back and saves nothing. A refused change puts back
  only the fields it touched, names them in the toast, and never draws over a later edit. A sheet row opens
  read-only with Open in sheet, except its Folder, which files it (`PUT /api/chat/task-folders/<row id>`), and its
  check and Snooze, which are the owner's own (`POST /api/todos/sheet/mark`). With nothing selected the pane is today's summary and the
  keys. Below ~1100 px the pane slides over the list; at phone width it fills the screen.
- **Archive and recycle bin** open in the pane from the "…" menu and are read only then;
  a task opened from either is shown read-only there, with Unarchive or Restore;
  the page counts them from the board's `counts`, never by downloading them. Retention
  (archive hour, archive age, recycle-bin purge) is in Settings → Tasks.

## From areas to folders

Tasks used to be Personal or Ventures with a venture tag. Migration 013 adds `folder_id`
(NULL = Personal); the bridge's `adoptTaskFolders` runs once per install (marker
`foldersAdopted` in `todo_preferences`): a task the chats panel had filed in
`data/task-folders.json` takes that folder, and a Ventures task takes the top-level project
named like its venture tag (`folderAdoption` in `todos/folders.mjs`); everything else is
Personal. `area` and `venture_tag` stay in the database and the API for older clients and
exports, and nothing draws them. The bridge refuses a `folderId` that is not an existing
chat project (`UNKNOWN_FOLDER`); a task whose project is deleted later moves to that
folder's project, or becomes Personal (`refileFolder`). Agents read and set the folder by
name (`totem_get_tasks`, `totem_create_task`, `totem_update_task`; `totem_get_projects`
lists the folders), and a task an agent creates from a chat in a project lands in that
project and is linked to the chat (`docs/chat.md` → Linked tasks).

## Keys

The list is one tab stop (a roving focus over its rows).

| Key | Does |
|---|---|
| `j` / `k`, ↓ / ↑, Home / End | Move between rows (the pane follows when open) |
| `x`, Space | Complete or reopen (select mode: select); on a sheet row, done for you or back |
| `s` / `d` / `p` | Snooze / due date / priority menu (a sheet row: snooze only) |
| `n` | The quick-add line (New task), from anywhere on the page |
| `m` | Open the row with the note composer focused |
| `g t t` | The quick-add line, from anywhere in the dashboard |
| Enter | Open the row in the pane |
| `o` | Open a sheet row in the sheet, or a task's issue |
| Delete / Backspace | Move to the recycle bin (Undo) |
| Esc | Close the pane, leave select mode, clear the search |
| `/` | Search |

The Snoozed and Completed headings are buttons: Space or Enter there toggles the fold
and never acts on the row under the cursor. The keys also work from a control inside a row
(its select box, an issue link), except Space and Enter, which stay that control's. Page keys stand down while a dialog (Settings) is open over the page. Menus take focus when they open, move with ↑/↓ (or `j`/`k`), pick with Enter, and give
focus back when they close.
