// Run with: node --test todos/inbox-issue.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertIssueRepo, createIssueFiler, issueCreateArgs } from './inbox-issue.mjs';

test('files an issue with exactly these gh arguments, every field raw', async () => {
  const calls = [];
  const filer = createIssueFiler({ run: async (args) => { calls.push(args); return JSON.stringify({ html_url: 'https://github.com/acme/acme/issues/9', number: 9 }); } });
  const filed = await filer.file({ repo: 'acme/acme.js', title: '@/etc/passwd', labels: ['bug', 'needs triage'], body: 'Body\n---\nmore' });
  assert.deepEqual(filed, { url: 'https://github.com/acme/acme/issues/9', number: 9 });
  assert.deepEqual(calls, [[
    'api', '-X', 'POST', 'repos/acme/acme.js/issues',
    '-f', 'title=@/etc/passwd', '-f', 'body=Body\n---\nmore',
    '-f', 'labels[]=bug', '-f', 'labels[]=needs triage',
  ]]);
});

test('refuses a repo that is not owner/repo before running anything', async () => {
  let ran = false;
  const filer = createIssueFiler({ run: async () => { ran = true; return '{}'; } });
  for (const repo of ['acme', 'acme/', 'acme/acme/issues', '../acme', 'acme/..', 'acme-/repo', '-acme/repo', 'acme/re po', '', undefined]) {
    assert.throws(() => assertIssueRepo(repo), /invalid repo/, String(repo));
    await assert.rejects(filer.file({ repo, title: 't', labels: [], body: 'b' }), /invalid repo/, String(repo));
  }
  assert.equal(ran, false);
  assert.equal(issueCreateArgs({ repo: 'a-b/c_d.e', title: 't', body: 'b' })[3], 'repos/a-b/c_d.e/issues');
});
