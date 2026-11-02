// The app opens a notification's link itself (mobile/src/features/notifications/
// destination.ts, then mobile/src/shell/nav.ts). Each keeps its own copy of the web's
// productivity apps, so a new app missing from either lands the push on the
// Productivity landing page instead of the app. These modules are plain TypeScript
// with no imports, which node loads directly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { notificationDestination } from '../mobile/src/features/notifications/destination.ts';
import { PRODUCTIVITY_APPS } from '../web/src/router.ts';

const ROOT = join(import.meta.dirname, '..');

test('a rec.review push opens Recs in the app', () => {
  assert.deepEqual(notificationDestination('/productivity/recs'), { kind: 'productivity', app: 'recs' });
});

test('the app knows every productivity app the web routes to', () => {
  for (const app of PRODUCTIVITY_APPS) {
    assert.deepEqual(notificationDestination(`/productivity/${app}`), { kind: 'productivity', app }, app);
  }
  const nav = readFileSync(join(ROOT, 'mobile/src/shell/nav.ts'), 'utf8');
  const listed = /export const PRODUCTIVITY_APPS = \[([^\]]*)\]/.exec(nav)?.[1].match(/'([a-z]+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual([...listed].sort(), [...PRODUCTIVITY_APPS].sort());
});
