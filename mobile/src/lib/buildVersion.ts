// The version the drawer shows beside TOTEM, as the web rail shows it: `<major>.<minor>.<commits on
// main>` and that merge's date (web/build-version.mjs). This copy is the unstamped one a dev client
// runs; the deploy overwrites it with scripts/stamp-version.mjs just before `eas update`, so a phone
// on the latest update shows the merge that published it.
export const BUILD_VERSION: { version: string; date: string; commit: string } = { version: '', date: '', commit: '' }
