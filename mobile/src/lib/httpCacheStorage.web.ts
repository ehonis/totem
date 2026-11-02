// The web preview (layouts only) keeps the GET cache in memory: nothing on disk.
import type { CacheStorage } from './httpCache'

export const cacheStorage: CacheStorage = {
  getItemSync: () => null,
  setItemAsync: async () => {},
  removeItemAsync: async () => {},
  clearAsync: async () => {},
}
