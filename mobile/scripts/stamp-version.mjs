// Writes the running checkout's version into src/lib/buildVersion.ts for the update about to be
// published (.github/workflows/deploy.yml). It needs the full history (a shallow clone gets no
// count). A JS file is not part of the runtime fingerprint, so stamping never forces a native build.
import { writeFileSync } from 'node:fs'
import { buildVersion } from '../../web/build-version.mjs'

const root = new URL('../..', import.meta.url).pathname
const v = buildVersion(root)
const file = new URL('../src/lib/buildVersion.ts', import.meta.url)
writeFileSync(file, `// Stamped by scripts/stamp-version.mjs for this update.\nexport const BUILD_VERSION: { version: string; date: string; commit: string } = ${JSON.stringify(v)}\n`)
console.log(`Stamped ${v.version} · ${v.date}${v.commit ? ` · ${v.commit}` : ''}`)
