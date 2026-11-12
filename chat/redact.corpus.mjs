// The token shapes redact.test.mjs and web/src/chat/about/redact.test.ts both run.
// Each is built at runtime from pieces, so no literal in the repository looks like
// a credential to a secret scanner.

export const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const UPPER_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const fill = (n, seed, set = ALNUM) => Array.from({ length: n }, (_, i) => set[(i * 7 + seed * 13) % set.length]).join('')
export const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
export const pem = (kind) => ['-----BEGIN', kind, 'KEY-----'].join(' ')
export const pemEnd = (kind) => ['-----END', kind, 'KEY-----'].join(' ')

// [what it is, the text, the parts of it that must not survive]
export function shapes() {
  const pw = fill(14, 6)
  const jwt = [b64url({ alg: 'HS256', typ: 'JWT' }), b64url({ sub: 'u1', exp: 1 }), fill(43, 2)]
  const keyBody = [fill(64, 20), fill(64, 21), fill(30, 22)]
  return [
    ['google key', ['AI', 'za'].join('') + fill(35, 1), [fill(35, 1)]],
    ['jwt', jwt.join('.'), jwt],
    ['slack token', ['xo', 'xb'].join('') + '-' + fill(11, 3) + '-' + fill(24, 4), [fill(24, 4)]],
    ['oauth code', `https://example.test/cb?state=ok&code=${fill(30, 5)}`, [fill(30, 5)]],
    ['url userinfo', `https://bob:${pw}@example.test/repo.git`, [pw, 'bob:']],
    ['json token', `{"access${'Token'}":"${fill(30, 7)}"}`, [fill(30, 7)]],
    ['github token', ['gh', 'p_'].join('') + fill(36, 8), [fill(36, 8)]],
    ['api key', ['s', 'k-'].join('') + fill(40, 9), [fill(40, 9)]],
    ['bearer', `Authorization: Bearer ${fill(30, 10)}`, [fill(30, 10)]],
    ['env pair', `OPENAI_API_KEY=${fill(20, 11)}`, [fill(20, 11)]],
    ['aws key id', `key ${['AK', 'IA'].join('')}${fill(16, 12, UPPER_DIGITS)}`, [fill(16, 12, UPPER_DIGITS)]],
    ['private key', [pem('PRIVATE'), ...keyBody, pemEnd('PRIVATE')].join('\n'), keyBody],
    ['private key cut short', [pem('OPENSSH PRIVATE'), keyBody[0]].join('\n'), [keyBody[0]]],
    ['unlabelled secret', `the secret is ${fill(40, 13)}/${fill(8, 14)}`, [fill(40, 13)]],
    ['basic, all letters', `Authorization: Basic ${Buffer.from('A'.repeat(12)).toString('base64')}`, [Buffer.from('A'.repeat(12)).toString('base64')]],
    ['basic, base64', `curl -H "Basic ${Buffer.from(`bob:${pw}`).toString('base64')}"`, [Buffer.from(`bob:${pw}`).toString('base64')]],
    ['query token', `https://example.test/?token=${fill(6, 15)}%26${fill(6, 16)}`, [fill(6, 15), fill(6, 16)]],
    ['query api_key', `https://example.test/?q=1&api_key=${fill(24, 17)}`, [fill(24, 17)]],
    ['signed url', `https://bucket.example.test/f.pdf?X-Amz-Date=1&X-Amz-Signature=${fill(32, 19)}`, [fill(32, 19)]],
    ['password param', `login with password=${fill(12, 18)} today`, [fill(12, 18)]],
  ]
}

// Text that only looks like the start of a secret, and must come back unchanged.
export const ORDINARY = [
  'Basic training on Monday',
  'Basic Understanding of the API',
  'Bearer of bad news',
  '{"author": "Ann"}',
  'Token rotation is next week',
  'https://example.test/docs?page=2&monkey=banana&keyboard=us',
  'state=open, exit code=1',
  'MONKEY=banana',
  `commit ${'0123456789abcdef'.repeat(3).slice(0, 40)} on main`,
  'id 550e8400-e29b-41d4-a716-446655440000 on 2026-10-30T09:05:00Z',
  'web/src/chat/about/context.ts and mobile/src/features/productivity/HabitsView.tsx',
  'https://github.com/o/r/actions/runs/41064678955/job/124092872671',
  'SomeVeryLongComponentNameForTheV2Implementation',
]
