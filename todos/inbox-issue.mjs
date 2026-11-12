// Files an accepted `github` inbox proposal as a new issue, through the service
// user's `gh` (`run(args)` resolves to stdout; argv, no shell). It makes no task:
// the GitHub task connector is gone, and an issue that should also be a task gets
// one with an issue link.
//
// `-f` is gh's raw-field flag: the value is sent as a string as is, never read as
// `@file` or a number, so a title or body cannot reach the filesystem.

import { isGithubRepo } from './issue-link.mjs';

/** Throws unless `repo` is a GitHub owner/repo. Called when the proposal is read, before anything is sent. */
export function assertIssueRepo(repo) {
  if (!isGithubRepo(repo)) throw new Error(`github proposal has an invalid repo: ${repo}`);
  return repo;
}

/** The exact `gh` argv that files `{ repo, title, labels, body }`. */
export function issueCreateArgs({ repo, title, labels = [], body }) {
  assertIssueRepo(repo);
  const args = ['api', '-X', 'POST', `repos/${repo}/issues`, '-f', `title=${title}`, '-f', `body=${body}`];
  for (const label of labels) args.push('-f', `labels[]=${label}`);
  return args;
}

export function createIssueFiler({ run }) {
  if (typeof run !== 'function') throw new TypeError('createIssueFiler requires run()');
  return {
    async file(issue) {
      const created = JSON.parse(await run(issueCreateArgs(issue)));
      return { url: typeof created?.html_url === 'string' ? created.html_url : null, number: created?.number ?? null };
    },
  };
}
