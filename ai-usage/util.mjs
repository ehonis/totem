import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Read a JSON file, returning null when it is missing or unparseable. */
export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write JSON to `path` atomically, preserving 0600 permissions.
 *
 * Credential files are written via a temp file in the same directory plus a
 * rename so a crash mid-write can never leave a half-written token behind.
 */
export async function writeJsonAtomic(path, value) {
  const tmp = join(dirname(path), `.${Date.now()}.${process.pid}.tmp`);
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/** Parse an ISO string or unix epoch (seconds or ms) into epoch ms. */
export function toEpochMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Anything below ~year 2286 in ms is really a seconds-based timestamp.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

/** Clamp a percentage into 0..100, or null if it isn't a usable number. */
export function pct(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // Round to 1dp: Cursor reports raw ratios like 37.56666666666666.
  return Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;
}

/** Build a meter from a "used percent" reading. The UI renders headroom. */
export function meter(key, label, usedPct, resetsAt, extra = {}) {
  const used = pct(usedPct);
  return {
    key,
    label,
    usedPct: used,
    remainingPct: used === null ? null : Math.round((100 - used) * 10) / 10,
    resetsAt: toEpochMs(resetsAt),
    ...extra,
  };
}

/** Human label for a rate-limit window given its length in minutes. */
export function windowLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'limit';
  if (minutes % 10080 === 0) {
    const weeks = minutes / 10080;
    return weeks === 1 ? '7-day limit' : `${weeks * 7}-day limit`;
  }
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days}-day limit`;
  }
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}

/** fetch() with a hard timeout so one hung backend can't stall a poll cycle. */
export async function fetchJson(url, { headers = {}, method = 'GET', body, timeoutMs = 20000 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, { method, headers, body, signal });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body — surfaced via the error path below */
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.body = json ?? text.slice(0, 500);
    throw err;
  }
  if (json === null) {
    const err = new Error('Response was not JSON');
    err.body = text.slice(0, 500);
    throw err;
  }
  return json;
}

/** Expand a leading `~` to the current user's home directory. */
export function expandHome(p) {
  if (p.startsWith('~/') || p === '~') {
    return join(process.env.HOME ?? '', p.slice(1));
  }
  return p;
}
