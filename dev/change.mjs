// dev/change.mjs — "change the app" from a chat: the work lands as a pull request
// the owner merges, never as edits to the checkout Totem runs from.
//
// The agent edits files; this module does everything that crosses a boundary.
// `start` makes a fresh git worktree off origin/main, outside the live checkout.
// `finish` stages the worktree into a tree, checks that tree, makes one fresh
// commit from it, runs the tests and the web build, and pushes exactly that
// commit to the change branch. It then opens (or updates) the PR and returns
// the card the chat shows. What is pushed is always a commit this module made
// from a tree it checked, so history the agent made itself (a secret committed
// and reverted) never leaves the machine. Nothing here merges: merging deploys,
// and that stays the owner's.
//
// The guardrails run from the live checkout's copy of this file, never the
// worktree's, and a change to this file, auth, approvals or CI workflows is
// refused outright (PROTECTED). Flagging them in the PR body was the other
// option; refusing wins because pushing a branch already runs its workflow files
// on the self-hosted runner, because the owner merges from a card on a phone
// where a warning is easy to miss, and because the agent proposing the change is
// the party those checks exist to hold. Changes there are for a normal dev
// session, not a chat.
//
// Paths are compared case-folded and NFC-normalised: the deploy host's
// filesystem (macOS) is case-insensitive, so `Auth/owner.mjs` lands on
// `auth/owner.mjs`.
//
// Every command goes through `run(cmd, args, opts)`, which resolves to
// `{ code, stdout, stderr }`; tests pass a fake so nothing reaches git remotes,
// gh or the network.

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, realpath, symlink, lstat } from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute, basename } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { AGENT_SPAWN, killTree, trackAgent } from '../scripts/kill-tree.mjs'

export const CHANGE_START = 'change_start'
export const CHANGE_FINISH = 'change_finish'
export const CHANGE_TOOL_NAMES = Object.freeze([CHANGE_START, CHANGE_FINISH])
export const BRANCH_PREFIX = 'totem-change/'
// Where `start` fetches origin/main to, so the live checkout's own
// refs/remotes/origin/main (which a deploy fast-forwards from) is never locked.
const BASE_REF = 'refs/totem-change/base'
// A worktree with no PR is dropped after this long by cleanup().
export const ABANDONED_MS = 14 * 86_400_000
// The most a chat change may carry. Past this it is a dev session's job, and the
// checks below only ever read output they have in full.
export const MAX_FILES = 500
export const MAX_DIFF_BYTES = 5 * 1024 * 1024
// The most any git read may print before it is refused rather than read in part:
// a check over a cut-off list passes whatever was cut.
export const MAX_GIT_OUTPUT = 16 * 1024 * 1024

/** A path as the deploy host's filesystem sees it: forward slashes, NFC, case-folded. */
export function foldPath(path) {
  return String(path || '').replace(/\\/g, '/').replace(/^\.\/+/, '').normalize('NFC').toLowerCase()
}

const segments = (p) => p.split('/')
const CONFIG_FILES = new Set(['.npmrc', 'pnpm-workspace.yaml', '.yarnrc', '.yarnrc.yml', '.nvmrc', '.node-version', '.pnpmfile.cjs', 'bunfig.toml', '.gitattributes', '.gitmodules'])

// Never written by a change, whatever the agent stages: runtime data, secrets,
// git internals, and a node_modules (the worktree's is a symlink to the live
// one; see the AGENTS.md gotcha). Tested against foldPath().
const DENIED = [
  // Case-folding beyond ASCII differs between JavaScript and the deploy host's
  // filesystem (ſ, ß, ı), so only ASCII names are compared at all.
  { test: (p) => /[^\x20-\x7e]/.test(p), why: 'a name with characters outside plain ASCII' },
  { test: (p) => p === 'data' || p.startsWith('data/'), why: 'runtime data' },
  { test: (p) => /^\.env(\..*)?$/.test(segments(p).pop()) && segments(p).pop() !== '.env.example', why: 'an env file' },
  { test: (p) => p === 'secrets' || p.startsWith('secrets/'), why: 'secrets' },
  { test: (p) => segments(p).includes('.git'), why: 'git internals' },
  { test: (p) => segments(p).includes('node_modules'), why: 'node_modules' },
  // Configuration that changes what npm, pnpm or git run or show: script-shell and
  // registry in .npmrc; scriptShell, pnpmfile, registries and which packages may run
  // install scripts in pnpm-workspace.yaml; filters and diff drivers in .gitattributes.
  { test: (p) => CONFIG_FILES.has(segments(p).pop()), why: 'package-manager or git configuration' },
]

// The security boundary, the rules agents are held to, and the flow's own
// guardrails: refused, for the owner to change in a normal dev session.
const PROTECTED_FILES = {
  'dev/change.mjs': "this flow's own guardrails",
  'dev/change.test.mjs': "this flow's own guardrails",
  'providers/instances.mjs': 'the agent secret deny rules',
  'providers/claude-tools.mjs': 'chat access modes and the tools each Claude run may use',
  'chat/approvals.mjs': 'Claude tool approvals',
  'scripts/kill-tree.mjs': "the flow's process control",
  'gmail/index.mjs': 'the never-send rule for email',
  'terminal/sessions.mjs': 'the web terminal',
  'goals/http.mjs': 'goal completion rules',
  'chat/reach.mjs': 'what agent runs can reach (limitReach)',
  'mcp-gateway.mjs': 'the tool gateway every agent uses',
  'scripts/start.mjs': 'how Totem starts',
  'scripts/service-manager.mjs': 'service restarts',
  // Served before the sign-in check, each guarding itself.
  'chat/uploads.mjs': 'signed upload links, served before sign-in',
  'notify/http.mjs': 'push routes served before sign-in',
  'dev/ingest.mjs': 'the alert route served before sign-in',
  'fleet/http.mjs': 'the Fleet report route served before sign-in',
  'google/accounts.mjs': 'the Google sign-in callbacks (their state check)',
  'drive/index.mjs': 'the never-share rule for Drive',
  // LinkedIn is read, never acted on: the GET-only page policy, the tools (none acts),
  // the reader (pages only through it) and the once-per-target card rules.
  'browser/read-only.mjs': 'the GET-only policy of a read-only page load',
  'linkedin/mcp.mjs': 'the never-act rule for LinkedIn',
  'linkedin/reader.mjs': 'the read-only LinkedIn reader',
  'linkedin/urls.mjs': 'the hosts a LinkedIn read may reach',
  'linkedin/proposals.mjs': 'the LinkedIn card rules',
  // Agent-written chart pages: the policy they are served under, and the frame's sandbox.
  'chat/visuals.mjs': 'the sandbox agent-written chart pages are served under',
  'web/src/chat/visuals.ts': "the chart frame's sandbox",
  'web/src/chat/visualframe.tsx': "the chart frame's sandbox", // folded: foldPath lowercases
}
const PROTECTED = [
  { test: (p) => p.startsWith('auth/'), why: 'sign-in and auth code' },
  { test: (p) => /^logs\/approval/.test(p), why: 'approval code' },
  { test: (p) => p.startsWith('.github/'), why: 'CI workflows, which run on push' },
  { test: (p) => p.startsWith('skills/seeds/change-totem/'), why: "this flow's own skill" },
  { test: (p) => p in PROTECTED_FILES, why: null },
]

// Changed only by adding dependencies: their `scripts` run on install, in CI and
// in the checks, so a change to them is refused.
export const PACKAGE_FILES = ['package.json', 'web/package.json', 'mobile/package.json', 'desktop/package.json']

// bridge.mjs holds the approval routes, the auth wiring and this flow's wiring
// among everything else, so it is checked by line: a changed line that names
// one of these is refused. A tripwire, not a proof; the owner's review is the
// boundary.
const GUARDED_LINE = new RegExp([
  '/api/approvals', 'approvalController', 'createApproval', 'approvedVia', 'doResolveInboxItem', 'actionInboxItem', 'logs/approval',
  'auth/(owner|http|guard)', 'createOwnerAuth', 'ownerAuth', 'authHttpHandler', 'guardRequest', 'upgradeOriginAllowed', 'TOTEM_AUTH',
  'dev/change\\.mjs', 'changeFlow', 'changeTools', 'CHANGE_FLOW_ENABLED', 'CHANGE_WORKTREES_DIR', 'CHANGE_RECORDS_FILE', 'changeSecrets',
  'CHANGE_TOOL', 'change_start', 'change_finish', 'changeDenyRules', 'claudeSecretDenyRules', 'AGENT_SECRET_PATHS',
  'handleAgentMcp', 'grantChatAccess', 'agentBrowserAccess', 'limitReach',
  'api/chat/approvals', 'chat/approvals', 'approvalWaits', 'askApproval', 'permissionResult', 'sessionRules', 'mergeAllowedTools',
  'allowedTools', 'permission-prompt-tool', 'claudePermissionMode', 'codexSandbox', 'normalizeAccess', 'claudeToolRules',
  // What is served before the sign-in check.
  'handleMcpRequest', 'PUSH_PUBLIC_PATHS', 'pushHttpHandler', 'alertIngestHandler', 'isAlertIngestPath', 'ALERT_INGEST_TOKEN',
  'fleetReportHandler', 'FLEET_REPORT_PATH', 'chatUploads\\.verify', 'authorized\\(', 'refusedAsCrossSite', 'oauth/callback', 'completeAuth',
  // How an upload is served (a chart page only under its sandbox), and what a run's /agent-mcp lists.
  'servedHeaders', 'storeVisual', 'showVisual', 'agentMcpTools',
].join('|'))

// The same rule names anywhere else: not refused (a new feature may well call
// them), but flagged on the card and in the PR body.
const SENSITIVE_LINE = /approvedVia|doResolveInboxItem|actionInboxItem|limitReach|claudeSecretDenyRules|AGENT_SECRET_PATHS|guardRequest|ownerAuth|BRIDGE_SECRET|permissionResult|allowedTools|chat\/approvals/

// Docs that tell every future agent what the rules are. A feature has to update
// them (AGENTS.md says so), so they are flagged rather than refused.
const FLAGGED_FILES = new Set(['agents.md', 'mobile/agents.md'])

// Token shapes worth refusing wherever they appear in a changed file: the
// specific shapes chat/redact.mjs knows, plus Google's OAuth tokens. Not its
// generic rules (`key=…`, any long base64): JSX and package-lock.json are full
// of those.
const TOKEN_SHAPES = [
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/, 'an API key'],
  [/\bxox[a-z]-[A-Za-z0-9-]{8,}|\bxapp-[A-Za-z0-9-]{8,}/i, 'a Slack token'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, 'an AWS key'],
  [/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/, 'a private key'],
  [/\bAIza[A-Za-z0-9_-]{20,}/, 'a Google API key'],
  [/\bya29\.[A-Za-z0-9._-]{20,}/, 'a Google access token'],
  [/(?<![A-Za-z0-9_-])1\/\/0[A-Za-z0-9_-]{20,}/, 'a Google refresh token'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/, 'a signed token (JWT)'],
]


/** Why a path may not be in a change, or null. `denied` and `protected` are both refused. */
export function classifyPath(path) {
  const shown = String(path || '').replace(/\\/g, '/').replace(/^\.\/+/, '')
  const p = foldPath(path)
  for (const rule of DENIED) if (rule.test(p)) return { path: shown, kind: 'denied', why: rule.why }
  for (const rule of PROTECTED) if (rule.test(p)) return { path: shown, kind: 'protected', why: rule.why || PROTECTED_FILES[p] }
  return null
}

/** Every refused path in a change. */
export function refusedPaths(paths) {
  return paths.map(classifyPath).filter(Boolean)
}

/**
 * Entries from `git diff-tree -r --raw -z` that are not plain files: a symlink
 * (mode 120000) can point a public file at data/auth.json, and a gitlink
 * (160000) at anything. Deleting one is fine.
 */
export function oddEntries(entries) {
  return entries.filter((e) => e.status !== 'D' && (e.mode === '120000' || e.mode === '160000'))
    .map((e) => ({ path: e.path, kind: 'denied', why: e.mode === '120000' ? 'a symlink' : 'a submodule' }))
}

/** `git diff-tree -r --raw -z --no-renames` output → [{ mode, status, path, oldSha, newSha }]. */
export function parseRawDiff(out) {
  const parts = String(out || '').split('\0')
  const entries = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const head = parts[i].replace(/^\n/, '')
    if (!head.startsWith(':')) break
    const [, newMode, oldSha, newSha, status] = head.slice(1).split(' ')
    entries.push({ mode: newMode, status: status?.[0] || 'M', path: parts[i + 1], oldSha, newSha })
  }
  return entries
}

/**
 * Changed paths that collide case-insensitively with another path in the
 * tree: on the deploy host one silently replaces the other.
 */
export function caseCollisions(changed, allPaths) {
  const byFold = new Map()
  for (const p of allPaths) {
    const f = foldPath(p)
    if (!byFold.has(f)) byFold.set(f, new Set())
    byFold.get(f).add(p)
  }
  return changed.filter((p) => (byFold.get(foldPath(p))?.size || 0) > 1)
    .map((p) => ({ path: p, kind: 'denied', why: `a second file whose name differs only in case (${[...byFold.get(foldPath(p))].join(', ')})` }))
}

/** Changed lines (from a `-U0` diff of bridge.mjs) that touch auth, approvals or this flow. */
export function guardedLines(diff) {
  return changedLines(diff).filter((l) => GUARDED_LINE.test(l.text)).map((l) => l.text.slice(0, 200))
}

/**
 * `+`/`-` lines of a unified diff, each with the file it is in. `---`/`+++`
 * are file headers only between a `diff --git` line and that file's first
 * `@@`: inside a hunk, a changed line `++ x` prints as `+++ x` and is content.
 */
export function changedLines(diff) {
  const out = []
  let file = ''
  let header = true
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('diff --git ')) { header = true; file = ''; continue }
    if (header) {
      if (line.startsWith('+++ b/')) file = line.slice(6)
      else if (line.startsWith('--- a/') && !file) file = line.slice(6)
      else if (line.startsWith('@@')) header = false
      continue
    }
    if (line.startsWith('@@')) continue
    if (line[0] === '+' || line[0] === '-') out.push({ file, sign: line[0], text: line })
  }
  return out
}

/** Changed `.gitignore` lines that mention node_modules: the linked node_modules must stay ignored. */
export function gitignoreLines(diff) {
  return changedLines(diff).filter((l) => /(^|\/)\.gitignore$/i.test(l.file) && /node_modules/.test(l.text)).map((l) => `${l.file}: ${l.text.slice(0, 120)}`)
}

// A credential file's field holds a secret when its name says so; a URL, a
// scope, an email or an expiry date beside it does not.
const SECRET_FIELD = /token|secret|passw|pwd|key|credential|cookie|hash|salt|signature/i
const MIN_SECRET = 12
const MAX_SECRET_FILE = 8 * 1024 * 1024

/** [value, field] for each string under a secret-named field, anywhere in a parsed JSON value. */
function secretFields(value, out = [], field = '') {
  if (typeof value === 'string') { if (SECRET_FIELD.test(field) && value.length >= MIN_SECRET) out.push([value, field]) }
  else if (Array.isArray(value)) for (const v of value) secretFields(v, out, field)
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) secretFields(v, out, k)
  return out
}

async function readJson(file) {
  try {
    const st = await lstat(file)
    if (!st.isFile() || st.size > MAX_SECRET_FILE) return null
    return JSON.parse(await readFile(file, 'utf8'))
  } catch { return null }
}

// An env variable or header whose name says it holds a secret.
const SECRET_NAME = /SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|AUTH|COOKIE/i

/**
 * The secrets Totem itself holds, to look for in a change, each with where it
 * came from (a refusal names the source, never the value):
 *   - the secret-named fields of its credential files (`files`, and every
 *     `*-tokens.json` in `dataDir`);
 *   - the MCP manifest's env values and headers, where the connections catalog
 *     marks the field secret (`catalog.secret`), or the catalog does not know it
 *     (`catalog.notSecret`) and its name looks like a secret;
 *   - the environment's secret-named variables (BRIDGE_SECRET among them).
 * Only credential files: data/ as a whole holds chat transcripts, whose tool
 * inputs are full of the agent's own code.
 */
export async function collectSecrets({ files = [], dataDir = '', env = process.env, catalog = {} } = {}) {
  const found = new Map()
  const add = (v, source) => { if (typeof v === 'string' && v.length >= MIN_SECRET && !found.has(v)) found.set(v, source) }
  const all = [...files]
  if (dataDir) {
    try { for (const name of await readdir(dataDir)) if (/-tokens\.json$/.test(name)) all.push(join(dataDir, name)) } catch {}
  }
  for (const file of new Set(all)) {
    const json = await readJson(file)
    if (json) for (const [v, field] of secretFields(json)) add(v, `${basename(file)} ${field}`)
  }
  const secretKeys = new Set(catalog.secret || [])
  const plainKeys = new Set(catalog.notSecret || [])
  const isSecretKey = (k) => secretKeys.has(k) || (!plainKeys.has(k) && SECRET_NAME.test(k))
  const manifest = dataDir ? await readJson(join(dataDir, 'mcp-manifest.json')) : null
  for (const server of Object.values(manifest?.servers || {})) {
    for (const [k, v] of Object.entries(server?.env || {})) if (isSecretKey(k)) add(v, `mcp-manifest.json env ${k}`)
    for (const [k, v] of Object.entries(server?.headers || {})) if (isSecretKey(k)) add(v, `mcp-manifest.json header ${k}`)
  }
  for (const [name, value] of Object.entries(env)) {
    if (/SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE|CREDENTIAL/i.test(name)) add(value, `the environment's ${name}`)
  }
  return [...found].map(([value, source]) => ({ value, source }))
}

const GLOBAL_SHAPES = TOKEN_SHAPES.map(([re, kind]) => [new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), kind])

/**
 * Why changed files leak a secret: each file's whole content at the commit
 * being pushed, searched for every known secret (a plain substring) and every
 * token shape. A hit that the file already had at the base is not this
 * change's (a test fixture's fake token). Names the file and the kind, never
 * the value.
 *
 * A tripwire for accidents, not a boundary: a secret split, reversed, encoded
 * or shorter than MIN_SECRET passes.
 */
export function scanFiles(files, secrets = []) {
  const known = secrets.map((s) => (typeof s === 'string' ? { value: s, source: '' } : s))
  const hits = []
  for (const { path, content, base = '' } of files) {
    const hit = known.find((s) => content.includes(s.value) && !base.includes(s.value))
    if (hit) hits.push(`${path}: one of Totem's own secrets${hit.source ? ` (matches a value from ${hit.source})` : ''}`)
    for (const [re, kind] of GLOBAL_SHAPES) {
      re.lastIndex = 0
      for (const m of content.matchAll(re)) {
        if (!base.includes(m[0])) { hits.push(`${path}: ${kind}`); break }
      }
    }
  }
  return [...new Set(hits)]
}

/** Warnings for lines outside bridge.mjs that name the rules agents are held to. */
export function sensitiveLines(diff) {
  const files = new Set()
  for (const l of changedLines(diff)) if (l.sign === '+' && foldPath(l.file) !== 'bridge.mjs' && SENSITIVE_LINE.test(l.text)) files.add(l.file)
  return [...files]
}

/** Package files whose `scripts` differ between two versions (each the file's text, or null). */
export function scriptsChanged(before, after) {
  const scripts = (text) => { try { return JSON.stringify(JSON.parse(text)?.scripts ?? null) } catch { return 'unparsable' } }
  if (after == null) return false
  return scripts(before ?? '{}') !== scripts(after)
}

/** True when `child` is `parent` or inside it. Both absolute. */
export function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Where a change's worktree goes, or why it can't. `live` is the checkout Totem
 * runs from: the worktree may not be inside it (the build and tests would write
 * into the checkout that deploys, which then refuses every merge as dirty) or
 * around it. `others` (AGENT_CWD, the bridge's cwd) may be neither the worktree
 * nor inside the worktree folder; an AGENT_CWD of the home folder is fine.
 */
export function planWorktree({ root, live, others = [], slug, id }) {
  if (!root || !isAbsolute(root)) throw new Error('The change worktree folder must be an absolute path (CHANGE_WORKTREES_DIR).')
  const path = join(root, `${slug}-${id}`)
  const refuse = (dir) => new Error(`Refusing: the change worktree (${path}) would be inside or around ${dir}, where Totem or its agents run, and would leave the live checkout dirty so no deploy could run. Set CHANGE_WORKTREES_DIR to a folder outside it.`)
  for (const dir of live.filter(Boolean)) if (isInside(path, dir) || isInside(dir, root)) throw refuse(dir)
  for (const dir of others.filter(Boolean)) if (resolve(dir) === resolve(path) || isInside(dir, root)) throw refuse(dir)
  return { path, branch: `${BRANCH_PREFIX}${slug}-${id}` }
}

/** The real path of `p` even when it does not exist yet: its deepest existing ancestor, resolved, plus the rest. */
export async function realpathAhead(p) {
  let dir = resolve(p)
  const rest = []
  for (;;) {
    try { return join(await realpath(dir), ...rest.reverse()) } catch {}
    const up = dirname(dir)
    if (up === dir) return resolve(p)
    rest.push(basename(dir))
    dir = up
  }
}

/**
 * Whether chats get the change tools: only when the owner sets
 * CHANGE_FLOW_ENABLED=true and Totem runs from a git checkout. Off on a fresh
 * install (AGENTS.md §4): this is a feature that pushes code.
 */
export function changeFlowEnabled(env = process.env, { gitCheckout = false } = {}) {
  return String(env.CHANGE_FLOW_ENABLED ?? '').trim().toLowerCase() === 'true' && gitCheckout === true
}

/** Where change worktrees go: CHANGE_WORKTREES_DIR, or ~/.totem-changes. Never inside the checkout. */
export function changeWorktreeRoot(env = process.env, home = homedir()) {
  return resolve(env.CHANGE_WORKTREES_DIR || join(home, '.totem-changes'))
}

/** A short branch-safe name. */
export function changeSlug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'change'
}

/**
 * Claude Code deny rules for every run: no file-tool writes to a change
 * worktree's data, env files, secrets or `.git` file, nor to the live repo's
 * `.git/` that the worktrees share. Bash is not covered; `finish` checks the
 * staged tree for every backend.
 */
export function changeDenyRules({ liveRoot, worktreeRoot, recordsFile }) {
  const abs = (p) => `/${String(p).replace(/\/+$/, '')}`
  const targets = [
    liveRoot && `${abs(liveRoot)}/.git/**`,
    recordsFile && abs(recordsFile),
    ...(worktreeRoot ? ['data/**', '.env', '.env.*', 'secrets/**', '.git'].map((rel) => `${abs(worktreeRoot)}/*/${rel}`) : []),
  ].filter(Boolean)
  return targets.flatMap((t) => ['Edit', 'Write'].map((tool) => `${tool}(${t})`))
}

/** One word for a PR's checks from `gh pr checks --json name,state,bucket`, with counts. */
export function summarizeChecks(list) {
  const items = Array.isArray(list) ? list : []
  const count = (b) => items.filter((c) => c?.bucket === b).length
  const passed = count('pass') + count('skipping')
  const failed = count('fail') + count('cancel')
  const pending = count('pending')
  const state = !items.length ? 'none' : failed ? 'failure' : pending ? 'pending' : 'success'
  return { state, passed, failed, pending }
}

/** Warnings for the card and the PR body; they never stop the PR. */
export function changeWarnings(paths, { sensitive = [], retried = false } = {}) {
  const out = []
  const web = paths.filter((p) => p.startsWith('web/src/') && !/\.test\.tsx?$/.test(p))
  if (web.length && !paths.some((p) => p.startsWith('mobile/'))) {
    out.push('The web dashboard changed but mobile/ did not. The iPhone app mirrors the web (mobile/AGENTS.md); check whether it needs the same change.')
  }
  const docs = paths.filter((p) => FLAGGED_FILES.has(foldPath(p)))
  if (docs.length) out.push(`${docs.join(' and ')} changed: these are the rules every agent reads. Review that diff line by line.`)
  if (sensitive.length) out.push(`New lines name the rules agents are held to (approvals, sending, reach, secrets) in ${sensitive.slice(0, 5).join(', ')}. Review them closely.`)
  if (retried) out.push('npm test failed once and passed on a retry; a flaky test, or one this change made flaky.')
  return out
}

/** Hash every path `git status` lists: what the live checkout looks like, so a further edit to an already-dirty file shows. */
export async function snapshotPaths(root, paths) {
  const out = {}
  for (const p of paths) {
    try { out[p] = createHash('sha1').update(await readFile(join(root, p))).digest('hex') } catch { out[p] = 'gone' }
  }
  return out
}

/** Paths in `now` that are new or whose content changed since `before` (both from snapshotPaths). */
export function newlyDirty(before, now) {
  const was = before && typeof before === 'object' && !Array.isArray(before) ? before : {}
  return Object.keys(now).filter((p) => was[p] !== now[p])
}

/** The PR description: the agent's summary, then what the flow itself vouches for. */
export function prBody({ summary, files, base, warnings = [] }) {
  return [
    String(summary || '').trim() || '(no summary)',
    '',
    '---',
    'Opened from a Totem chat by the change-totem flow. **Merging deploys it.**',
    '',
    `- Based on \`origin/main\` at \`${String(base).slice(0, 12)}\`; ${files} file${files === 1 ? '' : 's'} changed.`,
    '- Checked before pushing: `npm test` and `cd web && npm run build`.',
    '- The flow refuses changes to auth, approval and CI workflow code, symlinks, package scripts and its own guardrails, so none are here.',
    ...warnings.map((w) => `- ⚠️ ${w}`),
  ].join('\n')
}

/** The chat's "PR ready" card. Mirrored by normalizePart in chat/store.mjs and ChangePart in web/src/chat/types.ts. */
export function prCard({ id, pr, title, branch, head, files, checks, warnings = [], now = Date.now() }) {
  return {
    type: 'change-pr',
    id,
    url: pr.url,
    number: pr.number,
    title,
    branch,
    head,
    files,
    checks: { state: checks.state, passed: checks.passed, failed: checks.failed, pending: checks.pending },
    warnings,
    createdAt: now,
  }
}

const sizeOf = (n) => (n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.round(n / 1024)} KB`)
const tail = (text, n = 4000) => { const s = String(text || ''); return s.length > n ? `…${s.slice(-n)}` : s }

// The checks run the change's own code, so they get as little of the owner as
// possible: none of the bridge's variables (BRIDGE_SECRET, tokens, data paths),
// a throwaway HOME (no ~/.config/gh login, no ~/.npmrc, no ~/.ssh) and no
// global or system git config (no credential helper).
const SAFE_ENV = ['PATH', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL']
export function checkEnv(home, env = process.env) {
  const out = { CI: '1', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', npm_config_cache: join(home, '.npm') }
  for (const k of SAFE_ENV) if (env[k]) out[k] = env[k]
  return out
}

// git without hooks (a hook planted in the shared .git/ must not run as the
// bridge) and without optional locks (a status on the live checkout must not
// take index.lock while a deploy fast-forwards it).
const GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'color.ui=false', '-c', 'core.attributesFile=/dev/null', '--no-optional-locks']
// Every diff the checks read: plain text, whatever the owner's or the repo's
// git config says (colour codes, an external diff tool, textconv drivers or
// other prefixes would each hide lines from the checks).
const DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--no-renames', '--text']

const stopped = () => Object.assign(new Error('Stopped: the chat run ended, so nothing more was done.'), { stopped: true })

/**
 * A runner over child_process for the bridge. Never rejects except when the
 * command can't start. Each command gets a process group of its own, and a
 * timeout or `signal` kills the whole tree: npm starts node, which starts the
 * tests, and killing only the first leaves the rest holding the pipes.
 *
 * Output is kept in full up to `maxBytes`; past it the command is killed and
 * the result says `truncated`, so nothing reads a list or a diff with its end
 * missing. `tail` keeps only the last 200 KB instead (a test log, read only to
 * show the owner what failed).
 */
export function execRunner({ log = () => {}, spawnFn = spawn } = {}) {
  return (cmd, args, { cwd, timeout = 120_000, input, env, signal, maxBytes = MAX_GIT_OUTPUT, tail: tailOnly = false } = {}) => new Promise((resolveRun, reject) => {
    if (signal?.aborted) return resolveRun({ code: 1, stdout: '', stderr: 'stopped', stopped: true })
    const child = spawnFn(cmd, args, { ...AGENT_SPAWN, cwd, env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    trackAgent(child)
    const TAIL = 200_000
    const out = { chunks: [], bytes: 0 }
    const err = { chunks: [], bytes: 0 }
    let ended = ''
    let truncated = false
    const keep = (buf, d, limit) => {
      buf.chunks.push(d)
      buf.bytes += d.length
      if (tailOnly) {
        while (buf.bytes - buf.chunks[0].length > TAIL) buf.bytes -= buf.chunks.shift().length
      } else if (buf.bytes > limit) {
        truncated = true
        end('too much output')
      }
    }
    const end = (why) => { if (ended) return; ended = why; killTree(child) }
    const timer = setTimeout(() => { err.chunks.push(Buffer.from(`\n(timed out after ${Math.round(timeout / 1000)}s)`)); end('timeout') }, timeout)
    const onAbort = () => end('stopped')
    signal?.addEventListener('abort', onAbort, { once: true })
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
    child.stdout.on('data', (d) => keep(out, d, maxBytes))
    child.stderr.on('data', (d) => keep(err, d, 1024 * 1024))
    // A command that exits before reading its input (git refusing early) makes
    // the write fail with EPIPE; unheard, that is an uncaught exception.
    child.stdin.on('error', () => {})
    child.on('error', (e) => { done(); reject(e) })
    child.on('close', (code) => {
      done()
      if (code !== 0) log(`change: ${cmd} ${args.slice(0, 3).join(' ')} exited ${code}${ended ? ` (${ended})` : ''}`)
      const text = (b) => Buffer.concat(b.chunks).toString('utf8')
      resolveRun({ code: ended ? 1 : (code ?? 1), stdout: text(out), stderr: text(err), ...(ended === 'stopped' ? { stopped: true } : {}), ...(truncated ? { truncated: true } : {}) })
    })
    child.stdin.end(input ?? '')
  })
}

function createRecordFile(file) {
  let queue = Promise.resolve()
  const read = async () => { try { return JSON.parse(await readFile(file, 'utf8')) } catch { return {} } }
  const update = (fn) => {
    const next = queue.then(async () => {
      const all = await read()
      fn(all)
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 })
      await rename(tmp, file)
      return all
    })
    queue = next.catch(() => {})
    return next
  }
  return { read, update }
}

/**
 * The flow. `liveRoot` is the checkout the bridge runs from, `agentCwd` where
 * agents start, `cwd` the bridge's own cwd; the worktree stays out of all three.
 * `skillText()` returns the change-totem skill (the owner's editable copy) to
 * hand the agent as its steps; `secrets()` the bridge's own secret values, which
 * no diff may contain.
 */
export function createChangeFlow({
  liveRoot, agentCwd, cwd = process.cwd(), worktreeRoot, recordsFile, base = 'main',
  run, skillText = async () => '', secrets = async () => [], log = () => {}, randomId = () => randomBytes(3).toString('hex'),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), checkTimeoutMs = 15 * 60_000, now = () => Date.now(),
  maxFiles = MAX_FILES, maxDiffBytes = MAX_DIFF_BYTES, maxOutputBytes = MAX_GIT_OUTPUT,
}) {
  const records = createRecordFile(recordsFile)
  const busy = new Set()
  // The live checkout's state at each chat's change_start, for the life of the
  // process. The copy in the records file is only a fallback after a restart:
  // an agent with a shell can edit that file.
  const liveAtStart = new Map()
  const locks = new Map()
  // One start per chat at a time: two calls racing would make two worktrees.
  const withLock = (key, fn) => {
    const prev = locks.get(key) || Promise.resolve()
    const next = prev.then(fn, fn)
    const tailP = next.catch(() => {})
    locks.set(key, tailP)
    tailP.then(() => { if (locks.get(key) === tailP) locks.delete(key) })
    return next
  }

  // Every git read in full or not at all: a cut-off list or diff passes
  // whatever was cut.
  // Every filter named in git config, switched off on every call (an empty
  // command disables it): a clean filter runs during `git status` and `git add`.
  let noFilters = []
  const git = async (dir, args, opts = {}) => {
    const r = await run('git', [...GIT, ...noFilters, '-C', dir, ...args], { maxBytes: maxOutputBytes, ...opts })
    if (r.truncated) throw new Error(`Refusing: git printed more than ${sizeOf(maxOutputBytes)} for \`${args.slice(0, 2).join(' ')}\`, so the change can't be checked in full. A change this large is for a normal dev session.`)
    return r
  }
  const must = async (p, what) => {
    const r = await p
    if (r.stopped) throw stopped()
    if (r.code !== 0) throw new Error(`${what} failed: ${tail(r.stderr || r.stdout, 1200).trim()}`)
    return r.stdout.trim()
  }
  const exists = (p) => lstat(p).then(() => true, () => false)
  const checkpoint = (signal) => { if (signal?.aborted) throw stopped() }

  // The live checkout's dirty files, by content.
  async function liveState(top) {
    const out = (await git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])).stdout
    const paths = out.split('\0').filter(Boolean).map((e) => e.slice(3))
    return snapshotPaths(top, paths)
  }

  async function topLevel() {
    const r = await git(liveRoot, ['rev-parse', '--show-toplevel'])
    if (r.code !== 0 || !r.stdout.trim()) throw new Error('Totem is not running from a git checkout, so it cannot change its own code from a chat.')
    return r.stdout.trim()
  }

  /**
   * Before any git command that can run a filter: refuse attributes from
   * .git/info/attributes (the agent can write there; the in-tree .gitattributes
   * is main's), and switch off every filter git config defines.
   */
  async function disarmFilters() {
    const info = (await git(liveRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'info/attributes'])).stdout.trim()
    if (info && await exists(info)) {
      throw new Error(`Refusing: ${info} exists, and the attributes in it (filters, diff drivers) would run or hide things while the change is checked. Ask the owner to remove it.`)
    }
    const names = (await git(liveRoot, ['config', '--name-only', '--get-regexp', '^filter\\.'])).stdout.split('\n')
      .map((k) => k.trim().match(/^filter\.(.+)\.[^.]+$/)?.[1]).filter(Boolean)
    noFilters = [...new Set(names)].flatMap((n) => ['clean', 'smudge', 'process'].flatMap((k) => ['-c', `filter.${n}.${k}=`]))
  }

  const fetchBase = (top, signal) => must(git(top, ['fetch', '--no-write-fetch-head', 'origin', `+refs/heads/${base}:${BASE_REF}`], { signal }), `Fetching origin/${base}`)

  /** { state: OPEN | MERGED | CLOSED, head } for the record's PR; null when gh can't say. */
  async function prInfo(rec) {
    if (!rec?.pr?.number) return null
    const r = await run('gh', ['pr', 'view', String(rec.pr.number), '--json', 'state,headRefName'], { cwd: liveRoot })
    if (r.code !== 0) return null
    try {
      const j = JSON.parse(r.stdout)
      return typeof j?.state === 'string' ? { state: j.state, head: j.headRefName || '' } : null
    } catch { return null }
  }
  const finishedPr = (info) => info?.state === 'MERGED' || info?.state === 'CLOSED'

  /**
   * The worktree a record names, checked against the filesystem every time:
   * a real folder directly under the worktrees root (not a symlink to the
   * live checkout), the top of its own worktree, sharing the live repo.
   */
  async function assertWorktree(rec) {
    const root = await realpathAhead(worktreeRoot)
    const bad = (why) => Object.assign(new Error(`Refusing: this chat's change record no longer matches its worktree (${why}). Call ${CHANGE_START} again: it starts a fresh branch and PR.`), { invalid: true })
    let real
    try { real = await realpath(rec.path) } catch { throw bad('the worktree folder is gone') }
    if (real !== rec.path || dirname(real) !== root) throw bad(`${rec.path} is not a folder directly under ${root}`)
    const top = (await git(real, ['rev-parse', '--show-toplevel'])).stdout.trim()
    if (top !== real) throw bad(`${real} is not the top of a worktree`)
    const common = async (dir) => realpathAhead((await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim())
    if (await common(real) !== await common(liveRoot)) throw bad('the worktree does not belong to the live repository')
    return real
  }

  /**
   * Everything finish reads from the records file, checked against git and
   * GitHub, so an edit to that file can't steer it: the branch name, the live
   * checkout, the worktree, the base (an ancestor of a freshly fetched
   * origin/main), what was last pushed (the remote branch's tip) and the PR
   * (open, on this branch).
   */
  async function verifyRecord(threadId, rec, signal) {
    const bad = (why) => Object.assign(new Error(`Refusing: this chat's change record does not check out (${why}). Call ${CHANGE_START} again: it starts a fresh branch and PR.`), { invalid: true })
    if (rec.threadId !== threadId) throw bad('it belongs to another chat')
    if (!/^totem-change\/[a-z0-9-]{1,60}$/.test(String(rec.branch || ''))) throw bad(`the branch ${rec.branch} is not a ${BRANCH_PREFIX}* branch`)
    const top = await topLevel()
    if (rec.liveRoot !== top) throw bad(`it names ${rec.liveRoot}, not the live checkout ${top}`)
    await assertWorktree(rec)
    if (!/^[0-9a-f]{40}$/.test(String(rec.base || ''))) throw bad('its base is not a commit')
    await fetchBase(top, signal)
    if ((await git(top, ['merge-base', '--is-ancestor', rec.base, BASE_REF])).code !== 0) throw bad(`its base ${String(rec.base).slice(0, 12)} is not on origin/${base}`)
    const remote = await git(top, ['ls-remote', 'origin', `refs/heads/${rec.branch}`], { signal })
    // Not a stale record: a network failure must never move the chat off a healthy PR.
    if (remote.code !== 0) throw new Error(`Can't reach GitHub to check ${rec.branch}, so nothing was pushed. Try again in a moment. (${tail(remote.stderr, 200).trim()})`)
    const tip = remote.stdout.trim().split(/\s+/)[0] || ''
    if ((rec.pushed || '') !== tip) throw bad(tip ? `${rec.branch} on GitHub is at ${tip.slice(0, 12)}, not the ${rec.pushed ? `recorded ${String(rec.pushed).slice(0, 12)}` : 'nothing recorded'}` : `${rec.branch} is not on GitHub, but a push is recorded`)
    if (rec.pr) {
      if (!/^https:\/\/\S+\/pull\/\d+$/.test(String(rec.pr.url || '')) || Number(rec.pr.url.split('/').pop()) !== rec.pr.number) throw bad('its PR link is malformed')
      const info = await prInfo(rec)
      if (!info) throw new Error(`Can't reach GitHub to check PR #${rec.pr.number}, so nothing was pushed: an update can't go on a PR that may already be merged. Try again in a moment.`)
      if (info.head !== rec.branch) throw bad(`PR #${rec.pr.number} is for ${info.head}, not ${rec.branch}`)
      return info
    }
    return null
  }

  // Remove a worktree and its local branch, only ever under worktreeRoot and
  // only a totem-change/* branch, through the configured live checkout.
  async function retire(rec) {
    const root = await realpathAhead(worktreeRoot)
    const top = await topLevel()
    if (rec.path && isInside(rec.path, root) && rec.path !== root) {
      await git(top, ['worktree', 'remove', '--force', rec.path])
    }
    if (/^totem-change\/[a-z0-9-]{1,60}$/.test(String(rec.branch || ''))) await git(top, ['branch', '-D', rec.branch])
    await records.update((a) => { for (const [k, v] of Object.entries(a)) if (v?.path === rec.path) delete a[k] })
    if (!rec.replaced) liveAtStart.delete(rec.threadId)
    log(`change: retired ${rec.branch}`)
  }

  function start(threadId, input = {}, { signal } = {}) {
    return withLock(`start:${threadId}`, () => startNow(threadId, input, signal))
  }

  async function startNow(threadId, { name = '' } = {}, signal) {
    let replaced = null
    await disarmFilters()
    const all = await records.read()
    const known = all[threadId]
    if (known && await exists(known.path)) {
      // A follow-up to a merged or closed PR starts fresh off the new main; one
      // whose PR can't be looked up waits rather than guess.
      const info = await prInfo(known)
      if (known.pr && !info) throw new Error(`Can't reach GitHub to check PR #${known.pr.number}, so it isn't clear whether this change can go on it. Try again in a moment.`)
      if (finishedPr(info)) await retire(known)
      else {
        // A record that no longer checks out (GitHub's "Update branch" moved
        // the remote, or the bridge died between a push and saving it) can't be
        // continued, so the chat moves to a fresh branch and PR. The old
        // worktree stays for copying from, filed for cleanup().
        try {
          await verifyRecord(threadId, known, signal)
          return { ...known, resumed: true, steps: await skillText() }
        } catch (e) {
          if (!e.invalid) throw e
          await records.update((a) => {
            if (a[threadId]?.path !== known.path) return
            a[`${threadId}#replaced-${now()}`] = { ...known, replaced: true, replacedAt: now() }
            delete a[threadId]
          })
          liveAtStart.delete(threadId)
          replaced = { path: known.path, why: e.message.replace(/^Refusing: /, '') }
          log(`change: ${known.branch} replaced: ${e.message}`)
        }
      }
    }
    const top = await topLevel()
    await must(git(top, ['remote', 'get-url', 'origin']), 'Finding the origin remote')
    // Check where the worktree would go before creating anything there.
    const realRoot = await realpathAhead(worktreeRoot)
    const real = (dirs) => Promise.all(dirs.filter(Boolean).map((d) => realpathAhead(d)))
    const plan = planWorktree({ root: realRoot, live: await real([top, liveRoot]), others: await real([agentCwd, cwd]), slug: changeSlug(name), id: randomId() })
    await mkdir(realRoot, { recursive: true })
    const liveBefore = await liveState(top)
    checkpoint(signal)
    await fetchBase(top, signal)
    await must(git(top, ['worktree', 'add', '-b', plan.branch, plan.path, BASE_REF]), 'Creating the worktree')
    try {
      const head = await must(git(plan.path, ['rev-parse', 'HEAD']), 'Reading the base commit')
      // Dependencies come from the live checkout, read-only by convention: the
      // symlink must be ignored (a trailing-slash ignore once committed it).
      for (const rel of ['node_modules', 'web/node_modules']) {
        const from = join(top, rel)
        if (!await exists(from)) continue
        await symlink(from, join(plan.path, rel)).catch((e) => log(`change: ${rel} link failed: ${e.message}`))
        if ((await git(plan.path, ['check-ignore', '-q', rel])).code !== 0) {
          throw new Error(`Refusing: ${rel} is not ignored in the worktree, so its symlink would be committed. Ignore it as \`node_modules\` (no trailing slash).`)
        }
      }
      const record = { threadId, path: plan.path, branch: plan.branch, base: head, liveRoot: top, liveBefore, startedAt: now(), cards: 0 }
      await records.update((a) => { a[threadId] = record })
      liveAtStart.set(threadId, liveBefore)
      log(`change: started ${plan.branch} at ${plan.path}`)
      return { ...record, resumed: false, ...(replaced ? { replaced } : {}), steps: await skillText() }
    } catch (e) {
      // Leave nothing half made behind.
      await git(top, ['worktree', 'remove', '--force', plan.path])
      await git(top, ['branch', '-D', plan.branch])
      throw e
    }
  }

  /** Why the tree may not be pushed: every refused path and line. Empty when it is fine. */
  async function refusals(rec, tree, paths, entries, diff) {
    const all = (await must(git(rec.path, ['ls-tree', '-r', '-z', '--name-only', tree]), 'Listing the tree')).split('\0').filter(Boolean)
    const refused = [...refusedPaths(paths), ...oddEntries(entries), ...caseCollisions(paths, all)]
      .map((r) => `- ${r.path} (${r.why})`)
    const folded = new Map(paths.map((p) => [foldPath(p), p]))
    if (folded.has('bridge.mjs')) {
      const d = (await git(rec.path, ['diff', ...DIFF, '-U0', rec.base, tree, '--', folded.get('bridge.mjs')])).stdout
      for (const l of guardedLines(d)) refused.push(`- bridge.mjs line touching auth, approvals, agent reach or this flow: ${l}`)
    }
    for (const f of PACKAGE_FILES) {
      const p = folded.get(f)
      if (!p) continue
      const before = await git(rec.path, ['show', '--no-textconv', `${rec.base}:${f}`])
      const after = await git(rec.path, ['show', '--no-textconv', `${tree}:${p}`])
      if (scriptsChanged(before.code === 0 ? before.stdout : null, after.code === 0 ? after.stdout : null)) refused.push(`- ${p}: its "scripts" changed (they run on install, in CI and in the checks)`)
    }
    for (const l of gitignoreLines(diff)) refused.push(`- ${l} (the linked node_modules must stay ignored as \`node_modules\`)`)
    // Whole files at the commit being pushed, not diff lines: a line's leading
    // `+` or a `++ ` that prints like a header can't hide anything here.
    const NONE = /^0+$/
    const blob = async (sha) => (sha && !NONE.test(sha) ? (await must(git(rec.path, ['cat-file', 'blob', sha]), 'Reading a changed file')) : '')
    const files = []
    for (const e of entries) {
      if (e.status === 'D' || e.mode === '120000' || e.mode === '160000') continue
      files.push({ path: e.path, content: await blob(e.newSha), base: e.status === 'A' ? '' : await blob(e.oldSha) })
    }
    for (const h of scanFiles(files, await secrets())) refused.push(`- ${h}`)
    return refused
  }

  async function finish(threadId, { title = '', summary = '', commitMessage = '' } = {}, { signal } = {}) {
    const all = await records.read()
    const rec = all[threadId]
    if (!rec) throw new Error(`No change is open in this chat. Call ${CHANGE_START} first.`)
    if (!String(title).trim()) throw new Error('A PR title is required.')
    if (busy.has(threadId)) throw new Error(`${CHANGE_FINISH} is already running for this chat.`)
    busy.add(threadId)
    let checkHome = ''
    try {
      if (!await exists(rec.path)) throw new Error(`The worktree ${rec.path} is gone. Call ${CHANGE_START} again.`)
      await disarmFilters()
      const info = await verifyRecord(threadId, rec, signal)
      if (finishedPr(info)) {
        throw new Error(`PR #${rec.pr.number} is already ${info.state.toLowerCase()}, so this change can't go on it. Call ${CHANGE_START} again: it starts a fresh worktree off the new origin/main (copy over anything you still need from ${rec.path}).`)
      }
      // The checkout Totem runs from must end as clean as it started: a deploy
      // refuses a dirty one, so a PR opened over it would never ship.
      const liveBefore = liveAtStart.get(threadId) || rec.liveBefore
      const assertLiveClean = async () => {
        const dirtied = newlyDirty(liveBefore, await liveState(rec.liveRoot))
        if (dirtied.length) {
          throw new Error(`Refusing: the live checkout ${rec.liveRoot} changed during this change (${dirtied.slice(0, 10).join(', ')}), and a dirty live checkout blocks every deploy. If those are your edits, make them in ${rec.path} instead and restore those files in the live checkout; otherwise tell the owner. Then call ${CHANGE_FINISH} again.`)
        }
      }
      await assertLiveClean()

      // The tree to push: everything in the worktree, checked as one diff
      // against the base, so every file the PR carries passes through here.
      await assertWorktree(rec)
      await must(git(rec.path, ['add', '-A']), 'Staging')
      const tree = await must(git(rec.path, ['write-tree']), 'Writing the tree')
      const entries = parseRawDiff((await must(git(rec.path, ['diff-tree', '-r', '--raw', '-z', '--no-renames', rec.base, tree]), 'Listing the change')))
      const paths = entries.map((e) => e.path)
      if (!paths.length) throw new Error('Nothing changed in the worktree yet.')
      const tooBig = (what) => new Error(`Refusing: this change is too large for a chat change (${what}). Split it, or tell the owner it needs a normal dev session.`)
      if (paths.length > maxFiles) throw tooBig(`${paths.length} files; the limit is ${maxFiles}`)
      const diffRead = await git(rec.path, ['diff', ...DIFF, '-U0', rec.base, tree], { maxBytes: maxDiffBytes + 1 }).catch((e) => { if (/printed more than/.test(e.message)) throw tooBig(`more than ${sizeOf(maxDiffBytes)} of diff`); throw e })
      if (diffRead.code !== 0) throw new Error(`Reading the change failed: ${tail(diffRead.stderr, 600).trim()}`)
      const diff = diffRead.stdout
      const refused = await refusals(rec, tree, paths, entries, diff)
      if (refused.length) {
        throw new Error(`Refusing to open a PR. These are off limits to a chat change; undo them in the worktree (git restore / git rm) and call ${CHANGE_FINISH} again, or tell the owner they need a normal dev session:\n${refused.join('\n')}`)
      }

      // One fresh commit of that tree on top of what was last pushed (or the
      // base): the agent's own commits, and anything they once held, stay here.
      const parent = rec.pushed || rec.base
      const parentTree = await must(git(rec.path, ['rev-parse', `${parent}^{tree}`]), 'Reading the last push')
      if (parentTree === tree && rec.pr) throw new Error(`Nothing changed since the last update to PR #${rec.pr.number}.`)
      checkpoint(signal)
      const message = String(commitMessage || title).trim()
      const commit = parentTree === tree ? parent : await must(git(rec.path, ['commit-tree', tree, '-p', parent, '-F', '-'], { input: `${message}\n` }), 'Committing')
      await must(git(rec.path, ['update-ref', `refs/heads/${rec.branch}`, commit]), 'Moving the branch')

      // The checks run the change's own code, so afterwards the worktree must be
      // exactly the commit, and the push names that commit, never HEAD.
      checkHome = await mkdtemp(join(tmpdir(), 'totem-change-home-'))
      const env = checkEnv(checkHome)
      let retried = false
      for (const [label, dir, args] of [['npm test', rec.path, ['test']], ['web build', join(rec.path, 'web'), ['run', 'build']]]) {
        checkpoint(signal)
        let r = await run('nice', ['-n', '10', 'npm', ...args], { cwd: dir, env, timeout: checkTimeoutMs, signal, tail: true })
        if (r.stopped) throw stopped()
        if (r.code !== 0 && label === 'npm test') {
          checkpoint(signal)
          r = await run('nice', ['-n', '10', 'npm', ...args], { cwd: dir, env, timeout: checkTimeoutMs, signal, tail: true })
          if (r.stopped) throw stopped()
          retried = r.code === 0
        }
        if (r.code !== 0) {
          throw new Error(`${label} failed, so nothing was pushed. Fix it in the worktree and call ${CHANGE_FINISH} again.\n${tail(`${r.stdout}\n${r.stderr}`)}`)
        }
      }
      const headNow = (await git(rec.path, ['rev-parse', 'HEAD'])).stdout.trim()
      const changed = (await git(rec.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout.split('\0').filter(Boolean)
      if (headNow !== commit || changed.length) {
        throw new Error(`Refusing to push: the tests or the build changed the worktree (${headNow !== commit ? 'HEAD moved' : changed.slice(0, 5).map((e) => e.slice(3)).join(', ')}). Checks must not write tracked files; fix that and call ${CHANGE_FINISH} again.`)
      }
      for (const rel of ['node_modules', 'web/node_modules']) {
        if ((await git(rec.path, ['check-ignore', '-q', rel])).code !== 0) throw new Error(`Refusing to push: ${rel} is no longer ignored. Ignore it as \`node_modules\` (no trailing slash).`)
      }
      await assertLiveClean()
      await assertWorktree(rec)

      checkpoint(signal)
      await must(git(rec.path, ['push', 'origin', `${commit}:refs/heads/${rec.branch}`], { signal }), 'Pushing the branch')
      await records.update((a) => { if (a[threadId]) a[threadId].pushed = commit })
      const warnings = changeWarnings(paths, { sensitive: sensitiveLines(diff), retried })
      let pr = rec.pr
      if (!pr) {
        checkpoint(signal)
        const body = prBody({ summary, files: paths.length, base: rec.base, warnings })
        const created = await run('gh', ['pr', 'create', '--base', base, '--head', rec.branch, '--title', String(title).trim(), '--body-file', '-'], { cwd: rec.path, input: body, signal })
        if (created.stopped) throw stopped()
        let link = `${created.stdout}`.split('\n').map((s) => s.trim()).find((s) => /^https:\/\/\S+\/pull\/\d+$/.test(s))
        if (!link) {
          // Already open (an earlier finish that died before saving it): find it.
          const found = await run('gh', ['pr', 'view', rec.branch, '--json', 'url', '--jq', '.url'], { cwd: rec.path })
          link = found.code === 0 && /^https:\/\/\S+\/pull\/\d+$/.test(found.stdout.trim()) ? found.stdout.trim() : ''
        }
        if (!link) throw new Error(`Opening the PR failed: ${tail(created.stderr || created.stdout, 600).trim()}`)
        pr = { url: link, number: Number(link.split('/').pop()) }
        await records.update((a) => { if (a[threadId]) a[threadId].pr = pr })
      }
      // Checks register a few seconds after the push; wait briefly so the card
      // says "running" rather than "none". The card keeps this snapshot.
      let checks = summarizeChecks([])
      for (let i = 0; i < 4 && !signal?.aborted; i++) {
        const r = await run('gh', ['pr', 'checks', String(pr.number), '--json', 'name,state,bucket'], { cwd: rec.path })
        try { checks = summarizeChecks(JSON.parse(r.stdout || '[]')) } catch {}
        if (checks.state !== 'none') break
        await sleep(5000)
      }
      const n = (rec.cards || 0) + 1
      await records.update((a) => { if (a[threadId]) Object.assign(a[threadId], { cards: n, head: commit }) })
      const card = prCard({ id: `${rec.branch.slice(BRANCH_PREFIX.length)}-${n}`.slice(0, 64), pr, title: String(title).trim(), branch: rec.branch, head: commit, files: paths.length, checks, warnings })
      log(`change: ${rec.branch} → ${pr.url} (${checks.state})`)
      return card
    } finally {
      busy.delete(threadId)
      if (checkHome) await rm(checkHome, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * Drop worktrees whose PR is merged or closed, and ones left without a PR for
   * ABANDONED_MS, with their local branches. A worktree with an open PR stays
   * so a follow-up can update it.
   */
  async function cleanup() {
    const all = await records.read()
    let removed = 0
    for (const rec of Object.values(all)) {
      if (busy.has(rec.threadId)) continue
      const info = await prInfo(rec)
      // A PR whose state can't be read is kept: it may still be open.
      if (rec.pr && !info) continue
      const done = finishedPr(info)
      // A replaced one goes after the same wait, timed from its replacement, even
      // with its PR open: the chat moved on.
      const since = rec.replaced ? rec.replacedAt || now() : rec.startedAt || 0
      const abandoned = (!rec.pr || rec.replaced) && now() - since > ABANDONED_MS
      if (!done && !abandoned && await exists(rec.path)) continue
      await retire(rec).then(() => { removed++ }, (e) => log(`change: cleanup of ${rec.branch} failed: ${e.message}`))
    }
    if (removed) await git(liveRoot, ['worktree', 'prune'])
    return removed
  }

  return { start, finish, cleanup, records: () => records.read() }
}

/** What the agent is told after change_start. */
export function startedForAgent(r) {
  return [
    `${r.resumed ? 'This chat already has a change open' : 'Change started'}: worktree ${r.path}, branch ${r.branch}, based on origin/main at ${String(r.base).slice(0, 12)}.`,
    r.replaced ? `The previous change in this chat could not be continued (${r.replaced.why}), so this is a fresh branch and its own PR. Its worktree is still at ${r.replaced.path}: copy over what you need, and tell the owner the earlier PR can be closed.` : '',
    `Edit files only under ${r.path}. Never edit ${r.liveRoot}: it is the live checkout, and any change there blocks every deploy.`,
    `Do not run npm or pnpm install/add there (node_modules is the live checkout's, linked, so an install would rewrite the live install), do not push, and never merge. When it is done, call ${CHANGE_FINISH}.`,
    r.steps ? `\nThe change-totem skill:\n${r.steps}` : '',
  ].filter(Boolean).join('\n')
}

/** What the agent is told after change_finish. */
export function finishedForAgent(card) {
  const c = card.checks
  const ci = c.state === 'none' ? 'no checks yet' : `${c.state} (${c.passed} passed, ${c.failed} failed, ${c.pending} running)`
  return [
    `PR ready: ${card.url} (#${card.number}), head ${card.head.slice(0, 12)}, CI at push time ${ci}. The owner sees it as a card in this chat.`,
    ...card.warnings.map((w) => `Warning: ${w}`),
    'Tell the owner in one or two lines what the PR does and that merging deploys it. Do not merge it.',
  ].join('\n')
}

/** The rule in every chat prompt that has the change tools. */
export function changeRule(liveRoot) {
  return `CHANGING TOTEM: Totem's own code runs from ${liveRoot}, the live checkout. Never edit, build or install anything there; ` +
    'an edit there blocks every deploy. When the owner asks you to change Totem itself (a new page, a feature, a fix), ' +
    `call ${CHANGE_START} (in the totem-browser server, or browser__${CHANGE_START} through totem-gateway): it makes a fresh worktree and ` +
    `gives you the change-totem steps. ${CHANGE_FINISH} tests it and opens a pull request. You never merge; merging deploys, and that is the owner's call.`
}

export const CHANGE_TOOL_DESCRIPTORS = Object.freeze([
  {
    name: CHANGE_START,
    title: 'Start a change to Totem',
    description:
      "Start a change to Totem's own code (a page, a feature, a fix the owner asked for). Makes a fresh git worktree off " +
      'origin/main, outside the live checkout, and returns its path and the steps. Edit files only under that path. In a ' +
      'chat that already has a change open, returns the same worktree; after its PR is merged or closed, a fresh one.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'A few words naming the change, used for the branch (e.g. "reading list page").' } },
      required: ['name'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: CHANGE_FINISH,
    title: 'Open the PR for a Totem change',
    description:
      `Finish the change from ${CHANGE_START}: checks everything in the worktree, refuses changes to data, secrets, git ` +
      'internals, symlinks, package scripts, auth, approval or CI workflow code, makes one commit of it, runs npm test and the ' +
      'web build, pushes the change branch, opens (or updates) the pull request and shows the owner a PR card in this chat. ' +
      'Takes a few minutes. It never merges.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The PR title, plain and specific.' },
        summary: { type: 'string', description: 'The PR description in Markdown: what changed, why, and how to check it.' },
        commitMessage: { type: 'string', description: 'The commit message; the title when left out.' },
      },
      required: ['title', 'summary'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
])
