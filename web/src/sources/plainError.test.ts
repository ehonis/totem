import { describe, expect, it } from 'vitest'
import { plainError } from './plainError'

describe('plainError', () => {
  it('names the common failures in plain words', () => {
    expect(plainError("ENOENT: no such file or directory, open '/home/x/secrets/google-calendar-oauth-client.json'")).toBe('A file it needs is missing on the server.')
    expect(plainError('token refresh HTTP 400: invalid_grant')).toMatch(/sign-in has expired/)
    expect(plainError('HTTP 429 Too Many Requests')).toMatch(/rate limiting/)
    expect(plainError('getaddrinfo ENOTFOUND api.example.com')).toBe('Totem could not reach it.')
    expect(plainError("EACCES: permission denied, open '/srv/secrets/client.json'")).toMatch(/not allowed to read a file/)
    expect(plainError('HTTP 401 Unauthorized')).toBe('It refused Totem’s credentials.')
    expect(plainError('HTTP 503 Service Unavailable')).toBe('It is having trouble on its side.')
    // A number or a word that only looks like an outage is passed through as written.
    expect(plainError('Sheet row 512 not found')).toBe('Sheet row 512 not found')
    expect(plainError('network name mismatch')).toBe('network name mismatch')
  })

  it('keeps an unknown error to its first sentence, without paths', () => {
    expect(plainError('Something odd at /a/b/c.json happened. More detail here.')).toBe('Something odd at … happened.')
    expect(plainError('x'.repeat(300))).toHaveLength(118)
    expect(plainError('')).toBe('')
  })
})
