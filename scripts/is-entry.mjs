// True when the module at `moduleUrl` is the script node was asked to run.
// Compares real paths: node resolves symlinks in import.meta.url but not in
// process.argv[1], so a script launched through a symlinked checkout would
// otherwise load, decide it was imported, and exit 0 without doing anything.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function isEntry(moduleUrl) {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}
