// Where the GET cache (httpCache.ts) keeps its bodies: its own SQLite file, apart
// from the localStorage one, so clearing it on sign-out touches nothing else.
import { SQLiteStorage } from 'expo-sqlite/kv-store'
import type { CacheStorage } from './httpCache'

export const cacheStorage: CacheStorage = new SQLiteStorage('totem-http-cache.db')
