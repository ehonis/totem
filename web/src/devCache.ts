// The Dev tab's last answers, kept in localStorage so the tab paints at once and
// asks GitHub behind what is already on screen. Only for paint: the server is
// still the source of truth and every open fetches fresh.

const PREFIX = 'dev_cache_v1:'

export function readDevCache<T>(key: string): T | null {
  try { return JSON.parse(localStorage.getItem(PREFIX + key) || 'null') } catch { return null }
}

export function writeDevCache(key: string, value: unknown) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)) } catch {}
}
