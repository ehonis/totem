// Secure random bytes. Hermes has no crypto.getRandomValues, so this reads
// SQLite's randomblob(), which draws from the OS's CSPRNG; expo-sqlite is
// already in the app. (secureRandom.web.ts uses the browser's crypto.)
import { openDatabaseSync } from 'expo-sqlite'

let db: ReturnType<typeof openDatabaseSync> | null = null

export function secureRandom(out: Uint8Array, n: number) {
  db ??= openDatabaseSync(':memory:')
  const hex = db.getFirstSync<{ r: string }>(`SELECT hex(randomblob(${n})) AS r`)?.r || ''
  if (hex.length !== n * 2) throw new Error('No secure random source')
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
}
