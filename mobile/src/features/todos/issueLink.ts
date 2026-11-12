// A task's GitHub issue link (PUT /api/todos/:id/issue-link, docs/task-issue-links.md):
// what the field accepts before it is sent, and the colours of an issue's live state.
// The bridge has the last word (400 INVALID_ISSUE_LINK); this only catches a paste
// that is plainly not an issue, so the owner hears it before a round trip. Pure.

/** GitHub's own: green open, purple closed. */
export const ISSUE_COLOR = { open: '#3fb950', closed: '#a371f7' } as const

const ISSUE = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(issues|pull)\/(\d+)\/?(?:[?#].*)?$/i

/** The link to send for what was typed, or why it will not do. "owner/repo#12" is accepted too. */
export function readIssueLink(text: string): { url: string } | { error: string } {
  const value = text.trim()
  const short = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#(\d+)$/.exec(value)
  if (short) return Number(short[3]) > 0 ? { url: `https://github.com/${short[1]}/${short[2]}/issues/${short[3]}` } : { error: 'An issue number starts at 1.' }
  const match = ISSUE.exec(value)
  if (!match) return { error: 'Paste a GitHub issue link, like https://github.com/owner/repo/issues/12.' }
  if (match[3].toLowerCase() === 'pull') return { error: 'That is a pull request. Link an issue instead.' }
  if (Number(match[4]) < 1) return { error: 'An issue number starts at 1.' }
  return { url: `https://github.com/${match[1]}/${match[2]}/issues/${match[4]}` }
}

type States = Record<string, { state: string; title: string; url: string }>

/** Whether two issue-state answers say the same thing, so an unchanged answer is not stored as a new object. */
export function sameStates(a: States, b: States): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => b[key] !== undefined && a[key].state === b[key].state && a[key].title === b[key].title && a[key].url === b[key].url)
}

/**
 * Read issue states into a store. A failed read with nothing in it keeps the dots
 * already drawn, and an answer equal to what is stored leaves the store alone, so a
 * screen that reads the states again when they change cannot loop on an empty answer.
 */
export function createIssueStatesLoader<S extends States>(
  read: () => Promise<{ states?: S; error?: string }>,
  current: () => S,
  store: (states: S) => void,
) {
  return async () => {
    try {
      const { states, error } = await read()
      const next = (states || {}) as S
      if (error && !Object.keys(next).length) return
      if (sameStates(current(), next)) return
      store(next)
    } catch { /* a link without its state is still a link */ }
  }
}

/** A page's "ask once": true the first time a key is seen, false after, so a page asks for one issue's state at most once. */
export function askOncePerKey() {
  const asked = new Set<string>()
  return (key: string) => {
    if (!key || asked.has(key)) return false
    asked.add(key)
    return true
  }
}

/**
 * Whether a task page should ask for its issue's state: it links one, the states read
 * so far do not know it, and the page has not asked for it before. The bridge may
 * know nothing of it (an archived or binned task, or one past its cap), so an empty
 * answer must not ask again.
 */
export function shouldAskIssueState(key: string, states: Record<string, unknown>, askOnce: (key: string) => boolean): boolean {
  return Boolean(key) && states[key] === undefined && askOnce(key)
}

/**
 * Cut a trailing "." "," ")" and the like off a URL found in prose: sentence
 * punctuation, and a closing bracket the URL did not open. A balanced one, as in
 * https://en.wikipedia.org/wiki/Foo_(bar), is the URL's own.
 */
export function trimUrl(raw: string): string {
  let url = raw
  for (;;) {
    const last = url.at(-1)
    if (last && /[.,;:!?'"]/.test(last)) { url = url.slice(0, -1); continue }
    const pair = last === ')' ? '(' : last === ']' ? '[' : null
    if (pair && url.split(pair).length - 1 < url.split(last!).length - 1) { url = url.slice(0, -1); continue }
    return url
  }
}
