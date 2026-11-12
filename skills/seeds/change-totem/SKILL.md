---
name: Change Totem
description: Build a page, feature or fix in Totem itself; it lands as a pull request you merge.
icon: wrench
command: /change-totem
---

How a change to Totem's own code is made from a chat. The work ends as a pull request the owner
merges; merging deploys it. Nothing is ever edited in the checkout Totem runs from.

1. Call change_start with a few words naming the change. It makes a fresh git worktree off
   origin/main and tells you its path. In a chat that already has a change open, it returns the
   same worktree, so follow-ups land on the same pull request.
2. Read AGENTS.md in the worktree first: it is the map of the code and the rules it depends on.
   Read mobile/AGENTS.md too when the change touches the dashboard, because the iPhone app
   mirrors the web.
3. Make the change only under the worktree path, with your file tools and shell. Keep it small
   and in the style of the code around it. Add or update tests where the code has them, and
   update AGENTS.md or docs/ when behaviour changes.
4. Do not run npm or pnpm install/add (node_modules is linked from the live checkout, so an
   install there would rewrite the live install), do not push, and never merge. You may commit in the worktree, but only the final state
   of its files is pushed, as one fresh commit. If the change needs a new dependency, add it to
   package.json and say so in the summary; CI installs it. Do not change any package.json
   "scripts".
5. Keep it under 500 files and 5 MB of diff, with plain ASCII file names. Leave these alone;
   change_finish refuses them: data/, .env files, secrets/, .git, node_modules, symlinks,
   .npmrc, pnpm-workspace.yaml, .gitattributes and other package-manager or git config, the node_modules lines in
   .gitignore, anything under auth/,
   logs/approval* and .github/, the rule-enforcing files it names, the approval, sign-in and
   agent-reach wiring in bridge.mjs, any secret or token, and the change flow itself
   (dev/change.mjs, this skill). If the request needs them, tell the owner it needs a normal
   dev session instead.
6. Run the tests you touched while you work (node --test <file>, or cd web && npm test). The
   checks must not write tracked files: change_finish refuses a push when they do.
7. Call change_finish with a plain title and a Markdown summary: what changed, why, and how the
   owner can check it. It commits, runs npm test and the web build, pushes the branch, opens
   the pull request and shows the owner a card. If it refuses or a check fails, fix it in the
   worktree and call it again.
8. Finish with one or two lines: what the pull request does, its link, and that merging
   deploys it.
