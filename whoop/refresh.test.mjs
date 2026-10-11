import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// WHOOP voids the old refresh token on every refresh, so two refreshes at once
// means one of them fails. The bridge must share one in-flight refresh.
test('concurrent WHOOP token reads share one refresh', () => {
  const bridge = readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8')
  const start = bridge.indexOf('async function whoopAccessToken(')
  const body = bridge.slice(start, bridge.indexOf('\n}\n', start))
  assert.match(body, /if \(!whoopRefreshing\) whoopRefreshing = refreshWhoopToken\(tokens\)\.finally\(\(\) => \{ whoopRefreshing = null \}\)/)
  assert.match(body, /return whoopRefreshing/)
  // Only the shared refresh may spend the refresh token.
  assert.equal(bridge.match(/grant_type: 'refresh_token',\n\s+refresh_token: tokens\.refresh_token/g)?.length, 1)
})
