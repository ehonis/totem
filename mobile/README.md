# Totem for iPhone

The native app for [Totem](../README.md), a self-hosted personal assistant. It
is the web dashboard's phone layout rebuilt in React Native (Expo SDK 57): the same screens, with a
sidebar you can swipe open, page-sheet detail views, system menus, swipe actions and haptics.

## Run

Copy `app.local.example.json` to `app.local.json` and fill in your own bundle id and EAS project id
(`npx eas-cli init` creates a project). It is gitignored; `app.config.js` reads it.

```bash
cd mobile
npm install
npm run start:tailscale   # Metro on this machine's Tailscale IP
```

Open it in the Totem development build (Expo Go cannot load its native modules). On first launch, enter:

- **Server**: the machine running Totem, e.g. `100.64.0.10` (port 8787 is assumed) or `https://totem.example.com`
- **Bridge secret**: `BRIDGE_SECRET` from that server's `.env`

The secret is stored in the iOS keychain.

## Build

```bash
npx eas-cli build -p ios --profile development              # dev client
npx eas-cli build -p ios --profile production --auto-submit # TestFlight
npx eas-cli update --channel production -m "message"        # JS-only update to installed builds
```

See `AGENTS.md` for how the code is laid out and the rules for changing it.
