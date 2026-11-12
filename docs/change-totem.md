# Changing Totem from a chat

"Build me a page for my reading list" or "add a notes field to goals" asked in a chat ends as a
pull request the owner merges. Merging deploys it. The agent never edits the checkout Totem runs
from, and the flow has no way to merge.

**Off by default.** The owner turns it on with `CHANGE_FLOW_ENABLED=true` in `.env` and a
restart. It needs Totem running from a git checkout whose `origin` the service user can push to
with git and `gh`.

## How it runs

1. The owner asks in a chat (or cites `/change-totem`). A dashboard chat run on **Full access**,
   whose bridge runs from a git checkout, has two tools on its `/agent-mcp` endpoint (and as
   `browser__change_*` through the gateway for Cursor and OpenCode), plus one prompt line saying
   where the live checkout is and that it is off limits. Supervised, Auto-accept edits and Auto
   chats don't get them: the checks run the change's own code with network, which is only as
   much as a Full-access agent can already do from its shell. Whether other modes should get
   them is the owner's call.
2. `change_start` (`dev/change.mjs` → `start`, one at a time per chat):
   - checks where the worktree would go before creating anything there;
   - fetches `origin/main` into `refs/totem-change/base`, so the live checkout's own
     `refs/remotes/origin/main` (which a deploy fast-forwards from) is never locked;
   - adds a worktree on a new `totem-change/<name>-<id>` branch under `CHANGE_WORKTREES_DIR`
     (default `~/.totem-changes`), links `node_modules` and `web/node_modules` from the live
     checkout and checks they are ignored;
   - returns the path and the owner's copy of the `change-totem` skill as the steps.

   A chat that already has a change gets the same worktree back, so follow-ups update the same
   PR. If that PR has been merged or closed, the old worktree is removed and a fresh one starts
   off the new `origin/main`. If the record no longer checks out against git and GitHub (the
   remote branch moved, for example after GitHub's "Update branch", or the bridge died between
   a push and saving it), the chat moves to a fresh branch and its own PR. The old worktree
   stays on disk for the agent to copy from, and cleanup removes it later. GitHub being
   unreachable is not that case: it is a plain "try again", and the chat keeps its PR. If
   anything fails after a new worktree exists, it is removed with its branch.
3. The agent edits files under the worktree with its own tools. It may commit there, but none of
   its commits are pushed.
4. `change_finish` (`finish`):
   - refuses if the live checkout picked up changes since `start`, by content hash, so further
     edits to a file that was already dirty count too (a dirty live checkout blocks every
     deploy);
   - stages the worktree into a tree and checks that tree as one diff against the base (see
     "What is refused");
   - makes one fresh commit of that tree on top of the last push (or the base). Whatever the
     agent committed and reverted on the way never leaves the machine;
   - runs `nice -n 10 npm test` (retried once; a pass on the retry is flagged) and
     `cd web && npm run build` with a scrubbed environment (no `BRIDGE_SECRET`, tokens or data
     paths);
   - refuses if the checks moved `HEAD` or wrote tracked files, if `node_modules` stopped being
     ignored, or if the live checkout got dirty meanwhile;
   - pushes exactly that commit's SHA to its own `totem-change/*` branch (never `HEAD`, never
     forced);
   - opens the PR with `gh pr create` and records it at once. If gh says the PR already exists,
     it looks it up with `gh pr view <branch>`. Later calls update the same PR;
   - waits briefly for checks to register and returns the card.

   Stop, or the CLI giving up on the call, ends `finish` at once. The checks run in a process
   group of their own, and a stop or timeout kills the whole tree (`killTree`). A stop is
   checked again before the commit, the push and the PR.
5. The bridge adds the card to the reply (`change-pr` part: link, number, title, branch, head,
   files, CI state at push time, warnings) and writes `change.pr` to the action log. The card
   says "(at push)"; its Checks button shows CI as it is now.
6. `cleanup()` runs a minute after boot and then every six hours. It removes worktrees and local
   branches whose PR is merged or closed, ones left without a PR for 14 days, and replaced ones
   14 days after they were replaced. A worktree with an open PR stays.

## What is refused

Every path is compared case-folded, because the deploy host's filesystem (macOS) is
case-insensitive: `Auth/owner.mjs` lands on `auth/owner.mjs` there. Names outside plain ASCII are
refused outright, since JavaScript and the filesystem fold `ſ`, `ß` and `ı` differently.

Every check reads git's output in full: a list or a diff that would not fit is a refusal, never
a partial read. A change is also capped at 500 files and 5 MB of diff. Diffs are read with
`--no-color --no-ext-diff --no-textconv` and fixed prefixes, and every git call runs with
hooks and fsmonitor off, no global attributes file, and an empty override for every filter
`git config` lists at the start of each step. That stops the owner's and the repo's config
from hiding a line or running a filter in the ordinary cases, but it is not a promise: config
pulled in conditionally (`includeIf`) or changed mid-step can still name a filter it missed.
While `.git/info/attributes` exists, both tools refuse before running any git command that
could apply it.

- **Denied:** `data/`, `.env*` (except `.env.example`), `secrets/`, any `.git`, any `node_modules`,
  and package-manager or git config files anywhere (`.npmrc`, `.yarnrc*`, `.nvmrc`,
  `.node-version`, `.pnpmfile.cjs`, `bunfig.toml`, `.gitattributes`, `.gitmodules`).
- **Not plain files:** symlinks and submodules. A public file linked to `data/auth.json` would
  be copied into `web/dist` by the build and served with no sign-in.
- **Case collisions:** a new path that differs from an existing one only in case.
- **Protected:**
  - `auth/`, `logs/approval*` and `.github/`;
  - the change flow itself (`dev/change.mjs`, its test, `skills/seeds/change-totem/`);
  - code served before sign-in, each guarding itself: `chat/uploads.mjs`, `notify/http.mjs`,
    `dev/ingest.mjs`, `fleet/http.mjs`, `google/accounts.mjs` (the OAuth callbacks' state check),
    and in `bridge.mjs` `/mcp`, the callbacks, the push and alert routes and the signed uploads;
  - files that enforce rules agents are held to: `providers/instances.mjs`, `drive/index.mjs`,
    `providers/claude-tools.mjs`, `chat/approvals.mjs`,
    `scripts/kill-tree.mjs`, `gmail/index.mjs`, `terminal/sessions.mjs`, `goals/http.mjs`,
    `chat/reach.mjs`, `mcp-gateway.mjs`, `scripts/start.mjs`, `scripts/service-manager.mjs`.
- **`bridge.mjs` lines** naming the approval routes (including Claude's tool approvals,
  `/api/chat/approvals`, `askApproval`, `permissionResult`, `allowedTools`), inbox resolution
  (`approvedVia`, `doResolveInboxItem`), chat access modes, the auth wiring, agent reach (`handleAgentMcp`, `grantChatAccess`,
  `limitReach`) or this flow's own wiring.
- **Package `scripts`:** `package.json`, `web/`, `mobile/` and `desktop/package.json` may only
  change dependencies. Their scripts run on install, in CI and in the checks.
- **`.gitignore` lines about `node_modules`:** the linked `node_modules` must stay ignored as
  `node_modules`, without a trailing slash.
- **Secrets in a changed file:** every added or modified file is read whole at the tree being
  pushed (not as diff lines), then searched in two ways:
  - with a plain substring search for each secret Totem holds: the secret-named fields of its
    credential files (`data/auth.json`, `ai-settings.json`, `integrations.json`,
    `data/*-tokens.json`, `~/.config/google-calendar-mcp/tokens.json`), the env values and
    headers of `data/mcp-manifest.json`, and secret-named environment variables such as
    `BRIDGE_SECRET`, each 12 characters or longer;
  - for the token shapes `chat/redact.mjs` knows, plus Google's OAuth tokens (GitHub,
    Anthropic/OpenAI, Slack, AWS, Google API keys, `ya29.` and `1//` tokens, JWTs, private
    keys).

  A manifest value counts when the connections catalog marks its field secret, or when the
  catalog doesn't know it and its name looks like a secret. A hit the file already had on the
  base doesn't count, so a test fixture's fake token can still be edited around. The rest of
  `data/` is not read: chat transcripts hold the agent's own code in their tool cards. The
  refusal names the file and where the matched value came from ("matches a value from
  mcp-manifest.json env SLACK_BOT_TOKEN"), never the value.

Flagged on the card and in the PR body, not refused:

- a web change with no `mobile/` change;
- changes to `AGENTS.md` or `mobile/AGENTS.md`. They hold the rules every agent reads, but
  AGENTS.md requires a feature to update it, so refusing would block every documented change;
- new lines elsewhere that name the rules (`approvedVia`, `limitReach`, `BRIDGE_SECRET`, …);
- a test that passed only on its retry.

### Why refused rather than flagged

The issue offered "refuse, or flag loudly in the PR body". Refusing wins:

- Pushing a branch already runs its workflow files on the self-hosted runner, before anyone reads
  a PR body.
- The owner merges from a card, often on a phone, and merging deploys. A warning is easy to miss.
- The agent proposing the change is the party those checks hold. A design where it can edit its
  own guardrails and ship them (the external repo this idea came from) is the failure to avoid.
  The checks run from the live checkout's code, never the worktree's.

Changes there are for a normal dev session. The `bridge.mjs` line check is a tripwire, not a
proof; the owner's review is still the boundary.

## Limits

- **No merge, by convention only.** The flow has no merge path, and the prompt forbids merging.
  But agents run with the service user's `gh` login, so nothing on GitHub stops a `gh pr merge`
  from a shell. `main` has no branch protection or rulesets today; enforcing "no merge" needs
  them, and that is the owner's decision.
- **Shell writes.** Claude runs get deny rules for file-tool writes to the worktrees' `data/`,
  env files, `secrets/` and `.git`, and the live repo's `.git/`. A shell can still write
  anywhere, which is why `finish` checks the tree for every backend.
- **The checks run the change's code**, as the owner's user and with network. They get a
  throwaway `HOME` (no `~/.config/gh` login, no `~/.npmrc`, no `~/.ssh`), no global or system git
  config, and none of the bridge's variables, so `gh` and git have no credentials to hand them.
  Anything else the owner's user can reach, they can. That is the reason only Full-access chats
  get the tools. What the checks cannot do is change what gets pushed: the SHA is fixed before
  they run, and a changed worktree refuses the push.
- **The records file** (`data/changes.json`) is denied to Claude's file tools, and `finish`
  checks everything it reads from it against git and GitHub before acting on it:
  - the branch name and the live checkout;
  - that the worktree is a real folder directly under the worktrees root, the top of its own
    worktree, and part of the live repository (checked again before staging and before the
    push);
  - that the base is on a freshly fetched `origin/main`;
  - that the last push is the remote branch's tip;
  - that the PR is on this branch.

  The live checkout's state at start is kept in memory for the life of the process; the
  file's copy is used only after a restart. If GitHub can't be reached while a PR is on
  record, nothing is pushed.
- **The secret scan is a tripwire for accidents, not a boundary.** It catches a secret pasted
  or copied into a change. A secret that is split, reversed, encoded (base64, hex), shorter than
  12 characters, or not in one of the credential files passes. And a Full-access agent holds
  the owner's git credentials in its own shell, so it can push by hand without this flow at
  all.
- **Dependencies.** Tests run against the live checkout's `node_modules`, so a change that adds a
  dependency fails locally until CI installs it. The skill says so.
- **CI on the card** is a snapshot from when the branch was pushed.
