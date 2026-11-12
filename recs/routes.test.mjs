// The app opens a notification's link itself (mobile/src/features/notifications/
// destination.ts, then mobile/src/shell/routes.ts). Each keeps its own copy of the web's
// productivity apps, so a new app missing from either lands the push on the
// Productivity landing page instead of the app. These modules are plain TypeScript
// with no imports, which node loads directly.
import assert from 'node:assert/strict';
import test from 'node:test';

import { notificationDestination } from '../mobile/src/features/notifications/destination.ts';
import { PRODUCTIVITY_APPS as APP_TOOLS, productivityPath } from '../mobile/src/shell/routes.ts';
import { PRODUCTIVITY_APPS } from '../web/src/router.ts';

test('the app knows every productivity app the web routes to', () => {
  for (const app of PRODUCTIVITY_APPS) {
    assert.deepEqual(notificationDestination(`/productivity/${app}`), { kind: 'productivity', app }, app);
  }
  // Each is its own page in the app (#177); one it doesn't list would open the hub instead.
  assert.deepEqual([...APP_TOOLS].sort(), [...PRODUCTIVITY_APPS].sort());
  for (const app of PRODUCTIVITY_APPS) assert.equal(productivityPath(app), `/productivity/${app}`, app);
});
