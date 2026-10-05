# brain.example — starter structure for your second brain

This folder is a **committed template**. The real second brain lives at `data/brain/`
(gitignored, private, never committed). This example shows the folder layout, file
conventions, and entry formats the assistant expects — with placeholder data.

## First-time setup

```bash
# From the repo root, seed your private brain from this template:
cp -a brain.example data/brain

# (optional) give it local version history with no remote:
cd data/brain && git init && git add . && git commit -m "Initialize brain"
```

The assistant reads/writes `data/brain` via the `MEMORY_ROOT` env var, which defaults to
`data/brain`. Override it in `.env` only if you keep your brain somewhere else.

## Layout

| Path | Holds |
|------|-------|
| `AGENTS.md` | Rules + schema the agent follows when reading/writing memory. |
| `index.md` | Map of the vault and high-value current facts — the agent reads this first. |
| `inbox.md` | Confirm-only proposals staged by the nightly journal ingest. |
| `events/YYYY-MM.md` | Chronological log of completed actions and observations. |
| `profile/*.md` | Durable personal facts, preferences, routines, defaults. |
| `people/*.md` | People-related memory (relationships, context). |
| `projects/*.md` | Project decisions and context. |
| `reference/*.md` | Stable reference info (home, devices, finances, wishlist). |

All files are plain Markdown, line-oriented for fast `rg` lookup. See `AGENTS.md` for the
exact entry formats.
