// app.json holds the app; this adds the install's own identity from app.local.json,
// which is gitignored: the bundle id and the EAS project the builds and updates
// belong to. Without it the app still runs in a dev client, but cannot build or
// receive updates. See app.local.example.json.
const fs = require('node:fs')
const path = require('node:path')

function local() {
  const file = path.join(__dirname, 'app.local.json')
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
}

module.exports = ({ config }) => {
  const { bundleIdentifier, easProjectId } = local()
  return {
    ...config,
    ios: { ...config.ios, ...(bundleIdentifier && { bundleIdentifier }) },
    android: { ...config.android, ...(bundleIdentifier && { package: bundleIdentifier }) },
    ...(easProjectId && {
      extra: { ...config.extra, eas: { projectId: easProjectId } },
      updates: { ...config.updates, url: `https://u.expo.dev/${easProjectId}` },
    }),
  }
}
